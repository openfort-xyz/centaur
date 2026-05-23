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
import { normalizeChatEnvelope } from './chat/normalize'
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
  const body = await c.req.raw.text()
  const envelope = parseChatBody(body)
  if (!envelope) return c.json({ ok: false, error: 'invalid_chat_payload' }, 400)

  const verification = verifyChatRequest({
    config,
    envelope
  })
  if (!verification.ok) {
    return c.json({ ok: false, error: verification.reason }, verification.status)
  }

  const key = chatDedupKey({
    eventTime: envelope.eventTime,
    spaceName: envelope.space?.name,
    messageName: envelope.message?.name
  })
  if (!deduper.checkAndRemember(key)) {
    logWarn('chat_duplicate_event_skipped', { dedupe_key: key })
    return c.json({ ok: true, duplicate: true })
  }

  runInBackground(c, processChatEvent(envelope))
  return c.json({ ok: true })
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
    header?: string
    title?: string
  }>()
  try {
    const result = await new AgentSessionRenderer(client).open({
      spaceName: body.space_name,
      header: body.header,
      title: body.title
    })
    return c.json({ ok: true, session_id: result.sessionId })
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

  const result = await handoff.emit(normalized)
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
  try {
    return JSON.parse(rawBody) as GoogleChatEnvelope
  } catch {
    return null
  }
}
