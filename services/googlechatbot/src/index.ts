import { Buffer } from 'node:buffer'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { StateAdapter } from 'chat'
import type { AppConfig } from './config'
import { ChatApiError, ChatEdgeClient, ChatOwnershipError } from './chat/client'
import { EventDeduper, chatDedupKey } from './chat/dedup'
import {
  buildThreadKey,
  collectThreadHistory,
  isThreadReply,
  mentionedChatAppUserName,
  normalizeChatEnvelope
} from './chat/normalize'
import { verifyChatRequest, verifyChatRequestToken } from './chat/verify'
import { SpaceDmVerifier, type SpaceDmConfirmation } from './chat/space-verify'
import { googleRequestKeyResolver } from './chat/token'
import type {
  GoogleChatActionPayload,
  GoogleChatActionType,
  GoogleChatEnvelope,
  GoogleChatWorkflowEvent,
  NormalizedChatEvent
} from './chat/types'
import { messageUtf8Bytes } from './chat/render'
import { logError, logInfo, logWarn } from './logging'
import { addGauge, incr, renderMetrics, setGauge } from './metrics'
import {
  WORK_INDEX_KEY,
  acquireLease,
  createDefaultState,
  ensureStateConnected,
  persistWork,
  threadStateKey,
  updateThreadState,
  workKey,
  workLeaseKey,
  type GoogleChatThreadState,
  type GoogleChatWorkObligation,
  type StateConnectionStatus
} from './state'
import {
  messageOverridesStrategyFromConfig,
  type MessageOverridesStrategy
} from './message-overrides-strategy'
import { resolveSpaceDefault, spaceDefaultsFromConfig, type SpaceDefaults } from './space-defaults'
import {
  buildConsoleSessionWidget,
  defaultModelForHarness,
  effectiveReasoningForHarness,
  defaultServiceTierForHarness,
  reasoningForModel
} from './console-session-link'
import { chatReplyLimits } from './constants'
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
  emitWorkflowEvent,
  executeSession,
  interruptSessionExecution,
  openSessionEventStream,
  turnMessagesFromEvent
} from './session-api'
import { isChatStopCommand } from './stop-command'

/** Fit a one-off control message to the official whole-Message byte limit. */
export function clampPlainText(text: string): string {
  if (messageUtf8Bytes({ text }) <= chatReplyLimits.message.maxBytes) return text
  const chars = Array.from(text)
  let low = 0
  let high = chars.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (messageUtf8Bytes({ text: `${chars.slice(0, middle).join('')}…` })
      <= chatReplyLimits.message.maxBytes) low = middle
    else high = middle - 1
  }
  return `${chars.slice(0, low).join('')}…`
}

/** Bounded re-opens of a dropped SSE stream before we give up and deliver. */
const MAX_RESUME_ATTEMPTS = 3

/**
 * Everything the identity gate needs about a request: whether GOOGLE signed it,
 * and how to ask GOOGLE what the space is. Neither can be read off the body —
 * the signed request token binds no body — and both must hold before a session
 * may claim a person's identity (and with it their OAuth credentials).
 */
type IdentityContext = {
  verified: boolean
  confirmSpace: (spaceName: string) => Promise<SpaceDmConfirmation>
}

/** Config-derived values resolved once at startup and reused for every turn. */
type BotRuntime = {
  messageOverrides: MessageOverridesStrategy
  spaceDefaults: SpaceDefaults
}

/** Ceiling on the spaces.get identity lookup. Far below
 * GOOGLECHATBOT_CHAT_API_TIMEOUT_MS (30s) because this call gates a live turn:
 * a hung Chat backend must cost the turn ~3s and suppress identity, not stall
 * it. The result is cached, so the cost is paid once per space. */
const SPACE_LOOKUP_TIMEOUT_MS = 3_000

// Outbound upload ceiling — matches slackbotv2's inline file cap; the Chat API
// itself accepts up to 200MB per attachment.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_CHAT_EVENT_BODY_BYTES = 1024 * 1024
const MAX_INTERNAL_JSON_BYTES = 1024 * 1024
// Interim JSON/base64 transport inflates a 100MiB file by ~4/3. TASK-023
// replaces this with raw streaming; the decoded MAX_UPLOAD_BYTES remains the
// authoritative file limit.
const MAX_INTERNAL_UPLOAD_BYTES = 135 * 1024 * 1024
const DWD_SUBJECT_HEADER = 'x-centaur-google-chat-dwd-subject'
const CHAT_INGRESS_DEADLINE_MS = 29_000

const WELCOME_TEXT =
  'Hi, Centaur at your service! I can help with software engineering tasks. ' +
  'Mention me in a thread to get started.'

export type Googlechatbot = {
  app: Hono
  client: ChatEdgeClient
  state: StateAdapter
  stateConnected: Promise<void>
  stateStatus: StateConnectionStatus
}

