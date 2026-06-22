import { Hono, type Context } from 'hono'
import type { AppConfig } from './config'
import { ChatEdgeClient } from './chat/client'
import { EventDeduper, chatDedupKey } from './chat/dedup'
import { collectThreadHistory, isThreadReply, normalizeChatEnvelope } from './chat/normalize'
import { verifyChatRequest } from './chat/verify'
import type { GoogleChatEnvelope, NormalizedChatEvent } from './chat/types'
import { logError, logWarn } from './logging'
import { incr, renderMetrics } from './metrics'
import { extractMessageOverrides } from './overrides'
import {
  FEEDBACK_FUNCTION,
  INITIAL_STATUS,
  consumeRenderStream,
  createRenderState,
  finalizeRender
} from './renderer'
import {
  appendSessionMessages,
  createSession,
  executeSession,
  openSessionEventStream,
  turnMessagesFromEvent
} from './session-api'

type Variables = Record<string, never>

type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void }

/** Bounded re-opens of a dropped SSE stream before we give up and deliver. */
const MAX_RESUME_ATTEMPTS = 3

const WELCOME_TEXT =
  'Hi, Centaur at your service! I can help with software engineering tasks. ' +
  'Mention me in a thread to get started.'

export type Googlechatbot = {
  app: Hono<{ Variables: Variables }>
  client: ChatEdgeClient
}

export function createGooglechatbot(config: AppConfig): Googlechatbot {
  const client = new ChatEdgeClient(config)
  const deduper = new EventDeduper(config.CHAT_EVENT_DEDUP_TTL_MS)

  const app = new Hono<{ Variables: Variables }>()

  app.get('/health', c =>
    c.json({ ok: true, service: 'googlechatbot', commit: process.env.COMMIT_SHA ?? 'local' })
  )
  app.get('/health/ready', c => c.redirect('/health'))
  app.get('/metrics', c => c.text(renderMetrics(), 200, { 'content-type': 'text/plain; version=0.0.4' }))

  const chatEventsHandler = async (c: Context<{ Variables: Variables }>) => {
    // Google Chat is strict about the sync HTTP response shape. To silently
    // acknowledge an event (and respond later via the Chat REST API), the bot
    // MUST return `{}` with Content-Type: application/json. Anything else — an
    // empty body, text/plain, a non-Message JSON shape like `{"ok": true}`, or
    // HTTP 204 — surfaces as a "<bot> not responding" placeholder card.
    // https://developers.google.com/workspace/chat/receive-respond-interactions
    const body = await c.req.raw.text()

    // A 👍/👎 click on a past answer arrives as CARD_CLICKED. Record it and ack;
    // it never starts an agent run.
    const feedback = parseFeedbackClick(body)
    if (feedback) {
      incr('googlechatbot_feedback_total', { rating: feedback })
      return c.json({})
    }

    const envelope = parseChatBody(body)
    if (!envelope) return c.json({}, 400)

    const verification = verifyChatRequest({ config, envelope })
    if (!verification.ok) {
      incr('googlechatbot_events_total', { outcome: 'rejected' })
      logWarn('googlechatbot_event_rejected', { reason: verification.reason })
      return c.json({}, verification.status)
    }

    const key = chatDedupKey({
      eventTime: envelope.eventTime,
      spaceName: envelope.space?.name,
      messageName: envelope.message?.name
    })
    if (!deduper.checkAndRemember(key)) {
      incr('googlechatbot_events_total', { outcome: 'duplicate' })
      logWarn('googlechatbot_duplicate_event_skipped', { dedupe_key: key })
      return c.json({})
    }

    incr('googlechatbot_events_total', { outcome: 'accepted' })
    runInBackground(c, processChatEvent(config, client, envelope))
    return c.json({})
  }

  app.post(config.CHAT_EVENTS_PATH, chatEventsHandler)
  if (config.CHAT_EVENTS_PATH !== '/api/chat/events') {
    app.post('/api/chat/events', chatEventsHandler)
  }

  return { app, client }
}

function botResourceName(config: AppConfig): string | undefined {
  if (!config.GOOGLE_SERVICE_ACCOUNT_JSON) return undefined
  try {
    const parsed = JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email?: string }
    return parsed.client_email ? `users/${parsed.client_email}` : undefined
  } catch {
    return undefined
  }
}

