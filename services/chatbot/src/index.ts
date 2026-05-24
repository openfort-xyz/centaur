import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { ulid } from '@std/ulid'
import { showRoutes } from 'hono/dev'
import { timeout } from 'hono/timeout'
import { requestId } from 'hono/request-id'
import { prettyJSON } from 'hono/pretty-json'
import { startFinalDeliveryPoller } from './centaur/final-delivery'
import { CentaurHandoff } from './centaur/handoff'
import { loadConfig } from './config'
import { logError, logWarn, sanitizeLogValue } from './logging'
import {
  AgentSessionRenderer,
  withAgentSessionLock,
  getAgentSession
} from './chat/agent-session'
import { ChatEdgeClient } from './chat/client'
import { EventDeduper, chatDedupKey } from './chat/dedup'
import { collectThreadHistory, normalizeChatEnvelope } from './chat/normalize'
import { verifyChatRequest } from './chat/verify'
import { isAddedToSpace } from './chat/auth'
import type { NormalizedChatEvent, GoogleChatEnvelope, GoogleChatMessage } from './chat/types'

const config = loadConfig()
const client = new ChatEdgeClient(config)
const handoff = new CentaurHandoff(config)
const deduper = new EventDeduper(config.CHAT_EVENT_DEDUP_TTL_MS)

void startFinalDeliveryPoller(config, client)

type Variables = {
  chatRawBody: string
}

type WaitUntilContext = {
  waitUntil(promise: Promise<unknown>): void
}

export const app = new Hono<{ Variables: Variables }>()
  .use(prettyJSON())
  .use('*', async (c, next) => {
    await next()
    console.log('http_request', c.req.method, c.req.path, c.res.status)
  })
  .use('*', timeout(5_000))
  .use(
    requestId({
      headerName: 'X-Chatbot-Request-ID',
      generator: () => ulid()
    })
  )

app
  .get('/health', c =>
    c.json({
      ok: true,
      service: 'chatbot',
      commit: process.env.COMMIT_SHA ?? 'local'
    })
  )
  .get('/health/ready', c => c.redirect('/health'))

const apiKeyMiddleware: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
  if (!config.CHATBOT_API_KEY) {
    return c.json({ ok: false, error: 'chatbot_api_key_not_configured' }, 503)
  }
  const authorization = c.req.header('authorization') ?? ''
  if (authorization !== `Bearer ${config.CHATBOT_API_KEY}`) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }
  await next()
}

const chatEventsHandler = async (c: Context<{ Variables: Variables }>) => {
  // Google Chat is strict about the sync HTTP response shape. To silently
  // acknowledge an event (and respond later via the Chat REST API), the bot
  // MUST return `{}` with Content-Type: application/json. Anything else —
  // empty body, text/plain, a non-Message JSON shape like `{"ok": true}`,
  // or HTTP 204 — surfaces as a "<bot> not responding" placeholder card at
  // the top of the DM (even when the bot is healthy and follows up async).
  // Refs: https://developers.google.com/workspace/chat/receive-respond-interactions
  const body = await c.req.raw.text()
  const envelope = parseChatBody(body)
  if (!envelope) return c.json({}, 400)

  const verification = verifyChatRequest({
    config,
    envelope
  })
  if (!verification.ok) {
    return c.json({}, verification.status)
  }

  const key = chatDedupKey({
    eventTime: envelope.eventTime,
    spaceName: envelope.space?.name,
    messageName: envelope.message?.name
  })
  if (!deduper.checkAndRemember(key)) {
    logWarn('chat_duplicate_event_skipped', { dedupe_key: key })
    return c.json({})
  }

  runInBackground(c, processChatEvent(envelope))
  return c.json({})
}

app.post(config.CHAT_EVENTS_PATH, chatEventsHandler)
app.post('/api/chat/events', chatEventsHandler)

app.post('/api/chat/messages', apiKeyMiddleware, async c => {
  const body = await c.req.json<{
    space_name: string
    text: string
    header?: string
    thread_name?: string
  }>()
  try {
    const message = await client.createMessage(body.space_name, {
      text: body.text,
      ...(body.thread_name ? { thread: { name: body.thread_name } } : {})
    })
    return c.json({ ok: true, message_name: message.name, ...message })
  } catch (error) {
    return chatApiErrorResponse(c, error)
  }
})