export function createGooglechatbot(
  config: AppConfig,
  options: { state?: StateAdapter } = {}
): Googlechatbot {
  const stateStatus: StateConnectionStatus = { attempts: 0, connected: false }
  const hasDatabase = Boolean(
    config.GOOGLECHATBOT_DATABASE_URL ?? config.DATABASE_URL ?? config.POSTGRES_URL
  )
  if (!options.state && !hasDatabase) {
    throw new Error('GOOGLECHATBOT_DATABASE_URL or DATABASE_URL is required')
  }
  const state =
    options.state
    ?? createDefaultState(config, undefined, error => {
      stateStatus.connected = false
      stateStatus.lastError = error.message
      setGauge('googlechatbot_state_connected', 0)
    })
  const client = new ChatEdgeClient(config, { quotaState: state })
  const stateConnected = ensureStateConnected(state, config, stateStatus)
  const deduper = new EventDeduper(state, config.CHAT_EVENT_DEDUP_TTL_MS)
  // Resolver for Google Chat's request-signing public keys (cached JWK set).
  const resolveChatKey = googleRequestKeyResolver()
  // Asks Google (once per space, then cached) whether a space really is a 1:1
  // DM. The request body cannot answer that: Chat's signed token binds no body.
  const spaceVerifier = new SpaceDmVerifier(spaceName =>
    client.getSpace(spaceName, { timeoutMs: SPACE_LOOKUP_TIMEOUT_MS })
  )
  const runtime: BotRuntime = {
    messageOverrides: messageOverridesStrategyFromConfig(config),
    spaceDefaults: spaceDefaultsFromConfig(config)
  }

  const app = new Hono()

  app.get('/health/live', c =>
    c.json({ ok: true, service: 'googlechatbot', commit: process.env.COMMIT_SHA ?? 'local' })
  )
  app.get('/health/ready', c =>
    c.json(
      {
        ok: stateStatus.connected,
        service: 'googlechatbot',
        database_connected: stateStatus.connected,
        database_connect_attempts: stateStatus.attempts
      },
      stateStatus.connected ? 200 : 503
    )
  )
  // Compatibility path remains readiness, never liveness.
  app.get('/health', c =>
    c.json({ ok: stateStatus.connected, service: 'googlechatbot' }, stateStatus.connected ? 200 : 503)
  )
  app.get('/metrics', c => c.text(renderMetrics(), 200, { 'content-type': 'text/plain; version=0.0.4' }))

  const chatEventsHandler = async (c: Context) => {
    // Google Chat is strict about the sync HTTP response shape. To silently
    // acknowledge an event (and respond later via the Chat REST API), the bot
    // MUST return `{}` with Content-Type: application/json. Anything else — an
    // empty body, text/plain, a non-Message JSON shape like `{"ok": true}`, or
    // HTTP 204 — surfaces as a "<bot> not responding" placeholder card.
    // https://developers.google.com/workspace/chat/receive-respond-interactions
    // The production server does not bind until this resolves. Awaiting here as
    // well makes explicitly injected test adapters deterministic without
    // weakening readiness or allowing an in-memory production fallback.
    await stateConnected
    if (!stateStatus.connected) return c.json({}, 503)

    // Authenticate Google's system bearer before reading any attacker-sized
    // body. The optional Add-on human token lives inside the bounded envelope
    // and is verified in a second pass below.
    const systemTokenCheck = await verifyChatRequestToken({
      config,
      authorization: c.req.header('Authorization'),
      resolveKey: resolveChatKey
    })
    if (!systemTokenCheck.ok) {
      incr('googlechatbot_events_total', { outcome: 'rejected' })
      logWarn('googlechatbot_event_rejected', { reason: systemTokenCheck.reason })
      return c.json({}, systemTokenCheck.status)
    }

    const body = await readBodyText(c, MAX_CHAT_EVENT_BODY_BYTES)
    if (body instanceof InputError) {
      incr('googlechatbot_events_total', { outcome: 'rejected' })
      logWarn('googlechatbot_event_rejected', { reason: 'body_limit', status: body.status })
      return c.json({}, body.status)
    }
    // Receipt is logged before parsing so oversized/unparseable deliveries are
    // still visible; the shape log below only covers envelopes we accepted.
    logInfo('googlechatbot_webhook_received', {
      body_bytes: Buffer.byteLength(body, 'utf8'),
      route: c.req.path
    })
    const envelope = parseChatBody(body)
    if (!envelope) {
      incr('googlechatbot_events_total', { outcome: 'rejected' })
      logWarn('googlechatbot_event_rejected', { reason: 'unparseable_body' })
      return c.json({}, 400)
    }

    const tokenCheck = envelope.authorizationEventObject?.userIdToken
      ? await verifyChatRequestToken({
          config,
          authorization: c.req.header('Authorization'),
          userIdToken: envelope.authorizationEventObject.userIdToken,
          resolveKey: resolveChatKey
        })
      : systemTokenCheck
    if (!tokenCheck.ok) {
      incr('googlechatbot_events_total', { outcome: 'rejected' })
      logWarn('googlechatbot_event_rejected', { reason: tokenCheck.reason })
      return c.json({}, tokenCheck.status)
    }

    const verification = verifyChatRequest({
      config,
      envelope,
      userEmail: tokenCheck.userEmail,
      userId: tokenCheck.userId
    })
    if (!verification.ok) {
      incr('googlechatbot_events_total', { outcome: 'rejected' })
      logWarn('googlechatbot_event_rejected', { reason: verification.reason })
      return c.json({}, verification.status)
    }

    logChatEventShape(config, envelope)
    const action = googleChatWorkflowEvent(envelope, tokenCheck.userEmail)
    const key = chatDedupKey({
      eventTime: envelope.eventTime,
      spaceName: envelope.space?.name,
      messageName: envelope.message?.name,
      ...(action ? { action: action.payload } : {})
    })
    const dedupeToken = randomUUID()
    if (!(await deduper.acquire(key, dedupeToken))) {
      incr('googlechatbot_events_total', { outcome: 'duplicate' })
      incr('googlechatbot_dedupe_total', { outcome: 'duplicate' })
      logWarn('googlechatbot_duplicate_event_skipped', { dedupe_key: key })
      return c.json({})
    }

    try {
      const work: GoogleChatWorkObligation = {
        acceptedAt: new Date().toISOString(),
        ...(action ? { action } : {}),
        dedupeKey: key,
        envelope: envelopeWithoutTokens(envelope),
        eventType: envelope.type,
        failures: 0,
        identityVerified: tokenCheck.verified,
        ...(tokenCheck.userEmail ? { identityUserEmail: tokenCheck.userEmail } : {}),
        lastEventId: 0,
        stage: 'accepted',
        workId: randomUUID()
      }
      // Durable acceptance precedes the synchronous 200. A process crash after
      // this write is recovered by the startup sweep; Google need not redeliver.
      await persistWork(state, work)
      await deduper.complete(key)
      addGauge('googlechatbot_pending_render_obligations', 1)
      incr('googlechatbot_events_total', { outcome: 'accepted' })
      incr('googlechatbot_dedupe_total', { outcome: 'accepted' })
      runInBackground(processWorkObligation(config, client, runtime, state, spaceVerifier, work))
      return c.json({})
    } catch (error) {
      await deduper.release(key, dedupeToken).catch(() => undefined)
      logError('googlechatbot_durable_accept_failed', error)
      return c.json({}, 503)
    }
  }

  app.post(config.CHAT_EVENTS_PATH, c => settleBeforeDeadline(
    chatEventsHandler(c),
    CHAT_INGRESS_DEADLINE_MS,
    () => c.json({}, 503)
  ))

  // This API is private to api-rs. api-rs has already authorized the caller's
  // exact space/operation grant; NetworkPolicy admits only its pod selector.
  const requireInternalAuth = (c: Context): Response | null => {
    if (!config.GOOGLECHATBOT_INTERNAL_API_KEY) {
      return c.json({ error: 'internal Google Chat API is not configured' }, 503)
    }
    const provided = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!sameSecret(provided, config.GOOGLECHATBOT_INTERNAL_API_KEY)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return null
  }

  app.get('/api/chat/spaces', async c => {
    const denied = requireInternalAuth(c)
    if (denied) return denied
    const subject = delegatedSubject(c)
    if (subject instanceof InputError) return c.json({ error: subject.message }, subject.status)
    const page = pageOptions(c)
    if (page instanceof InputError) return c.json({ error: page.message }, page.status)
    try {
      return c.json(await client.listSpaces({
        ...page,
        ...(subject ? { credential: { kind: 'delegated-etl-reader' as const, subject } } : {})
      }))
    } catch (error) {
      return internalFailure(c, 'googlechatbot_outbound_list_spaces_failed', error)
    }
  })

  app.get('/api/chat/spaces/:spaceId', async c => {
    const denied = requireInternalAuth(c)
    if (denied) return denied
    const spaceName = spaceResource(c.req.param('spaceId'))
    if (!spaceName) return c.json({ error: 'invalid Google Chat space resource ID' }, 400)
    try {
      return c.json(await client.getSpace(spaceName))
    } catch (error) {
      return internalFailure(c, 'googlechatbot_outbound_get_space_failed', error)
    }
  })

  app.post('/api/chat/spaces/:spaceId/messages', async c => {
    const denied = requireInternalAuth(c)
    if (denied) return denied
    const spaceName = spaceResource(c.req.param('spaceId'))
    if (!spaceName) return c.json({ error: 'invalid Google Chat space resource ID' }, 400)
    const body = await readJsonBody<{
      text?: string
      thread_name?: string
    }>(c, MAX_INTERNAL_JSON_BYTES)
    if (body instanceof InputError) return c.json({ error: body.message }, body.status)
    if (typeof body?.text !== 'string') return c.json({ error: 'text is required' }, 400)
    try {
      const thread = internalThreadOptions(spaceName, body.thread_name)
      const sent = await client.createMessage(
        spaceName,
        { text: body.text },
        thread
      )
      return c.json(sent)
    } catch (error) {
      if (error instanceof InputError) return c.json({ error: error.message }, error.status)
      return internalFailure(c, 'googlechatbot_outbound_send_failed', error)
    }
  })

  app.get('/api/chat/spaces/:spaceId/messages', async c => {
    const denied = requireInternalAuth(c)
    if (denied) return denied
    const subject = delegatedSubject(c)
    if (subject instanceof InputError) return c.json({ error: subject.message }, subject.status)
    const spaceName = spaceResource(c.req.param('spaceId'))
    if (!spaceName) return c.json({ error: 'invalid Google Chat space resource ID' }, 400)
    const pageSize = Number(c.req.query('page_size') ?? '20') || 20
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      return c.json({ error: 'page_size must be between 1 and 1000' }, 400)
    }
    // `impersonate` (a requester email) lets reads fall back to DWD user auth so
    // DM history is readable — app auth cannot read DMs. `filter` scopes to a
    // single thread (thread.name = spaces/.../threads/...), matching Google's
    // unquoted messages.list filter grammar and thread-history collection.
    const impersonate = c.req.query('impersonate')
    if (subject && impersonate) {
      return c.json({ error: 'delegated subject and impersonate cannot be combined' }, 400)
    }
    const filter = c.req.query('filter')
    const orderBy = c.req.query('order_by')
    const showDeleted = c.req.query('show_deleted')
    if (showDeleted && showDeleted !== 'true') {
      return c.json({ error: 'show_deleted must be true when provided' }, 400)
    }
    try {
      return c.json(
        await client.listMessages(spaceName, {
          pageSize,
          ...(c.req.query('page_token') ? { pageToken: c.req.query('page_token') } : {}),
          ...(filter ? { filter } : {}),
          ...(orderBy ? { orderBy } : {}),
          ...(showDeleted ? { showDeleted: true } : {}),
          ...(subject ? { credential: { kind: 'delegated-etl-reader' as const, subject } } : {}),
          ...(impersonate ? { impersonateSubject: impersonate } : {})
        })
      )
    } catch (error) {
      return internalFailure(c, 'googlechatbot_outbound_list_failed', error)
    }
  })

  app.get('/api/chat/spaces/:spaceId/members', async c => {
    const denied = requireInternalAuth(c)
    if (denied) return denied
    const subject = delegatedSubject(c)
    if (subject instanceof InputError) return c.json({ error: subject.message }, subject.status)
    const spaceName = spaceResource(c.req.param('spaceId'))
    const page = pageOptions(c)
    if (!spaceName) return c.json({ error: 'invalid Google Chat space resource ID' }, 400)
    if (page instanceof InputError) return c.json({ error: page.message }, page.status)
    try {
      return c.json(await client.listMemberships(spaceName, {
        ...page,
        ...(subject ? { credential: { kind: 'delegated-etl-reader' as const, subject } } : {})
      }))
    } catch (error) {
      return internalFailure(c, 'googlechatbot_outbound_list_members_failed', error)
    }
  })

  app.get('/api/chat/spaces/:spaceId/messages/:messageId/reactions', async c => {
    const denied = requireInternalAuth(c)
    if (denied) return denied
    const subject = delegatedSubject(c)
    if (subject instanceof InputError) return c.json({ error: subject.message }, subject.status)
    const spaceName = spaceResource(c.req.param('spaceId'))
    const messageName = messageResource(c.req.param('spaceId'), c.req.param('messageId'))
    const page = pageOptions(c)
    if (!spaceName || !messageName) return c.json({ error: 'invalid Google Chat resource ID' }, 400)
    if (page instanceof InputError) return c.json({ error: page.message }, page.status)
    if (!subject && !client.canReadReactions()) {
      return c.json({ error: 'Google Chat reaction reads are not configured' }, 503)
    }
    try {
      return c.json(await client.listMessageReactions(messageName, {
        ...page,
        credential: subject ? { kind: 'delegated-etl-reader', subject } : 'reaction-reader'
      }))
    } catch (error) {
      return internalFailure(c, 'googlechatbot_outbound_list_reactions_failed', error)
    }
  })

  app.get('/api/chat/spaces/:spaceId/messages/:messageId/attachments/:attachmentId', async c => {
    const denied = requireInternalAuth(c)
    if (denied) return denied
    const subject = delegatedSubject(c)
    if (subject instanceof InputError) return c.json({ error: subject.message }, subject.status)
    const spaceName = spaceResource(c.req.param('spaceId'))
    const messageName = messageResource(c.req.param('spaceId'), c.req.param('messageId'))
    const attachmentId = c.req.param('attachmentId')
    if (!spaceName || !messageName || !validResourceId(attachmentId)) {
      return c.json({ error: 'invalid Google Chat resource ID' }, 400)
    }
    try {
      return c.json(await client.getAttachment(messageName, attachmentId, subject))
    } catch (error) {
      return internalFailure(c, 'googlechatbot_outbound_get_attachment_failed', error)
    }
  })

  app.get(
    '/api/chat/spaces/:spaceId/messages/:messageId/attachments/:attachmentId/download',
    async c => {
      const denied = requireInternalAuth(c)
      if (denied) return denied
      const subject = delegatedSubject(c)
      if (subject instanceof InputError) return c.json({ error: subject.message }, subject.status)
      const messageName = messageResource(c.req.param('spaceId'), c.req.param('messageId'))
      const attachmentId = c.req.param('attachmentId')
      if (!messageName || !validResourceId(attachmentId)) {
        return c.json({ error: 'invalid Google Chat resource ID' }, 400)
      }
      try {
        const resolved = await client.resolveAttachment(messageName, attachmentId, subject)
        const downloaded = await client.downloadAttachmentResource(
          resolved.attachment,
          resolved.credential
        )
        return new Response(downloaded.data, {
          headers: {
            'Content-Type': downloaded.mimeType,
            'Content-Length': String(downloaded.size),
            'Content-Disposition': contentDisposition(downloaded.name),
            'X-Content-Type-Options': 'nosniff'
          }
        })
      } catch (error) {
        return internalFailure(c, 'googlechatbot_outbound_download_attachment_failed', error)
      }
    }
  )

  app.patch('/api/chat/spaces/:spaceId/messages/:messageId', async c => {
    const denied = requireInternalAuth(c)
    if (denied) return denied
    const subject = delegatedSubject(c)
    if (subject instanceof InputError) return c.json({ error: subject.message }, subject.status)
    const spaceName = spaceResource(c.req.param('spaceId'))
    const messageName = messageResource(c.req.param('spaceId'), c.req.param('messageId'))
    if (!spaceName || !messageName) return c.json({ error: 'invalid Google Chat resource ID' }, 400)
    const body = await readJsonBody<{
      text?: string
    }>(c, MAX_INTERNAL_JSON_BYTES)
    if (body instanceof InputError) return c.json({ error: body.message }, body.status)
    if (typeof body?.text !== 'string') return c.json({ error: 'text is required' }, 400)
    try {
      return c.json(await client.updateOwnedMessage(spaceName, messageName, { text: body.text }, subject))
    } catch (error) {
      return internalFailure(c, 'googlechatbot_outbound_update_failed', error)
    }
  })

  app.delete('/api/chat/spaces/:spaceId/messages/:messageId', async c => {
    const denied = requireInternalAuth(c)
    if (denied) return denied
    const subject = delegatedSubject(c)
    if (subject instanceof InputError) return c.json({ error: subject.message }, subject.status)
    const spaceName = spaceResource(c.req.param('spaceId'))
    const messageName = messageResource(c.req.param('spaceId'), c.req.param('messageId'))
    if (!spaceName || !messageName) return c.json({ error: 'invalid Google Chat resource ID' }, 400)
    try {
      await client.deleteOwnedMessage(spaceName, messageName, subject)
      return c.json({})
    } catch (error) {
      return internalFailure(c, 'googlechatbot_outbound_delete_failed', error)
    }
  })

  // Upload a file into a space (optionally threaded, with a caption). This is
  // how agent tooling delivers files to the thread — the Slack analogue is the
  // `slack upload` CLI hitting Slack directly; here the credential (a DWD
  // user impersonation, see GOOGLECHATBOT_UPLOAD_USER) stays in the bot.
  app.post('/api/chat/spaces/:spaceId/attachments', async c => {
    const denied = requireInternalAuth(c)
    if (denied) return denied
    const subject = delegatedSubject(c)
    if (subject instanceof InputError) return c.json({ error: subject.message }, subject.status)
    const spaceName = spaceResource(c.req.param('spaceId'))
    if (!spaceName) return c.json({ error: 'invalid Google Chat space resource ID' }, 400)
    if (!client.canUploadAttachments(subject)) {
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
    const body = await readJsonBody<{
      filename?: string
      content_base64?: string
      mime_type?: string
      text?: string
      thread_name?: string
    }>(c, MAX_INTERNAL_UPLOAD_BYTES)
    if (body instanceof InputError) return c.json({ error: body.message }, body.status)
    if (!body?.filename || !body.content_base64) {
      return c.json({ error: 'filename and content_base64 are required' }, 400)
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
      const thread = internalThreadOptions(spaceName, body.thread_name)
      const uploaded = await client.uploadAttachment(
        spaceName,
        body.filename,
        body.mime_type ?? 'application/octet-stream',
        data,
        subject
      )
      const sent = await client.createAttachmentMessage(spaceName, uploaded, {
        ...(body.text ? { text: body.text } : {}),
        ...(subject ? { subject } : {}),
        ...thread
      })
      return c.json(sent)
    } catch (error) {
      if (error instanceof InputError) return c.json({ error: error.message }, error.status)
      return internalFailure(c, 'googlechatbot_outbound_upload_failed', error)
    }
  })

  app.post('/api/chat/dms/setup', async c => {
    const denied = requireInternalAuth(c)
    if (denied) return denied
    const target = c.req.query('target_identity')?.trim().toLowerCase()
    if (!target || !validTargetIdentity(target)) {
      return c.json({ error: 'Google Chat DM target must be an email address' }, 400)
    }
    if (!client.canSetupDm()) {
      return c.json({ error: 'Google Chat DM setup is not configured' }, 503)
    }
    const body = await readJsonBody<Record<string, unknown>>(c, MAX_INTERNAL_JSON_BYTES)
    if (body instanceof InputError) return c.json({ error: body.message }, body.status)
    try {
      return c.json(await client.setupDm(target))
    } catch (error) {
      return internalFailure(c, 'googlechatbot_outbound_setup_dm_failed', error)
    }
  })

  runInBackground(stateConnected.then(() => startRecoverySweeps(
    config, client, runtime, state, spaceVerifier
  )))

  return { app, client, state, stateConnected, stateStatus }
}