async function processChatEvent(
  config: AppConfig,
  client: ChatEdgeClient,
  envelope: GoogleChatEnvelope
): Promise<void> {
  const botUser = botResourceName(config)
  const normalized = await normalizeChatEnvelope(envelope, botUser)
  if (!normalized) return

  if (envelope.type === 'ADDED_TO_SPACE') {
    try {
      await client.createMessage(normalized.space_name, { text: WELCOME_TEXT })
    } catch (error) {
      logError('googlechatbot_welcome_message_failed', error)
    }
    return
  }

  // Only @mentions (or DMs/slash commands, which normalize.ts flags as mentions)
  // start a run — unless follow-up mode is enabled, where a plain reply inside an
  // existing thread continues the conversation without a re-@mention.
  const followUp = config.GOOGLECHATBOT_FOLLOW_UP_THREADS && isThreadReply(normalized)
  if (!normalized.is_mention && !followUp) return

  // Post the "_Centaur is thinking…_" ack IMMEDIATELY, before touching api-rs.
  // Google Chat shows a "<bot> not responding" placeholder if no bot message
  // appears within ~5s, and spinning up a sandbox takes longer than that. The
  // ack seeds the message we later PATCH with the answer. The thread-history
  // fetch runs in parallel — neither depends on the other.
  const ackPromise = client
    .createMessage(
      normalized.space_name,
      { text: INITIAL_STATUS },
      { threadName: normalized.chat.thread_name }
    )
    .then(ack => ack.name ?? '')
    .catch(error => {
      logError('googlechatbot_ack_create_failed', error)
      return ''
    })

  const historyPromise = collectThreadHistory(client, {
    spaceName: normalized.space_name,
    threadName: normalized.chat.thread_name,
    currentMessageName: normalized.message_id,
    botUserName: botUser
  }).catch(error => {
    logWarn('googlechatbot_thread_history_failed', error)
    return [] as NonNullable<NormalizedChatEvent['history_messages']>
  })

  const [ackMessageName, historyMessages] = await Promise.all([ackPromise, historyPromise])
  if (historyMessages.length) normalized.history_messages = historyMessages

  await driveSession(config, client, normalized, ackMessageName)
}

async function driveSession(
  config: AppConfig,
  client: ChatEdgeClient,
  event: NormalizedChatEvent,
  ackMessageName: string
): Promise<void> {
  const threadKey = event.thread_key
  const { execute, history } = turnMessagesFromEvent(event)
  // Inline directives (--model, -rsn, --bedrock, --claude, ...) are stripped from
  // the prompt and applied to the harness/turn, matching the Slack integration.
  const overrides = extractMessageOverrides(execute.text)
  execute.text = overrides.cleanedText
  incr('googlechatbot_runs_total', { outcome: 'started' })
  try {
    await createSession(config, threadKey, conversationName(event), overrides.harnessType)
    await appendSessionMessages(config, threadKey, history)
    const execution = await executeSession(config, threadKey, execute, {
      idleTimeoutMs: config.SESSION_IDLE_TIMEOUT_MS,
      maxDurationMs: config.SESSION_MAX_DURATION_MS,
      overrides: {
        model: overrides.model,
        provider: overrides.provider,
        reasoning: overrides.reasoning
      }
    })
    const target = {
      spaceName: event.space_name,
      ackMessageName,
      threadName: event.chat.thread_name,
      sessionUrl: sessionUrl(config, threadKey, execution.execution_id)
    }

    // Resume-on-drop: a dropped SSE connection leaves the answer half-written.
    // Re-open from the last event id (api-rs replays only newer events) and keep
    // accumulating into the same render state, so the final answer is delivered
    // even if the stream breaks mid-run. Bounded to avoid spinning forever.
    const state = createRenderState()
    let lastEventId = 0
    for (let attempt = 0; attempt < MAX_RESUME_ATTEMPTS && !state.terminal; attempt += 1) {
      const stream = await openSessionEventStream(
        config,
        threadKey,
        lastEventId,
        execution.execution_id,
        id => {
          if (id > lastEventId) lastEventId = id
        }
      )
      await consumeRenderStream(client, stream, target, state)
      if (!state.terminal && attempt + 1 < MAX_RESUME_ATTEMPTS) {
        incr('googlechatbot_render_resumes_total')
        logWarn('googlechatbot_render_stream_resuming', {
          thread_key: threadKey,
          after_event_id: lastEventId,
          attempt: attempt + 1
        })
      }
    }
    await finalizeRender(client, target, state)
    incr('googlechatbot_runs_total', { outcome: state.error ? 'failed' : 'completed' })
  } catch (error) {
    incr('googlechatbot_runs_total', { outcome: 'failed' })
    logError('googlechatbot_session_drive_failed', error)
    await deliverDriveError(client, event, ackMessageName, error)
  }
}