app.patch('/api/chat/messages', apiKeyMiddleware, async c => {
  const body = await c.req.json<{
    message_name: string
    text: string
  }>()
  try {
    const message = await client.updateMessage(body.message_name, {
      text: body.text
    })
    return c.json({ ok: true, message_name: message.name, ...message })
  } catch (error) {
    return chatApiErrorResponse(c, error)
  }
})

app.delete('/api/chat/messages', apiKeyMiddleware, async c => {
  const body = await c.req.json<{
    message_name: string
  }>()
  try {
    await client.deleteMessage(body.message_name)
    return c.json({ ok: true })
  } catch (error) {
    return chatApiErrorResponse(c, error)
  }
})

app.get('/api/chat/messages', apiKeyMiddleware, async c => {
  const spaceName = c.req.query('space_name')
  if (!spaceName) return c.json({ ok: false, error: 'missing_space_name' }, 400)
  const pageSize = Number(c.req.query('page_size') || '20')
  try {
    const result = await client.listMessages(spaceName, {
      pageSize: Number.isFinite(pageSize) ? pageSize : 20
    })
    return c.json({ ok: true, ...result })
  } catch (error) {
    return chatApiErrorResponse(c, error)
  }
})

app.post('/api/chat/agent-sessions', apiKeyMiddleware, async c => {
  const body = await c.req.json<{
    space_name: string
    thread_name?: string
  }>()
  try {
    const result = await new AgentSessionRenderer(client).open({
      spaceName: body.space_name,
      threadName: body.thread_name
    })
    return c.json({
      ok: true,
      session_id: result.sessionId,
      message_name: result.messageName
    })
  } catch (error) {
    return chatApiErrorResponse(c, error)
  }
})

app.post('/api/chat/agent-sessions/:session_id/text', apiKeyMiddleware, async c => {
  const body = await c.req.json<{ markdown: string }>()
  try {
    const sessionId = c.req.param('session_id')
    await withAgentSessionLock(sessionId, () =>
      new AgentSessionRenderer(client).text(sessionId, body.markdown)
    )
    return c.json({ ok: true })
  } catch (error) {
    return chatApiErrorResponse(c, error)
  }
})

app.post('/api/chat/agent-sessions/:session_id/step', apiKeyMiddleware, async c => {
  const body = await c.req.json<{
    id: string
    title: string
    status?: 'pending' | 'in_progress' | 'complete' | 'error'
    details?: string
    output?: string
  }>()
  try {
    const sessionId = c.req.param('session_id')
    await withAgentSessionLock(sessionId, () =>
      new AgentSessionRenderer(client).step(sessionId, body)
    )
    return c.json({ ok: true })
  } catch (error) {
    return chatApiErrorResponse(c, error)
  }
})

app.post('/api/chat/agent-sessions/:session_id/done', apiKeyMiddleware, async c => {
  try {
    const sessionId = c.req.param('session_id')
    await withAgentSessionLock(sessionId, async () => {
      await new AgentSessionRenderer(client).done(sessionId)
    })
    return c.json({ ok: true })
  } catch (error) {
    return chatApiErrorResponse(c, error)
  }
})

if (process.env.NODE_ENV === 'development') showRoutes(app)

export default {
  port: config.PORT,
  fetch: app.fetch
}

function botResourceName(): string | undefined {
  if (!config.GOOGLE_SERVICE_ACCOUNT_JSON) return undefined
  try {
    const parsed = JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email?: string }
    const email = parsed.client_email
    return email ? `users/${email}` : undefined
  } catch {
    return undefined
  }
}