export async function settleBeforeDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(onTimeout()), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function sameSecret(provided: string, expected: string): boolean {
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function validResourceId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,256}$/.test(value)
}

function spaceResource(spaceId: string): string | null {
  return validResourceId(spaceId) ? `spaces/${spaceId}` : null
}

function messageResource(spaceId: string, messageId: string): string | null {
  return validResourceId(spaceId) && validResourceId(messageId)
    ? `spaces/${spaceId}/messages/${messageId}`
    : null
}

/**
 * Bind a caller-supplied thread to the route's own space, so a scoped grant on
 * one space can't be used to write into a thread of another.
 *
 * This used to also `spaces.get` the destination to resolve its spaceType,
 * because thread options were suppressed outside named spaces. Google threads
 * DMs and group chats now (see ChatEdgeClient.createMessage), so that lookup
 * bought nothing but an API call in front of every send.
 */
function internalThreadOptions(
  spaceName: string,
  threadName?: string
): { threadName?: string } {
  if (!threadName) return {}
  const [prefix, threadSpace, collection, threadId, extra] = threadName.split('/')
  if (
    prefix !== 'spaces'
    || `spaces/${threadSpace}` !== spaceName
    || collection !== 'threads'
    || !validResourceId(threadId ?? '')
    || extra !== undefined
  ) {
    throw new InputError(400, 'thread_name must belong to the route space')
  }
  return { threadName }
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 200) || 'attachment'
  return `attachment; filename="${ascii.replaceAll('"', '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function validTargetIdentity(value: string): boolean {
  return value.length <= 320
    && /^[^\s/@]+@[^\s/@]+$/.test(value)
    && ![...value].some(char => char.charCodeAt(0) < 32)
}

function delegatedSubject(c: Context): string | undefined | InputError {
  const raw = c.req.header(DWD_SUBJECT_HEADER)
  if (raw === undefined) return undefined
  const subject = raw.trim().toLowerCase()
  if (
    raw !== subject
    || subject.length > 320
    || !/^[^\s@]+@[^\s@]+$/.test(subject)
    || [...subject].some(char => char.charCodeAt(0) < 32)
  ) {
    return new InputError(400, 'invalid Google Chat DWD subject')
  }
  return subject
}

class InputError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message)
  }
}

async function readJsonBody<T>(c: Context, limit: number): Promise<T | null | InputError> {
  const text = await readBodyText(c, limit)
  if (text instanceof InputError || text === '') return text || null
  try {
    return JSON.parse(text) as T
  } catch {
    return new InputError(400, 'request body must be valid JSON')
  }
}

async function readBodyText(c: Context, limit: number): Promise<string | InputError> {
  const declared = Number(c.req.header('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    return new InputError(413, 'request body exceeds the configured limit')
  }
  const reader = c.req.raw.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return new InputError(413, 'request body exceeds the configured limit')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString()
}

function pageOptions(c: Context): { pageSize?: number; pageToken?: string } | InputError {
  const rawSize = c.req.query('page_size')
  const pageSize = rawSize === undefined ? undefined : Number(rawSize)
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000)) {
    return new InputError(400, 'page_size must be between 1 and 1000')
  }
  const pageToken = c.req.query('page_token')
  if (pageToken && (pageToken.length > 4096 || [...pageToken].some(char => char.charCodeAt(0) < 32))) {
    return new InputError(400, 'invalid page_token')
  }
  return {
    ...(pageSize ? { pageSize } : {}),
    ...(pageToken ? { pageToken } : {})
  }
}

function internalFailure(c: Context, event: string, error: unknown): Response {
  if (error instanceof ChatOwnershipError) {
    return c.json({ error: error.message }, 403)
  }
  // Do not serialize upstream errors: OAuth and API failures can contain
  // credential-bearing diagnostics. The stable event and error class suffice.
  logError(event, { error_name: error instanceof Error ? error.name : 'unknown' })
  return c.json({ error: 'Google Chat request failed' }, 502)
}

export async function processWorkObligation(
  config: AppConfig,
  client: ChatEdgeClient,
  runtime: BotRuntime,
  state: StateAdapter,
  spaceVerifier: SpaceDmVerifier,
  initial: GoogleChatWorkObligation,
  source: 'live' | 'recovery' = 'live'
): Promise<void> {
  const release = await acquireLease(
    state,
    workLeaseKeyFor(initial),
    120_000,
    60_000
  )
  if (!release) {
    incr('googlechatbot_recovery_total', { outcome: 'lease_skipped', source })
    return
  }
  try {
    const work = (await state.get<GoogleChatWorkObligation>(workKey(initial.workId))) ?? initial
    const age = Date.now() - Date.parse(work.acceptedAt)
    if (
      !Number.isFinite(age)
      || age > config.GOOGLECHATBOT_RECOVERY_MAX_OBLIGATION_AGE_MS
      || work.failures >= config.GOOGLECHATBOT_RECOVERY_FAILURE_BUDGET
    ) {
      await finishWork(state, work)
      incr('googlechatbot_recovery_total', { outcome: 'abandoned', source })
      return
    }

    if (!work.action && work.envelope) {
      work.action = googleChatWorkflowEvent(work.envelope, work.identityUserEmail) ?? undefined
    }
    if (work.action) {
      await handleChatAction(config, work.action)
      await state.set(
        `googlechatbot:dedupe:${work.dedupeKey}`,
        'completed',
        config.CHAT_EVENT_DEDUP_TTL_MS
      )
      await finishWork(state, work)
      incr('googlechatbot_recovery_total', { outcome: 'completed', source })
      return
    }
    if (!work.event && work.envelope) {
      work.event = await normalizeChatEnvelope(work.envelope, undefined, client, {
        acceptFollowUpAttachments: config.GOOGLECHATBOT_FOLLOW_UP_THREADS
      }) ?? undefined
      if (work.event && work.identityUserEmail) work.event.user_email = work.identityUserEmail
      await persistWork(state, work)
    }
    const event = work.event
    if (!event) {
      await finishWork(state, work)
      return
    }
    if (work.eventType === 'ADDED_TO_SPACE') {
      await client.createMessage(event.space_name, { text: WELCOME_TEXT })
      await finishWork(state, work)
      return
    }
    const followUp = config.GOOGLECHATBOT_FOLLOW_UP_THREADS && isThreadReply(event)
    if (!event.is_mention && !followUp) {
      await finishWork(state, work)
      return
    }
    if (isChatStopCommand(normalizedEventText(event))) {
      await handleStopCommand(config, client, event)
      await finishWork(state, work)
      return
    }

    if (!work.ackMessageName) {
      const messageId = `client-centaur-ack-${work.workId.replace(/-/g, '')}`
      try {
        const ack = await client.createMessage(
          event.space_name,
          { text: INITIAL_STATUS },
          { messageId, threadName: event.chat.thread_name }
        )
        work.ackMessageName = ack.name ?? `${event.space_name}/messages/${messageId}`
      } catch (error) {
        if (!(error instanceof ChatApiError) || error.status !== 409) throw error
        work.ackMessageName = `${event.space_name}/messages/${messageId}`
      }
      work.stage = 'thinking'
      await persistWork(state, work)
    }

    if (work.stage === 'final') {
      await finishWork(state, work)
      return
    }
    if (work.executionId || work.canonicalFinal) {
      await recoverFinalRender(config, client, state, work)
      await finishWork(state, work)
      incr('googlechatbot_recovery_total', { outcome: 'completed', source })
      return
    }

    const history = await collectThreadHistory(client, {
      spaceName: event.space_name,
      threadName: event.chat.thread_name,
      currentMessageName: event.message_id,
      threadReply: event.chat.thread_reply,
      botUserName: work.envelope ? mentionedChatAppUserName(work.envelope) : undefined,
      ...(event.user_email ? { requesterEmail: event.user_email } : {}),
      historyLimit: config.GOOGLECHATBOT_THREAD_HISTORY_LIMIT
    }).catch(error => {
      logWarn('googlechatbot_thread_history_failed', error)
      return [] as NonNullable<NormalizedChatEvent['history_messages']>
    })
    if (history.length) event.history_messages = history

    await driveSession(
      config,
      client,
      runtime,
      event,
      work.ackMessageName ?? '',
      {
        verified: work.identityVerified,
        confirmSpace: spaceName => spaceVerifier.confirm(spaceName)
      },
      state,
      work
    )
    await finishWork(state, work)
    incr('googlechatbot_recovery_total', { outcome: 'completed', source })
  } catch (error) {
    const work = (await state.get<GoogleChatWorkObligation>(workKey(initial.workId))) ?? initial
    work.failures += 1
    await persistWork(state, work).catch(() => undefined)
    incr('googlechatbot_recovery_total', { outcome: 'failed', source })
    logError('googlechatbot_work_failed', error, { source, work_id: initial.workId })
  } finally {
    await release()
  }
}

function workLeaseKeyFor(work: GoogleChatWorkObligation): string {
  if (work.action) return `${workKey(work.workId)}:lease`
  if (work.event) return workLeaseKey(work.event.thread_key)
  const spaceName = work.envelope?.space?.name
  const resourceName = work.envelope?.thread?.name
    ?? work.envelope?.message?.thread?.name
    ?? work.envelope?.message?.name
    ?? spaceName
  return spaceName && resourceName
    ? workLeaseKey(buildThreadKey(spaceName, resourceName))
    : `${workKey(work.workId)}:lease`
}

async function finishWork(state: StateAdapter, work: GoogleChatWorkObligation): Promise<void> {
  await state.delete(workKey(work.workId))
  addGauge('googlechatbot_pending_render_obligations', -1)
}

export async function recoverWorkObligations(
  config: AppConfig,
  client: ChatEdgeClient,
  runtime: BotRuntime,
  state: StateAdapter,
  spaceVerifier: SpaceDmVerifier
): Promise<void> {
  const ids = Array.from(new Set(await state.getList<string>(WORK_INDEX_KEY)))
  const pending: GoogleChatWorkObligation[] = []
  for (const id of ids) {
    const work = await state.get<GoogleChatWorkObligation>(workKey(id))
    if (work) pending.push(work)
  }
  setGauge('googlechatbot_pending_render_obligations', pending.length)
  incr('googlechatbot_recovery_total', { outcome: 'scan' })
  for (const work of pending) {
    await processWorkObligation(config, client, runtime, state, spaceVerifier, work, 'recovery')
  }
}

async function startRecoverySweeps(
  config: AppConfig,
  client: ChatEdgeClient,
  runtime: BotRuntime,
  state: StateAdapter,
  spaceVerifier: SpaceDmVerifier
): Promise<void> {
  let running = false
  const sweep = async () => {
    if (running) return
    running = true
    try {
      await recoverWorkObligations(config, client, runtime, state, spaceVerifier)
    } finally {
      running = false
    }
  }
  await sweep()
  const timer = setInterval(() => void sweep().catch(error => {
    logError('googlechatbot_recovery_sweep_failed', error)
  }), config.GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS)
  timer.unref?.()
}

async function recoverFinalRender(
  config: AppConfig,
  client: ChatEdgeClient,
  stateAdapter: StateAdapter,
  work: GoogleChatWorkObligation
): Promise<void> {
  if (!work.event) throw new Error('Google Chat work is missing its normalized event')
  const renderState = createRenderState()
  if (work.canonicalFinal) {
    renderState.answer = work.canonicalFinal.answer
    renderState.error = work.canonicalFinal.error
    renderState.terminal = true
    renderState.mapper = { process: () => [], flush: () => [] } as unknown as typeof renderState.mapper
  } else {
    let lastEventId = 0
    for (let attempt = 0; attempt < MAX_RESUME_ATTEMPTS && !renderState.terminal; attempt += 1) {
      const stream = await openSessionEventStream(
        config,
        work.event.thread_key,
        lastEventId,
        work.executionId,
        id => {
          lastEventId = Math.max(lastEventId, id)
        }
      )
      await consumeRenderStream(client, stream, durableRenderTarget(work), renderState)
    }
    work.lastEventId = lastEventId
    work.canonicalFinal = {
      answer: renderState.answer,
      ...(renderState.error ? { error: renderState.error } : {})
    }
    await persistWork(stateAdapter, work)
  }
  const outcome = await finalizeRender(client, durableRenderTarget(work), renderState)
  incr('googlechatbot_delivery_total', { outcome, source: 'recovery' })
  work.stage = 'final'
  await persistWork(stateAdapter, work)
  await updateThreadState(stateAdapter, work.event.thread_key, {
    activeExecution: false,
    lastEventId: work.lastEventId
  })
}

function durableRenderTarget(work: GoogleChatWorkObligation) {
  if (!work.event) throw new Error('Google Chat work is missing its normalized event')
  return {
    spaceName: work.event.space_name,
    ackMessageName: work.ackMessageName ?? '',
    threadName: work.event.chat.thread_name,
    fallbackMessageId: `client-centaur-${work.workId.replace(/-/g, '')}`
  }
}

export function googleChatWorkflowEvent(
  envelope: GoogleChatEnvelope,
  verifiedUserEmail?: string
): GoogleChatWorkflowEvent | null {
  const spaceName = envelope.space?.name
  const eventType = actionType(envelope)
  const legacyParameters = Object.fromEntries(
    (envelope.action?.parameters ?? [])
      .filter(parameter => parameter.key && parameter.value !== undefined)
      .map(parameter => [parameter.key as string, parameter.value])
  )
  const parameters = { ...legacyParameters, ...envelope.common?.parameters }
  const parameterFunction = ['__action_method_name__', 'actionName', 'invokedFunction', 'function']
    .map(key => parameters[key])
    .find(value => typeof value === 'string')
  const invokedFunction = envelope.common?.invokedFunction
    ?? envelope.action?.actionMethodName
    ?? (typeof parameterFunction === 'string' ? parameterFunction : undefined)
    ?? (eventType === 'app_command' ? envelope.appCommandMetadata?.appCommandId : undefined)
  if (!spaceName || !eventType || !invokedFunction) return null

  const threadName = envelope.message?.thread?.name ?? envelope.thread?.name
  const payload: GoogleChatActionPayload = {
    event_type: eventType,
    invoked_function: invokedFunction,
    ...(envelope.message?.name ? { message_name: envelope.message.name } : {}),
    ...(Object.keys(parameters).length ? { parameters } : {}),
    ...(envelope.common?.formInputs ? { form_inputs: envelope.common.formInputs } : {}),
    space_name: spaceName,
    ...(threadName ? { thread_name: threadName } : {}),
    ...(verifiedUserEmail ? { user_email: verifiedUserEmail } : {}),
    ...(envelope.user?.name ? { user_id: envelope.user.name } : {}),
    ...(envelope.user?.displayName ? { user_name: envelope.user.displayName } : {})
  }
  return { event_name: `google_chat.${eventType}.${invokedFunction}`, payload }
}

/** Compatibility helper retained for callers that only consume card clicks. */
export function googleChatCardClickPayload(envelope: GoogleChatEnvelope): GoogleChatActionPayload | null {
  const event = googleChatWorkflowEvent(envelope)
  return event?.payload.event_type === 'card_click' ? event.payload : null
}

function actionType(envelope: GoogleChatEnvelope): GoogleChatActionType | null {
  if (envelope.type === 'CARD_CLICKED' && envelope.dialogEventType === 'SUBMIT_DIALOG') {
    return 'submit_form'
  }
  if (envelope.type === 'CARD_CLICKED') return 'card_click'
  if (envelope.type === 'APP_COMMAND') return 'app_command'
  if (envelope.type === 'SUBMIT_FORM') return 'submit_form'
  return null
}

async function handleChatAction(config: AppConfig, event: GoogleChatWorkflowEvent): Promise<void> {
  const { payload } = event
  try {
    await emitWorkflowEvent(config, event.event_name, payload)
    incr('googlechatbot_card_clicks_total', { outcome: 'dispatched' })
  } catch (error) {
    incr('googlechatbot_card_clicks_total', { outcome: 'failed' })
    logError('googlechatbot_card_click_dispatch_failed', error, {
      invoked_function: payload.invoked_function,
      space_name: payload.space_name
    })
    throw error
  }
}

async function driveSession(
  config: AppConfig,
  client: ChatEdgeClient,
  runtime: BotRuntime,
  event: NormalizedChatEvent,
  ackMessageName: string,
  identity: IdentityContext,
  durableState: StateAdapter,
  work: GoogleChatWorkObligation
): Promise<void> {
  const threadKey = event.thread_key
  const { execute, history } = turnMessagesFromEvent(event)
  const threadState =
    (await durableState.get<GoogleChatThreadState>(threadStateKey(threadKey))) ?? {}
  if (threadState.executedMessageIds?.includes(execute.id)) {
    await removeAck(client, ackMessageName)
    incr('googlechatbot_dedupe_total', { outcome: 'thread_duplicate' })
    return
  }
  // Inline directives (--model, -rsn, --bedrock, --claude, ...) are stripped from
  // the prompt and applied to the harness/turn, matching the Slack integration.
  // GOOGLECHATBOT_MESSAGE_OVERRIDES_STRATEGY=llm swaps the literal-flag parser
  // for an LLM that also understands natural-language requests.
  const overrides = await runtime.messageOverrides(execute.text)
  execute.text = overrides.cleanedText
  // Explicit harness/model/provider selections are sticky per thread. Reasoning
  // remains a per-turn override and is deliberately not persisted.
  const spaceDefault = resolveSpaceDefault(runtime.spaceDefaults, threadKey)
  const resolvedHarnessType =
    overrides.harnessType ?? valueOrUndefined(threadState.harnessType) ?? spaceDefault?.harnessType
  const resolvedModel =
    overrides.model
    ?? (overrides.harnessType ? undefined : valueOrUndefined(threadState.model))
    ?? spaceDefault?.model
  const resolvedProvider =
    overrides.provider
    ?? (overrides.harnessType ? undefined : valueOrUndefined(threadState.provider))
    ?? spaceDefault?.provider
  const requestedHarnessType =
    resolvedHarnessType ?? config.GOOGLECHATBOT_DEFAULT_HARNESS ?? 'codex'
  const requestedModel =
    resolvedModel ?? defaultModelForHarness(requestedHarnessType, harnessDefaultModels(config))
  const resolvedReasoning = reasoningForModel(
    requestedHarnessType,
    requestedModel,
    overrides.reasoning ?? spaceDefault?.reasoning
  )
  incr('googlechatbot_runs_total', { outcome: 'started' })
  try {
    const session = await createSession(
      config,
      threadKey,
      conversationName(event),
      resolvedHarnessType ?? config.GOOGLECHATBOT_DEFAULT_HARNESS,
      {
        userId: event.user_id,
        userName: event.user_name,
        identity: {
          verified: identity.verified,
          ...(event.user_email ? { userEmail: event.user_email } : {}),
          spaceType: event.space_type,
          confirmSpace: () => identity.confirmSpace(event.space_name)
        }
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
      await updateThreadState(durableState, threadKey, {
        activeExecution: true,
        forwardedMessageIds: [
          ...(threadState.forwardedMessageIds ?? []),
          ...history.map(message => message.id),
          execute.id
        ]
      })
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
        overrides: {
          model: resolvedModel,
          provider: resolvedProvider,
          reasoning: resolvedReasoning
        },
        // Thread history rides the execute input itself (slackbotv2 parity):
        // messages appended via /messages are stored for the Console but never
        // reach the harness, and the harness's own conversation state dies
        // with its sandbox (pool drain/reap), so without this block any
        // follow-up after a sandbox swap starts from amnesia.
        history,
        // A/B provenance for the harness api-rs actually persisted, so the
        // execution metadata records the cohort (upstream #1178 parity).
        ...(session.harnessType ? { harnessType: session.harnessType } : {}),
        ...(session.harnessAssignment
          ? { harnessAssignment: session.harnessAssignment }
          : {})
      })
    } catch (error) {
      // The activeExecution check above is read-then-act: a run that starts
      // between the check and this execute makes api-rs reject the second
      // execute on its one-active-execution index (409 once api-rs types the
      // conflict; an opaque 500 on older servers). Re-check and fold into the
      // live run instead of erroring into the thread.
      const folded = await foldIntoActiveRun(config, client, threadKey, execute, ackMessageName, error, {
        conversationName: conversationName(event),
        harnessType: resolvedHarnessType ?? config.GOOGLECHATBOT_DEFAULT_HARNESS
      })
      if (folded) return
      throw error
    }
    await updateThreadState(durableState, threadKey, {
      activeExecution: true,
      executedMessageIds: [...(threadState.executedMessageIds ?? []), execute.id],
      forwardedMessageIds: [
        ...(threadState.forwardedMessageIds ?? []),
        ...history.map(message => message.id),
        execute.id
      ],
      ...(overrides.harnessType ? { harnessType: overrides.harnessType } : {}),
      ...(overrides.model
        ? { model: overrides.model }
        : overrides.harnessType ? { model: null } : {}),
      ...(overrides.provider
        ? { provider: overrides.provider }
        : overrides.harnessType ? { provider: null } : {})
    })
    work.executionId = execution.execution_id
    work.stage = 'rendering'
    await persistWork(durableState, work)
    // "Open chat in Console" trailer on the FIRST assistant message in a
    // thread (no earlier thread history = this event started the thread),
    // mirroring slackbotv2's console-session-link. Undefined when no Console
    // base URL is configured. `threadKey` (`chat:spaces:…`) is the exact value
    // sent to the session API as `thread_key`, which the Console indexes by.
    const isFirstAssistantMessage = !event.history_messages?.length
    // api-rs may route a Codex request onto Nanocodex (thread-key-hashed A/B
    // split, upstream #1178), so the harness that actually runs is the one the
    // create-session response reports -- not the one this turn asked for.
    // Showing the requested harness here would mislabel the cohort (#1179).
    const effectiveHarnessType =
      session.harnessType ?? resolvedHarnessType ?? config.GOOGLECHATBOT_DEFAULT_HARNESS
    // Without an explicit --model/--opus/... override the harness runs its
    // configured default (CLAUDE_MODEL/CODEX_MODEL, else the baked harness
    // config); show that instead of dropping the model entirely.
    const effectiveModel =
      resolvedModel ?? defaultModelForHarness(effectiveHarnessType, harnessDefaultModels(config))
    // Codex/Nanocodex run an effort level even when this turn asked for none;
    // show the one the harness actually applies (Nanocodex folds Minimal into
    // Low). Undefined for the Claude/Amp harnesses, which drop the segment.
    const effectiveReasoning = effectiveReasoningForHarness(
      effectiveHarnessType,
      resolvedReasoning,
      harnessDefaultReasoning(config)
    )
    const includeResponseMetadata =
      config.GOOGLECHATBOT_RESPONSE_METADATA_MODE === 'always' ||
      (config.GOOGLECHATBOT_RESPONSE_METADATA_MODE === 'first' && isFirstAssistantMessage)
    const consoleSessionWidget = isFirstAssistantMessage || includeResponseMetadata
      ? buildConsoleSessionWidget({
          consoleBaseUrl: isFirstAssistantMessage
            ? config.CENTAUR_CONSOLE_PUBLIC_URL
            : undefined,
          threadKey,
          harnessType: effectiveHarnessType,
          metadataEnabled: includeResponseMetadata,
          model: effectiveModel,
          reasoning: effectiveReasoning,
          serviceTier:
            config.GOOGLECHATBOT_RESPONSE_SERVICE_TIER_ENABLED && !resolvedProvider
              ? defaultServiceTierForHarness(effectiveHarnessType)
              : undefined
        })
      : undefined
    const target = {
      spaceName: event.space_name,
      ackMessageName,
      threadName: event.chat.thread_name,
      consoleSessionWidget,
      plainTextOnly: isPlainTextOnlyRequest(execute.text),
      fallbackMessageId: `client-centaur-${work.workId.replace(/-/g, '')}`
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
      work.lastEventId = lastEventId
      await persistWork(durableState, work)
      await updateThreadState(durableState, threadKey, { lastEventId })
      if (!state.terminal && attempt + 1 < MAX_RESUME_ATTEMPTS) {
        incr('googlechatbot_render_resumes_total')
        logWarn('googlechatbot_render_stream_resuming', {
          thread_key: threadKey,
          after_event_id: lastEventId,
          attempt: attempt + 1
        })
      }
    }
    work.canonicalFinal = { answer: state.answer, ...(state.error ? { error: state.error } : {}) }
    await persistWork(durableState, work)
    const deliveryOutcome = await finalizeRender(client, target, state)
    incr('googlechatbot_delivery_total', { outcome: deliveryOutcome, source: 'live' })
    work.stage = 'final'
    await persistWork(durableState, work)
    await updateThreadState(durableState, threadKey, { activeExecution: false, lastEventId })
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
    // Once the canonical answer is durable, a Chat PATCH/create failure is a
    // render obligation, not a new execution error. Leave it for recovery so
    // the exact answer is retried with the stable fallback message ID.
    if (work.canonicalFinal) throw error
    work.canonicalFinal = { answer: '', error: error instanceof Error ? error.message : String(error) }
    await persistWork(durableState, work)
    const delivered = await deliverDriveError(client, event, ackMessageName, error)
    if (!delivered) throw error
    work.stage = 'final'
    await persistWork(durableState, work)
    await updateThreadState(durableState, threadKey, { activeExecution: false })
  }
}

function valueOrUndefined(value: string | null | undefined): string | undefined {
  return value ?? undefined
}

function normalizedEventText(event: NormalizedChatEvent): string {
  return event.parts
    .map(part => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

async function handleStopCommand(
  config: AppConfig,
  client: ChatEdgeClient,
  event: NormalizedChatEvent
): Promise<void> {
  const threadKey = event.thread_key
  const requester = event.user_name || event.user_id || 'unknown user'
  const reason = `Interrupted from Google Chat by ${requester}`
  let text: string
  try {
    const response = await interruptSessionExecution(config, threadKey, reason)
    incr('googlechatbot_stop_commands_total', {
      outcome: response.interrupted ? 'interrupted' : 'no_active_run'
    })
    text = response.interrupted
      ? '⏹️ Stopped the current run.'
      : 'There is no active run in this thread to stop.'
  } catch (error) {
    incr('googlechatbot_stop_commands_total', { outcome: 'failed' })
    logError('googlechatbot_stop_command_failed', error)
    const detail = error instanceof Error ? error.message : String(error)
    text = clampPlainText(`⚠️ Couldn't stop the run: ${detail}`)
  }
  try {
    await client.createMessage(event.space_name, { text }, {
      threadName: event.chat.thread_name
    })
  } catch (deliverError) {
    logError('googlechatbot_stop_reply_failed', deliverError)
  }
}