async function deliverDriveError(
  client: ChatEdgeClient,
  event: NormalizedChatEvent,
  ackMessageName: string,
  error: unknown
): Promise<void> {
  const text = `⚠️ Centaur could not start this run: ${
    error instanceof Error ? error.message : String(error)
  }`
  try {
    if (ackMessageName) {
      await client.updateMessage(ackMessageName, { text, cardsV2: [] })
      return
    }
    await client.createMessage(event.space_name, { text }, { threadName: event.chat.thread_name })
  } catch (deliverError) {
    logError('googlechatbot_drive_error_delivery_failed', deliverError)
  }
}

/** Build the "View session" deep link from the configured template, if any. */
function sessionUrl(
  config: AppConfig,
  threadKey: string,
  executionId: string | undefined
): string | undefined {
  const template = config.GOOGLECHATBOT_SESSION_URL_TEMPLATE
  if (!template) return undefined
  return template
    .replace('{thread}', encodeURIComponent(threadKey))
    .replace('{execution}', encodeURIComponent(executionId ?? ''))
}

/** Human-readable conversation name for the api-rs session principal. */
function conversationName(event: NormalizedChatEvent): string | undefined {
  if (event.space_type === 'DIRECT_MESSAGE') return event.user_name || undefined
  return undefined
}

function runInBackground(c: Context, promise: Promise<void>): void {
  const guarded = promise.catch((error: unknown) => {
    logError('googlechatbot_event_processing_failed', error)
  })
  const executionCtx = getExecutionContext(c)
  if (executionCtx) {
    executionCtx.waitUntil(guarded)
    return
  }
  void guarded
}

function getExecutionContext(c: Context): WaitUntilContext | null {
  try {
    return c.executionCtx
  } catch {
    return null
  }
}

/**
 * Detect a feedback button click and extract its rating. Works across the v1
 * (`action.actionMethodName` + parameters) and v2 (`commonEventObject`) payload
 * shapes by keying off our own function name and scanning for the rating value,
 * so a Chat payload-format change can't silently drop feedback.
 */
export function parseFeedbackClick(rawBody: string): 'up' | 'down' | 'unknown' | null {
  if (!rawBody.includes(FEEDBACK_FUNCTION)) return null
  const match = /"(?:rating|value)"\s*:\s*"?(up|down)"?/i.exec(rawBody)
  return match ? (match[1]!.toLowerCase() as 'up' | 'down') : 'unknown'
}

export function parseChatBody(rawBody: string): GoogleChatEnvelope | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return null
  }

  // Google Workspace Add-ons (v2) envelopes nest the v1 fields under `chat`,
  // split into typed payload buckets. Unwrap into the v1 shape normalize.ts
  // consumes. Apps created via the new Chat API "Configuration" UI default to v2.
  const chat = (parsed as { chat?: Record<string, unknown> }).chat
  if (chat && typeof chat === 'object') {
    const eventTime = chat.eventTime as string | undefined
    const user = chat.user as Record<string, unknown> | undefined
    const messagePayload = chat.messagePayload as { space?: unknown; message?: unknown } | undefined
    if (messagePayload) {
      return {
        type: 'MESSAGE',
        eventTime,
        user,
        space: messagePayload.space,
        message: messagePayload.message
      } as unknown as GoogleChatEnvelope
    }
    const addedToSpacePayload = chat.addedToSpacePayload as { space?: unknown } | undefined
    if (addedToSpacePayload) {
      return {
        type: 'ADDED_TO_SPACE',
        eventTime,
        user,
        space: addedToSpacePayload.space
      } as unknown as GoogleChatEnvelope
    }
    const removedFromSpacePayload = chat.removedFromSpacePayload as { space?: unknown } | undefined
    if (removedFromSpacePayload) {
      return {
        type: 'REMOVED_FROM_SPACE',
        eventTime,
        user,
        space: removedFromSpacePayload.space
      } as unknown as GoogleChatEnvelope
    }
    // appCommandPayload / buttonClickedPayload / submitFormPayload are
    // deliberately dropped, matching the v1 normalize.ts policy.
    return null
  }

  // v1 (legacy Chat API) envelope — pass through unchanged.
  return parsed as unknown as GoogleChatEnvelope
}