async function processChatEvent(envelope: GoogleChatEnvelope): Promise<void> {
  const botUser = botResourceName()
  const normalized = await normalizeChatEnvelope(envelope, botUser)
  if (!normalized) return

  if (isAddedToSpace(envelope)) {
    try {
      await client.createMessage(normalized.space_name, {
        text: 'Hi, Centaur at your service! I can help with software engineering tasks. Ask me anything or type `/centaur-help` to see what I can do.'
      })
    } catch (error) {
      logError('chat_welcome_message_failed', error)
    }
    return
  }

  if (!normalized.is_mention) return

  // Post the "_Centaur is thinking…_" ack message IMMEDIATELY, before handoff.
  // Google Chat shows a built-in "<bot> not responding" placeholder when no
  // bot message appears within ~5s of the user's prompt. Waiting for the API
  // to spawn a sandbox and call back to /api/chat/agent-sessions takes 5-10s,
  // so we'd always lose this race. Posting inline keeps the user informed
  // and seeds the message_name that the outbox poller later PATCHes with the
  // final answer.
  //
  // The thread-history fetch runs in parallel with the ack — neither depends
  // on the other and they share the same network budget. Awaiting them
  // separately lets us log a failure on either side without sacrificing the
  // other.
  const ackPromise = client
    .createMessage(
      normalized.space_name,
      { text: '_Centaur is thinking…_' },
      { threadName: normalized.chat.thread_name }
    )
    .then(ack => ack.name ?? '')
    .catch(error => {
      logError('chat_ack_create_failed', error)
      return ''
    })

  const historyPromise = collectThreadHistory(client, {
    spaceName: normalized.space_name,
    threadName: normalized.chat.thread_name,
    currentMessageName: normalized.message_id,
    botUserName: botUser
  })

  const [ackMessageName, historyMessages] = await Promise.all([ackPromise, historyPromise])
  if (historyMessages.length) normalized.history_messages = historyMessages

  const result = await handoff.emit(normalized, { ackMessageName })
  if (!result.ok) {
    if (result.status === 409) {
      logWarn('centaur_chat_handoff_conflict', result.body)
      return
    }
    throw new Error(`Centaur Chat handoff failed: ${result.status}`)
  }
}

function chatApiErrorResponse(c: Context, error: unknown) {
  const data = (error as { data?: unknown })?.data
  if (data && typeof data === 'object') return c.json(sanitizeLogValue(data), 502)
  return c.json(
    {
      ok: false,
      error: error instanceof Error ? String(sanitizeLogValue(error.message)) : 'chat_api_error'
    },
    502
  )
}

function runInBackground(c: Context, promise: Promise<void>): void {
  const guarded = promise.catch((error: unknown) => {
    logError('chat_event_processing_failed', error)
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

function parseChatBody(rawBody: string): GoogleChatEnvelope | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return null
  }

  // Google Workspace Add-ons (v2) envelope unwrap into v1 shape consumed by
  // normalize.ts. Apps created via the new Chat API "Configuration" UI default
  // to v2 — events arrive nested under `chat`, with the v1 fields split into
  // typed payload buckets.
  const chat = (parsed as { chat?: Record<string, unknown> }).chat
  if (chat && typeof chat === 'object') {
    const eventTime = chat.eventTime as string | undefined
    const user = chat.user as Record<string, unknown> | undefined
    const messagePayload = chat.messagePayload as
      | { space?: unknown; message?: unknown }
      | undefined
    if (messagePayload) {
      return {
        type: 'MESSAGE',
        eventTime,
        user,
        space: messagePayload.space,
        message: messagePayload.message
      } as unknown as GoogleChatEnvelope
    }
    const addedToSpacePayload = chat.addedToSpacePayload as
      { space?: unknown } | undefined
    if (addedToSpacePayload) {
      return {
        type: 'ADDED_TO_SPACE',
        eventTime,
        user,
        space: addedToSpacePayload.space
      } as unknown as GoogleChatEnvelope
    }
    const removedFromSpacePayload = chat.removedFromSpacePayload as
      { space?: unknown } | undefined
    if (removedFromSpacePayload) {
      return {
        type: 'REMOVED_FROM_SPACE',
        eventTime,
        user,
        space: removedFromSpacePayload.space
      } as unknown as GoogleChatEnvelope
    }
    // appCommandPayload / buttonClickedPayload / submitFormPayload are
    // deliberately dropped here, matching the v1 normalize.ts policy.
    return null
  }

  // v1 (legacy Chat API) envelope — pass through unchanged.
  return parsed as unknown as GoogleChatEnvelope
}