async function deliverDriveError(
  client: ChatEdgeClient,
  event: NormalizedChatEvent,
  ackMessageName: string,
  error: unknown
): Promise<boolean> {
  const detail = error instanceof Error ? error.message : String(error)
  // Fit the complete serialized Message to Google's 32,000-byte limit so a long
  // upstream error cannot leave the user on "thinking".
  const text = clampPlainText(`⚠️ Centaur could not start this run: ${detail}`)
  try {
    if (ackMessageName) {
      await client.updateMessage(ackMessageName, { text, cardsV2: [] })
      incr('googlechatbot_delivery_total', { outcome: 'error_updated' })
      return true
    }
    await client.createMessage(event.space_name, { text }, {
      threadName: event.chat.thread_name
    })
    incr('googlechatbot_delivery_total', { outcome: 'error_created' })
    return true
  } catch (deliverError) {
    logError('googlechatbot_drive_error_delivery_failed', deliverError)
    incr('googlechatbot_delivery_total', { outcome: 'failed' })
    return false
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
    // Nanocodex runs off the same CODEX_MODEL deployment override as Codex.
    ...(config.CODEX_MODEL
      ? { codex: config.CODEX_MODEL, nanocodex: config.CODEX_MODEL }
      : {})
  }
}

/** Deployment default effort per harness, mirroring harnessDefaultModels. */
function harnessDefaultReasoning(config: AppConfig): Record<string, string> {
  const effort = config.CODEX_MODEL_REASONING_EFFORT
  return effort ? { codex: effort, nanocodex: effort } : {}
}

