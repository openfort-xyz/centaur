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
import { buildConsoleSessionWidget, defaultModelForHarness } from './console-session-link'
import { chatReplyLimits } from './constants'

/** Clamp to Google Chat's plain `text` cap so an oversized body can't 400 the send. */
function clampPlainText(text: string): string {
  const max = chatReplyLimits.message.maxPlainTextChars
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
import {
  INITIAL_STATUS,
  consumeRenderStream,
  createRenderState,
  finalizeRender
} from './renderer'
import {
  type GoogleChatTurnMessage,
  appendSessionMessages,
  classifyExecuteConflict,
  createSession,
  executeSession,
  openSessionEventStream,
  turnMessagesFromEvent
} from './session-api'

type Variables = Record<string, never>

type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void }

/** Bounded re-opens of a dropped SSE stream before we give up and deliver. */
const MAX_RESUME_ATTEMPTS = 3

// Outbound upload ceiling — matches slackbotv2's inline file cap; the Chat API
// itself accepts up to 200MB per attachment.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

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

  // Outbound message API used by the `google-chat` workflow tool so scheduled
  // digest workflows can post/list/edit/delete Chat messages. A thin relay to
  // the Chat REST client — the caller (the overlay _openfort_chat helper) has
  // already rendered the text for the plain `text` field, so we pass it through.
  const requireOutboundAuth = (c: Context<{ Variables: Variables }>): Response | null => {
    if (!config.CHATBOT_API_KEY) return c.json({ error: 'CHATBOT_API_KEY not configured' }, 503)
    const provided = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (provided !== config.CHATBOT_API_KEY) return c.json({ error: 'unauthorized' }, 401)
    return null
  }

  app.post('/api/chat/messages', async c => {
    const denied = requireOutboundAuth(c)
    if (denied) return denied
    const body = (await c.req.json().catch(() => null)) as {
      space_name?: string
      text?: string
      thread_name?: string
    } | null
    if (!body?.space_name || typeof body.text !== 'string') {
      return c.json({ error: 'space_name and text are required' }, 400)
    }
    try {
      const sent = await client.createMessage(
        body.space_name,
        { text: body.text },
        body.thread_name ? { threadName: body.thread_name } : {}
      )
      return c.json(sent)
    } catch (error) {
      logError('googlechatbot_outbound_send_failed', error)
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  app.get('/api/chat/messages', async c => {
    const denied = requireOutboundAuth(c)
    if (denied) return denied
    const spaceName = c.req.query('space_name')
    if (!spaceName) return c.json({ error: 'space_name is required' }, 400)
    const pageSize = Number(c.req.query('page_size') ?? '20') || 20
    // `impersonate` (a requester email) lets reads fall back to DWD user auth so
    // DM history is readable — app auth cannot read DMs. `filter` scopes to a
    // single thread (thread.name = "..."), matching thread-history collection.
    const impersonate = c.req.query('impersonate')
    const filter = c.req.query('filter')
    try {
      return c.json(
        await client.listMessages(spaceName, {
          pageSize,
          ...(filter ? { filter } : {}),
          ...(impersonate ? { impersonateSubject: impersonate } : {})
        })
      )
    } catch (error) {
      logError('googlechatbot_outbound_list_failed', error)
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  app.patch('/api/chat/messages', async c => {
    const denied = requireOutboundAuth(c)
    if (denied) return denied
    const body = (await c.req.json().catch(() => null)) as {
      message_name?: string
      text?: string
    } | null
    if (!body?.message_name || typeof body.text !== 'string') {
      return c.json({ error: 'message_name and text are required' }, 400)
    }
    try {
      return c.json(await client.updateMessage(body.message_name, { text: body.text }))
    } catch (error) {
      logError('googlechatbot_outbound_update_failed', error)
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  app.delete('/api/chat/messages', async c => {
    const denied = requireOutboundAuth(c)
    if (denied) return denied
    const body = (await c.req.json().catch(() => null)) as { message_name?: string } | null
    if (!body?.message_name) return c.json({ error: 'message_name is required' }, 400)
    try {
      await client.deleteMessage(body.message_name)
      return c.json({ ok: true })
    } catch (error) {
      logError('googlechatbot_outbound_delete_failed', error)
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  // Upload a file into a space (optionally threaded, with a caption). This is
  // how agent tooling delivers files to the thread — the Slack analogue is the
  // `slack upload` CLI hitting Slack directly; here the credential (a DWD
  // user impersonation, see GOOGLECHATBOT_UPLOAD_USER) stays in the bot.
  app.post('/api/chat/attachments', async c => {
    const denied = requireOutboundAuth(c)
    if (denied) return denied
    if (!client.canUploadAttachments()) {
      return c.json(
        {
          error:
            'attachment uploads are not configured: set GOOGLECHATBOT_UPLOAD_USER '
            + 'and grant the service account domain-wide delegation for the '
            + 'chat.messages.create scope'
        },
        503
      )
    }
    const body = (await c.req.json().catch(() => null)) as {
      space_name?: string
      filename?: string
      content_base64?: string
      mime_type?: string
      text?: string
      thread_name?: string
    } | null
    if (!body?.space_name || !body.filename || !body.content_base64) {
      return c.json({ error: 'space_name, filename and content_base64 are required' }, 400)
    }
    // Buffer.from(x, 'base64') never throws — it silently drops invalid chars,
    // so a malformed payload would upload a truncated file with a 200. Validate
    // explicitly (whitespace tolerated) so bad input fails as a clean 400.
    const b64 = body.content_base64.replace(/\s+/g, '')
    if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
      return c.json({ error: 'content_base64 is not valid base64' }, 400)
    }
    const data = Uint8Array.from(Buffer.from(b64, 'base64'))
    if (data.byteLength === 0) return c.json({ error: 'content_base64 decoded to zero bytes' }, 400)
    // Same 100MB ceiling slackbotv2 applies to inline file content; the Chat
    // API itself allows up to 200MB per attachment.
    if (data.byteLength > MAX_UPLOAD_BYTES) {
      return c.json({ error: `attachment exceeds the ${MAX_UPLOAD_BYTES} byte limit` }, 413)
    }
    try {
      const uploaded = await client.uploadAttachment(
        body.space_name,
        body.filename,
        body.mime_type ?? 'application/octet-stream',
        data
      )
      const sent = await client.createAttachmentMessage(body.space_name, uploaded, {
        ...(body.text ? { text: body.text } : {}),
        ...(body.thread_name ? { threadName: body.thread_name } : {})
      })
      return c.json(sent)
    } catch (error) {
      logError('googlechatbot_outbound_upload_failed', error)
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

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
  const normalized = await normalizeChatEnvelope(envelope, botUser, client)
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

  // Post the "_Condor is thinking…_" ack IMMEDIATELY, before touching api-rs.
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
    botUserName: botUser,
    ...(normalized.user_email ? { requesterEmail: normalized.user_email } : {})
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
    const session = await createSession(
      config,
      threadKey,
      conversationName(event),
      overrides.harnessType ?? config.GOOGLECHATBOT_DEFAULT_HARNESS,
      {
        userId: event.user_id,
        userName: event.user_name,
        ...(event.user_email ? { userEmail: event.user_email } : {})
      }
    )

    // A run is already in flight for this thread. Starting a second one would
    // collide with api-rs's "one active execution per thread" index and 500,
    // so mirror the Slack bot: fold the new message into the running turn by
    // appending it (the live execution will pick it up) and let that run own
    // the answer. The redundant "thinking…" ack is removed so the thread isn't
    // left with a stranded placeholder.
    if (session.activeExecution) {
      await appendSessionMessages(config, threadKey, [...history, execute])
      await removeAck(client, ackMessageName)
      incr('googlechatbot_runs_total', { outcome: 'folded' })
      logWarn('googlechatbot_folded_into_active_run', {
        thread_key: threadKey,
        message_id: execute.id
      })
      return
    }

    await appendSessionMessages(config, threadKey, history)
    let execution
    try {
      execution = await executeSession(config, threadKey, execute, {
        idleTimeoutMs: config.SESSION_IDLE_TIMEOUT_MS,
        maxDurationMs: config.SESSION_MAX_DURATION_MS,
        overrides: {
          model: overrides.model,
          provider: overrides.provider,
          reasoning: overrides.reasoning
        }
      })
    } catch (error) {
      // The activeExecution check above is read-then-act: a run that starts
      // between the check and this execute makes api-rs reject the second
      // execute on its one-active-execution index (409 once api-rs types the
      // conflict; an opaque 500 on older servers). Re-check and fold into the
      // live run instead of erroring into the thread.
      const folded = await foldIntoActiveRun(config, client, threadKey, execute, ackMessageName, error, {
        conversationName: conversationName(event),
        harnessType: overrides.harnessType ?? config.GOOGLECHATBOT_DEFAULT_HARNESS
      })
      if (folded) return
      throw error
    }
    // "Open chat in Console" trailer on the FIRST assistant message in a
    // thread (no earlier thread history = this event started the thread),
    // mirroring slackbotv2's console-session-link. Undefined when no Console
    // base URL is configured. `threadKey` (`chat:spaces:…`) is the exact value
    // sent to the session API as `thread_key`, which the Console indexes by.
    const isFirstAssistantMessage = !event.history_messages?.length
    const effectiveHarnessType =
      overrides.harnessType ?? config.GOOGLECHATBOT_DEFAULT_HARNESS
    // Without an explicit --model/--opus/... override the harness runs its
    // configured default (CLAUDE_MODEL/CODEX_MODEL, else the baked harness
    // config); show that instead of dropping the model entirely.
    const effectiveModel =
      overrides.model ?? defaultModelForHarness(effectiveHarnessType, harnessDefaultModels(config))
    const consoleSessionWidget = isFirstAssistantMessage
      ? buildConsoleSessionWidget({
          consoleBaseUrl: config.CENTAUR_CONSOLE_PUBLIC_URL,
          threadKey,
          harnessType: effectiveHarnessType,
          model: effectiveModel
        })
      : undefined
    const target = {
      spaceName: event.space_name,
      ackMessageName,
      threadName: event.chat.thread_name,
      sessionUrl: sessionUrl(config, threadKey, execution.execution_id),
      consoleSessionWidget,
      plainTextOnly: isPlainTextOnlyRequest(execute.text)
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
    // Reuse slackbotv2's delivery_status vocabulary so cross-bot dashboards
    // aggregate both: the final answer is written once and visible.
    incr('centaur_session_delivery_total', {
      delivery_status: state.error ? 'error_visible' : 'answer_visible'
    })
  } catch (error) {
    incr('googlechatbot_runs_total', { outcome: 'failed' })
    incr('centaur_session_delivery_total', { delivery_status: 'failed' })
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
  const detail = error instanceof Error ? error.message : String(error)
  // Keep under Google Chat's 4096-char plain `text` cap so a long upstream error
  // message doesn't 400 the error delivery itself and leave the user on "thinking".
  const text = clampPlainText(`⚠️ Centaur could not start this run: ${detail}`)
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

/** Recovery for the execute-vs-execute race: when `/execute` is rejected
 * because another run is already active for the thread, append the message so
 * the live run picks it up (steering) and drop the redundant ack. Returns true
 * when the message was folded and this event needs no run of its own. */
async function foldIntoActiveRun(
  config: AppConfig,
  client: ChatEdgeClient,
  threadKey: string,
  execute: GoogleChatTurnMessage,
  ackMessageName: string,
  error: unknown,
  session: { conversationName?: string; harnessType?: string }
): Promise<boolean> {
  const conflictClass = classifyExecuteConflict(error)
  if (conflictClass === 'unrelated') return false
  let active = conflictClass === 'conflict'
  if (!active) {
    try {
      // Same harness/name as the original createSession: a mismatched
      // harness_type would turn this idempotent re-check into its own 409.
      const recheck = await createSession(
        config,
        threadKey,
        session.conversationName,
        session.harnessType
      )
      active = recheck.activeExecution
    } catch (recheckError) {
      logWarn('googlechatbot_fold_recheck_failed', recheckError)
      return false
    }
  }
  if (!active) return false
  await appendSessionMessages(config, threadKey, [execute])
  await removeAck(client, ackMessageName)
  incr('googlechatbot_runs_total', { outcome: 'folded' })
  logWarn('googlechatbot_folded_into_active_run', {
    thread_key: threadKey,
    message_id: execute.id,
    reason: 'execute_conflict'
  })
  return true
}

/** Best-effort removal of the eager "thinking…" ack when this event won't
 * produce its own answer (it was folded into an already-running turn). */
async function removeAck(client: ChatEdgeClient, ackMessageName: string): Promise<void> {
  if (!ackMessageName) return
  try {
    await client.deleteMessage(ackMessageName)
  } catch (error) {
    logWarn('googlechatbot_fold_ack_delete_failed', error)
  }
}

/** Same escape-hatch phrases slackbotv2 honors: the requester asked for plain
 * text, so the final answer skips the card surface. */
function isPlainTextOnlyRequest(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    /\bplain\s+text\s+only\b/.test(normalized)
    || /\bno\s+interactive\s+blocks?\b/.test(normalized)
    || /\bno\s+dashboards?\b/.test(normalized)
  )
}

/** Deployment defaults for harness models (CLAUDE_MODEL / CODEX_MODEL env,
 * mirrored from sandbox.extraEnv by the chart), keyed by harness wire value. */
function harnessDefaultModels(config: AppConfig): Record<string, string> {
  return {
    ...(config.CLAUDE_MODEL ? { claudecode: config.CLAUDE_MODEL } : {}),
    ...(config.CODEX_MODEL ? { codex: config.CODEX_MODEL } : {})
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