/** Human-readable conversation name for the api-rs session principal. */
function conversationName(event: NormalizedChatEvent): string | undefined {
  if (event.space_type === 'DIRECT_MESSAGE') return event.user_name || undefined
  return undefined
}

/** Google gives synchronous handlers 30 seconds. Durable acceptance and the
 * empty JSON response happen first; the turn runs afterward. */
function runInBackground(promise: Promise<void>): void {
  void promise.catch((error: unknown) => {
    logError('googlechatbot_event_processing_failed', error)
  })
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
  const commonEventObject = (parsed as { commonEventObject?: GoogleChatEnvelope['common'] })
    .commonEventObject
  const authorizationEventObject = (parsed as {
    authorizationEventObject?: GoogleChatEnvelope['authorizationEventObject']
  }).authorizationEventObject
  const chat = (parsed as { chat?: Record<string, unknown> }).chat
  if (chat && typeof chat === 'object') {
    const eventTime = chat.eventTime as string | undefined
    const user = chat.user as Record<string, unknown> | undefined
    const messagePayload = chat.messagePayload as { space?: unknown; message?: unknown } | undefined
    if (messagePayload) {
      return {
        type: 'MESSAGE',
        eventTime,
        authorizationEventObject,
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
        authorizationEventObject,
        user,
        space: addedToSpacePayload.space
      } as unknown as GoogleChatEnvelope
    }
    const removedFromSpacePayload = chat.removedFromSpacePayload as { space?: unknown } | undefined
    if (removedFromSpacePayload) {
      return {
        type: 'REMOVED_FROM_SPACE',
        eventTime,
        authorizationEventObject,
        user,
        space: removedFromSpacePayload.space
      } as unknown as GoogleChatEnvelope
    }
    const actionPayloads = [
      ['CARD_CLICKED', chat.buttonClickedPayload],
      ['APP_COMMAND', chat.appCommandPayload]
    ] as const
    for (const [type, rawPayload] of actionPayloads) {
      if (!rawPayload || typeof rawPayload !== 'object') continue
      const payload = rawPayload as Record<string, unknown>
      const metadata = payload.appCommandMetadata as GoogleChatEnvelope['appCommandMetadata']
        | undefined
      const effectiveType =
        type === 'CARD_CLICKED' && payload.dialogEventType === 'SUBMIT_DIALOG'
          ? 'SUBMIT_FORM'
          : type
      return {
        type: effectiveType,
        eventTime,
        authorizationEventObject,
        user,
        space: payload.space,
        message: payload.message,
        thread: payload.thread,
        common: commonEventObject,
        dialogEventType: payload.dialogEventType as string | undefined,
        appCommandMetadata: metadata
      } as unknown as GoogleChatEnvelope
    }
    return null
  }

  // v1 (legacy Chat API) envelope — pass through unchanged.
  return parsed as unknown as GoogleChatEnvelope
}

/** Enum-only observability: intentionally excludes names, IDs, text, params,
 * emails, and authorization values. */
function logChatEventShape(config: AppConfig, envelope: GoogleChatEnvelope): void {
  const eventTypes = new Set([
    'MESSAGE',
    'ADDED_TO_SPACE',
    'REMOVED_FROM_SPACE',
    'CARD_CLICKED',
    'APP_COMMAND',
    'SUBMIT_FORM',
    'WIDGET_UPDATED',
    'APP_HOME'
  ])
  const spaceTypes = new Set(['SPACE', 'GROUP_CHAT', 'DIRECT_MESSAGE', 'ROOM', 'DM'])
  const dialogEventTypes = new Set(['REQUEST_DIALOG', 'SUBMIT_DIALOG', 'CANCEL_DIALOG'])
  const eventType = envelope.type ?? ''
  const spaceType = envelope.space?.spaceType ?? envelope.space?.type ?? ''
  const dialogEventType = envelope.dialogEventType ?? ''
  logInfo('googlechatbot_event_shape', {
    ingress_mode: config.GOOGLECHATBOT_INGRESS_MODE,
    event_type: eventTypes.has(eventType) ? eventType : 'UNKNOWN',
    space_type: spaceTypes.has(spaceType) ? spaceType : 'UNKNOWN',
    has_message: Boolean(envelope.message),
    has_action: Boolean(envelope.action || envelope.common),
    dialog_event_type: dialogEventTypes.has(dialogEventType) ? dialogEventType : 'NONE'
  })
}

function envelopeWithoutTokens(envelope: GoogleChatEnvelope): GoogleChatEnvelope {
  if (!envelope.authorizationEventObject) return envelope
  const { authorizationEventObject: _tokens, ...safeEnvelope } = envelope
  return safeEnvelope
}
