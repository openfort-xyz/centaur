import { Buffer } from 'node:buffer'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { StateAdapter } from 'chat'
import { stopCardAction, type AppConfig } from './config'
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
import { isHarnessEnabled, resolveEnabledOverrides } from './harness-routing'
import { resolveSenderEmail } from './sender-lookup'
import { addGauge, incr, renderMetrics, setGauge } from './metrics'
import {
  LeaseLostError,
  acceptWork,
  acquireLease,
  assistantTurnMessage,
  clearStopControl,
  clearWorkStop,
  createDefaultState,
  ensureStateConnected,
  listPendingWorkIds,
  persistStopControl,
  persistWork,
  requestWorkStop,
  stopControlKey,
  threadStateKey,
  transcriptEntryFromTurn,
  transcriptHistoryMessages,
  updateThreadState,
  withThreadHandoff,
  workKey,
  workLeaseKey,
  workStopRequestedAt,
  type GoogleChatThreadState,
  type GoogleChatWorkObligation,
  type StateConnectionStatus,
  type StopControl
} from './state'
import {
  messageOverridesStrategyFromConfig,
  type MessageOverridesStrategy
} from './message-overrides-strategy'
import {
  createOpenAiProactiveClassifier,
  decideWithTimeout,
  type ProactiveClassifier,
  type ProactiveThreadMessage
} from './proactive-classifier'
import { startProactivePoller } from './proactive-poll'
import { resolveSpaceDefault, spaceDefaultsFromConfig, type SpaceDefaults } from './space-defaults'
import {
  buildResponseContextWidget,
  personaFallbackNotice,
  defaultModelForHarness,
  effectiveReasoningForHarness,
  defaultServiceTierForHarness,
  reasoningForModel
} from './response-context'
import { chatReplyLimits } from './constants'
import { canFoldIntoActiveRun } from './fold-guard'
import {
  BUSY_STATUS,
  INITIAL_STATUS,
  STEERING_STATUS,
  STOP_CARD_FUNCTION,
  consumeRenderStream,
  createRenderState,
  finalizeRender,
  stopControlCards
} from './renderer'
import {
  type GoogleChatTurnMessage,
  type InterruptSessionResponse,
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

/** Contextual replies: the classifier and the exact spaces it applies to. */
export type ProactivityRuntime = {
  classifier: ProactiveClassifier
  spaces: readonly string[]
  timeoutMs: number
}

/** Config-derived values resolved once at startup and reused for every turn. */
type BotRuntime = {
  messageOverrides: MessageOverridesStrategy
  spaceDefaults: SpaceDefaults
  proactivity?: ProactivityRuntime
  /** Flipped when Google rejects the delegated reaction actor, so one
   * misconfigured scope costs one failed call per process, not one per turn. */
  reactionsDisabled: boolean
  /** Background work started by webhooks, polling, and recovery; drained on
   * shutdown so a reply in flight is not abandoned mid-render. */
  background: Set<Promise<unknown>>
  /** Obligations this process is driving, by work id, so a sweep neither
   * re-launches them nor waits behind them. */
  inFlightWork: Map<string, Promise<void>>
  shuttingDown: boolean
}

/** Obligations a recovery sweep drives at once. A hung stream occupies one
 * slot; the rest of the backlog keeps moving. */
const RECOVERY_CONCURRENCY = 8

const PROACTIVE_HISTORY_MESSAGES = 20
const BOT_DISPLAY_NAME = 'Centaur'
const STOPPED_BEFORE_START_TEXT = '⏹️ Stopped before the run started.'

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
  /** Stop recurring work (recovery sweeps, polling), fail readiness, and wait
   * up to `timeoutMs` for in-flight turns. Returns how many are still running. */
  shutdown: (timeoutMs: number) => Promise<number>
}

export function createGooglechatbot(
  config: AppConfig,
  options: { state?: StateAdapter; proactivity?: ProactivityRuntime } = {}
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
  const proactivity = options.proactivity ?? proactivityFromConfig(config)
  const runtime: BotRuntime = {
    messageOverrides: messageOverridesStrategyFromConfig(config),
    spaceDefaults: spaceDefaultsFromConfig(config),
    ...(proactivity ? { proactivity } : {}),
    reactionsDisabled: false,
    background: new Set(),
    inFlightWork: new Map(),
    shuttingDown: false
  }
  const runInBackground = (promise: Promise<void>): void => {
    runtime.background.add(promise)
    const settle = () => runtime.background.delete(promise)
    void promise.then(settle, (error: unknown) => {
      settle()
      logError('googlechatbot_event_processing_failed', error)
    })
  }
  const launchWork = (work: GoogleChatWorkObligation, source: 'live' | 'recovery'): Promise<void> => {
    const inFlight = runtime.inFlightWork.get(work.workId)
    if (inFlight) return inFlight
    const promise = processWorkObligation(config, client, runtime, state, spaceVerifier, work, source)
      .finally(() => runtime.inFlightWork.delete(work.workId))
    runtime.inFlightWork.set(work.workId, promise)
    runInBackground(promise)
    return promise
  }

  const app = new Hono()

  const ready = () => stateStatus.connected && !runtime.shuttingDown
  app.get('/health/live', c =>
    c.json({ ok: true, service: 'googlechatbot', commit: process.env.COMMIT_SHA ?? 'local' })
  )
  app.get('/health/ready', c =>
    c.json(
      {
        ok: ready(),
        service: 'googlechatbot',
        database_connected: stateStatus.connected,
        database_connect_attempts: stateStatus.attempts,
        shutting_down: runtime.shuttingDown
      },
      ready() ? 200 : 503
    )
  )
  // Compatibility path remains readiness, never liveness.
  app.get('/health', c =>
    c.json({ ok: ready(), service: 'googlechatbot' }, ready() ? 200 : 503)
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

    // Identity: the Add-on user token when Google sends one, else the
    // directory email of the Google-signed sender id. Both pass the domain
    // allowlist below and both reach api-rs as the requester of this turn.
    const userEmail = tokenCheck.userEmail ?? await resolveSenderEmail({
      lookup: userName => client.lookupSenderEmail(userName),
      verified: tokenCheck.verified,
      ingressMode: config.GOOGLECHATBOT_INGRESS_MODE,
      envelope
    })
    const verification = verifyChatRequest({
      config,
      envelope,
      userEmail,
      userId: tokenCheck.userId
    })
    if (!verification.ok) {
      incr('googlechatbot_events_total', { outcome: 'rejected' })
      logWarn('googlechatbot_event_rejected', { reason: verification.reason })
      return c.json({}, verification.status)
    }

    logChatEventShape(config, envelope)
    const action = googleChatWorkflowEvent(envelope, userEmail)
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
        ...(userEmail ? { identityUserEmail: userEmail } : {}),
        lastEventId: 0,
        stage: 'accepted',
        workId: randomUUID()
      }
      // Durable acceptance precedes the synchronous 200. A process crash after
      // this write is recovered by the startup sweep; Google need not redeliver.
      await acceptWork(state, work)
      await deduper.complete(key)
      addGauge('googlechatbot_pending_render_obligations', 1)
      incr('googlechatbot_events_total', { outcome: 'accepted' })
      incr('googlechatbot_dedupe_total', { outcome: 'accepted' })
      void launchWork(work, 'live')
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

  const stoppers: Array<() => void> = []
  runInBackground(stateConnected.then(() => {
    stoppers.push(startRecoverySweeps(config, runtime, state, launchWork))
    if (runtime.proactivity) {
      stoppers.push(startProactivePoller({
        client,
        config,
        deduper,
        spaces: runtime.proactivity.spaces,
        state,
        enqueue: work => {
          addGauge('googlechatbot_pending_render_obligations', 1)
          void launchWork(work, 'live')
        }
      }))
    }
  }))

  const shutdown = async (timeoutMs: number): Promise<number> => {
    runtime.shuttingDown = true
    for (const stop of stoppers) stop()
    const deadline = Date.now() + timeoutMs
    while (runtime.background.size > 0 && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled(runtime.background),
        new Promise(resolve => {
          timer = setTimeout(resolve, deadline - Date.now())
        })
      ])
      clearTimeout(timer)
    }
    return runtime.background.size
  }

  return { app, client, state, stateConnected, stateStatus, shutdown }
}

function proactivityFromConfig(config: AppConfig): ProactivityRuntime | undefined {
  if (!config.GOOGLECHATBOT_PROACTIVITY_ENABLED) return undefined
  // loadConfig already required the key and the space list.
  const apiKey = config.GOOGLECHATBOT_PROACTIVITY_OPENAI_API_KEY || config.OPENAI_API_KEY || ''
  return {
    classifier: createOpenAiProactiveClassifier({
      apiKey,
      baseUrl: config.GOOGLECHATBOT_PROACTIVITY_OPENAI_BASE_URL,
      model: config.GOOGLECHATBOT_PROACTIVITY_MODEL
    }),
    spaces: config.GOOGLECHATBOT_PROACTIVITY_SPACES,
    timeoutMs: config.GOOGLECHATBOT_PROACTIVITY_TIMEOUT_MS
  }
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
  // credential-bearing diagnostics. The stable event, the error class, and the
  // request's own space/credential kind/upstream status suffice — never the
  // subject email, the token, or the response body.
  const spaceId = c.req.param('spaceId')
  const space = spaceId ? spaceResource(spaceId) : null
  logError(event, {
    error_name: error instanceof Error ? error.name : 'unknown',
    ...(space ? { space } : {}),
    credential: c.req.header(DWD_SUBJECT_HEADER)
      ? 'delegated-etl-reader'
      : c.req.query('impersonate')
        ? 'impersonate'
        : 'app',
    ...(error instanceof ChatApiError ? { status: error.status } : {})
  })
  return c.json({ error: 'Google Chat request failed' }, 502)
}

/** What an accepted obligation is, decided before any thread lease is taken so
 * a cancellation never queues behind the render it is meant to interrupt. */
type WorkKind = 'action' | 'stop-card' | 'stop-text' | 'turn'

async function classifyWork(
  config: AppConfig,
  runtime: BotRuntime,
  state: StateAdapter,
  work: GoogleChatWorkObligation
): Promise<WorkKind> {
  if (!work.action && work.envelope) {
    work.action = googleChatWorkflowEvent(work.envelope, work.identityUserEmail) ?? undefined
  }
  if (work.action) {
    return work.action.payload.invoked_function === STOP_CARD_FUNCTION ? 'stop-card' : 'action'
  }
  // A cheap, non-persisted normalization (no attachment downloads) is enough
  // to recognize a stop; the turn path normalizes again with the client.
  const probe = work.event ?? (work.envelope ? await normalizeChatEnvelope(work.envelope) : null)
  if (!probe || work.eventType === 'ADDED_TO_SPACE') return 'turn'
  if (!isChatStopCommand(normalizedEventText(probe))) return 'turn'
  if (probe.is_mention || (config.GOOGLECHATBOT_FOLLOW_UP_THREADS && isThreadReply(probe))) {
    return 'stop-text'
  }
  // An unmentioned "stop" in a thread that is answering without mentions ends
  // that participation; it is never worth a classifier call.
  if (runtime.proactivity && proactiveSpaceAllowed(runtime.proactivity, probe.space_name)) {
    const threadState = await state.get<GoogleChatThreadState>(threadStateKey(probe.thread_key))
    if (threadState?.proactiveEligible === true) return 'stop-text'
  }
  return 'turn'
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
  const loaded = (await state.get<GoogleChatWorkObligation>(workKey(initial.workId))) ?? initial
  const kind = await classifyWork(config, runtime, state, loaded)
  // One lease per obligation: it keeps live and recovery processing of this
  // work exclusive and nothing more. Thread-level ordering lives in the
  // handoff lock, so this lease can be held through rendering without
  // blocking a later message's append or a stop.
  const lease = await acquireLease(state, workLeaseKey(loaded.workId), 120_000, 60_000)
  if (!lease) {
    incr('googlechatbot_recovery_total', { outcome: 'lease_skipped', source })
    return
  }
  try {
    const work = (await state.get<GoogleChatWorkObligation>(workKey(initial.workId))) ?? loaded
    const age = Date.now() - Date.parse(work.acceptedAt)
    if (
      !Number.isFinite(age)
      || age > config.GOOGLECHATBOT_RECOVERY_MAX_OBLIGATION_AGE_MS
      || work.failures >= config.GOOGLECHATBOT_RECOVERY_FAILURE_BUDGET
    ) {
      await finishWork(client, state, work)
      incr('googlechatbot_recovery_total', { outcome: 'abandoned', source })
      return
    }

    if (kind === 'action' || kind === 'stop-card') {
      if (kind === 'stop-card') await handleStopCard(config, client, state, work)
      else await handleChatAction(config, work.action!)
      await state.set(
        `googlechatbot:dedupe:${work.dedupeKey}`,
        'completed',
        config.CHAT_EVENT_DEDUP_TTL_MS
      )
      await finishWork(client, state, work)
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
      await finishWork(client, state, work)
      return
    }
    if (kind === 'stop-text') {
      await handleStopCommand(config, client, state, event)
      await finishWork(client, state, work)
      return
    }
    if (work.eventType === 'ADDED_TO_SPACE') {
      await client.createMessage(event.space_name, { text: WELCOME_TEXT })
      await finishWork(client, state, work)
      return
    }
    const followUp = config.GOOGLECHATBOT_FOLLOW_UP_THREADS && isThreadReply(event)
    if (!event.is_mention && !followUp && !work.proactive) {
      // A decision is made once; a recovered obligation keeps its answer.
      if (!(await shouldReplyProactively(config, client, runtime, state, work, event))) {
        await finishWork(client, state, work)
        return
      }
      work.proactive = true
      await persistWork(state, work)
    } else if (work.proactive && !work.ackMessageName && !(await proactivePermitted(
      runtime, (await state.get<GoogleChatThreadState>(threadStateKey(event.thread_key))) ?? {}, event
    ))) {
      // A stored positive decision is not authorization: the current
      // policy (feature, exact space, thread opt-in, generation) decides.
      incr('googlechatbot_proactive_decisions_total', { outcome: 'skip_policy' })
      await finishWork(client, state, work)
      return
    }

    if (!work.ackMessageName) {
      const messageId = `client-centaur-ack-${work.workId.replace(/-/g, '')}`
      try {
        const ack = await client.createMessage(
          event.space_name,
          { text: INITIAL_STATUS, cardsV2: stopControlCards(stopCardAction(config)) },
          { messageId, threadName: event.chat.thread_name }
        )
        work.ackMessageName = ack.name ?? `${event.space_name}/messages/${messageId}`
      } catch (error) {
        if (!(error instanceof ChatApiError) || error.status !== 409) throw error
        work.ackMessageName = `${event.space_name}/messages/${messageId}`
      }
      work.stage = 'thinking'
      await persistWork(state, work)
      await addAckReaction(client, config, runtime, state, work, event)
    }

    if (work.stage === 'final') {
      await finishWork(client, state, work)
      return
    }
    // Re-bind the Stop button on every pass (idempotent) so a crash between
    // the acknowledgement and this write still yields a working button.
    await persistStopControl(state, work.ackMessageName, {
      workId: work.workId,
      threadKey: event.thread_key,
      spaceName: event.space_name
    })
    if (work.executionId || work.canonicalFinal) {
      await recoverFinalRender(config, client, state, work, lease.lost)
      await finishWork(client, state, work)
      incr('googlechatbot_recovery_total', { outcome: 'completed', source })
      return
    }

    // Replay retained DM turns without a Google history read. Shared spaces
    // fetch thread history because unmentioned messages may not reach the bot.
    const history = event.space_type === 'DIRECT_MESSAGE'
      ? transcriptHistoryMessages(
          (await state.get<GoogleChatThreadState>(threadStateKey(event.thread_key)))?.transcript,
          event.message_id
        )
      : await sharedThreadHistory(config, client, work, event)
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
      work,
      lease.lost
    )
    await finishWork(client, state, work)
    incr('googlechatbot_recovery_total', { outcome: 'completed', source })
  } catch (error) {
    if (error instanceof LeaseLostError) {
      // A successor owns this work now; it must not be finished or counted
      // against the failure budget from here.
      incr('googlechatbot_recovery_total', { outcome: 'lease_lost', source })
      logWarn('googlechatbot_work_lease_lost', { source, work_id: initial.workId })
      return
    }
    const work = (await state.get<GoogleChatWorkObligation>(workKey(initial.workId))) ?? initial
    work.failures += 1
    await persistWork(state, work).catch(() => undefined)
    incr('googlechatbot_recovery_total', { outcome: 'failed', source })
    logError('googlechatbot_work_failed', error, { source, work_id: initial.workId })
  } finally {
    await lease.release()
  }
}

async function sharedThreadHistory(
  config: AppConfig,
  client: ChatEdgeClient,
  work: GoogleChatWorkObligation,
  event: NormalizedChatEvent
): Promise<NonNullable<NormalizedChatEvent['history_messages']>> {
  return collectThreadHistory(client, {
    spaceName: event.space_name,
    threadName: event.chat.thread_name,
    currentMessageName: event.message_id,
    threadReply: event.chat.thread_reply,
    botUserName: work.envelope ? mentionedChatAppUserName(work.envelope) : undefined,
    historyLimit: config.GOOGLECHATBOT_THREAD_HISTORY_LIMIT
  }).catch(error => {
    logWarn('googlechatbot_thread_history_failed', error)
    return []
  })
}

/** Every path through an obligation ends here, so this is where the delegated
 * reaction (if any) comes off the original message, whatever the outcome. */
async function finishWork(
  client: ChatEdgeClient,
  state: StateAdapter,
  work: GoogleChatWorkObligation
): Promise<void> {
  if (work.ackReactionName) {
    const reactionName = work.ackReactionName
    try {
      await client.deleteReaction(reactionName)
      incr('googlechatbot_reactions_total', { operation: 'delete', outcome: 'ok' })
    } catch (error) {
      incr('googlechatbot_reactions_total', { operation: 'delete', outcome: 'failed' })
      logWarn('googlechatbot_ack_reaction_delete_failed', error, { work_id: work.workId })
    }
  }
  await state.delete(workKey(work.workId))
  await clearWorkStop(state, work.workId).catch(() => undefined)
  addGauge('googlechatbot_pending_render_obligations', -1)
}

/** React to the message that starts a turn as the delegated actor. Never
 * blocks the turn: without an actor, or on any failure, the thinking
 * acknowledgement remains the only signal. */
async function addAckReaction(
  client: ChatEdgeClient,
  config: AppConfig,
  runtime: BotRuntime,
  state: StateAdapter,
  work: GoogleChatWorkObligation,
  event: NormalizedChatEvent
): Promise<void> {
  const emoji = config.GOOGLECHATBOT_ACK_REACTION.trim()
  if (!emoji || runtime.reactionsDisabled || !client.canWriteReactions()) return
  if (!/^spaces\/[^/]+\/messages\/[^/]+$/.test(event.message_id)) return
  try {
    const reaction = await client.createReaction(event.message_id, emoji)
    if (!reaction.name) return
    work.ackReactionName = reaction.name
    await persistWork(state, work)
    incr('googlechatbot_reactions_total', { operation: 'create', outcome: 'ok' })
  } catch (error) {
    if (error instanceof ChatApiError && error.status === 403) {
      // The actor lacks chat.messages.reactions (or is not in the space).
      // One failed call per process is enough to learn that.
      runtime.reactionsDisabled = true
      logWarn('googlechatbot_ack_reaction_auto_disabled', { status: error.status })
    } else {
      logWarn('googlechatbot_ack_reaction_create_failed', error, { work_id: work.workId })
    }
    incr('googlechatbot_reactions_total', { operation: 'create', outcome: 'failed' })
  }
}

export async function recoverWorkObligations(
  config: AppConfig,
  runtime: BotRuntime,
  state: StateAdapter,
  launch: (work: GoogleChatWorkObligation, source: 'recovery') => Promise<void>
): Promise<void> {
  const ids = await listPendingWorkIds(state, stateKeyPrefix(state, config))
  const pending: GoogleChatWorkObligation[] = []
  for (const id of ids) {
    const work = await state.get<GoogleChatWorkObligation>(workKey(id))
    if (work) pending.push(work)
  }
  setGauge('googlechatbot_pending_render_obligations', pending.length)
  incr('googlechatbot_recovery_total', { outcome: 'scan' })
  for (const work of pending) {
    if (runtime.shuttingDown) return
    if (runtime.inFlightWork.has(work.workId)) continue
    // Bounded fan-out: launch up to RECOVERY_CONCURRENCY obligations and let
    // them run in the background; the scan itself never waits on a render.
    while (runtime.inFlightWork.size >= RECOVERY_CONCURRENCY) {
      await Promise.race(runtime.inFlightWork.values()).catch(() => undefined)
    }
    void launch(work, 'recovery')
  }
}

/** The adapter's own prefix when it exposes one (an injected test adapter can
 * differ from the deployment value), else the configured prefix. */
function stateKeyPrefix(state: StateAdapter, config: AppConfig): string {
  const prefix = (state as { keyPrefix?: unknown }).keyPrefix
  return typeof prefix === 'string' && prefix ? prefix : config.GOOGLECHATBOT_STATE_KEY_PREFIX
}

function startRecoverySweeps(
  config: AppConfig,
  runtime: BotRuntime,
  state: StateAdapter,
  launch: (work: GoogleChatWorkObligation, source: 'recovery') => Promise<void>
): () => void {
  let running = false
  const sweep = async () => {
    if (running || runtime.shuttingDown) return
    running = true
    try {
      await recoverWorkObligations(config, runtime, state, launch)
    } finally {
      running = false
    }
  }
  void sweep().catch(error => {
    logError('googlechatbot_recovery_sweep_failed', error)
  })
  const timer = setInterval(() => void sweep().catch(error => {
    logError('googlechatbot_recovery_sweep_failed', error)
  }), config.GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

async function recoverFinalRender(
  config: AppConfig,
  client: ChatEdgeClient,
  stateAdapter: StateAdapter,
  work: GoogleChatWorkObligation,
  leaseLost: AbortSignal
): Promise<void> {
  if (!work.event) throw new Error('Google Chat work is missing its normalized event')
  const renderState = createRenderState()
  const target = durableRenderTarget(config, stateAdapter, work)
  if (work.canonicalFinal) {
    renderState.answer = work.canonicalFinal.answer
    renderState.error = work.canonicalFinal.error
    renderState.terminal = true
    renderState.mapper = { process: () => [], flush: () => [] } as unknown as typeof renderState.mapper
  } else {
    let lastEventId = 0
    for (let attempt = 0; attempt < MAX_RESUME_ATTEMPTS && !renderState.terminal; attempt += 1) {
      leaseLost.throwIfAborted()
      const stream = await openSessionEventStream(
        config,
        work.event.thread_key,
        lastEventId,
        work.executionId,
        id => {
          lastEventId = Math.max(lastEventId, id)
        }
      )
      await consumeRenderStream(client, stream, target, renderState)
    }
    leaseLost.throwIfAborted()
    work.lastEventId = lastEventId
    if (!renderState.terminal) renderState.error ??= renderState.streamError
    work.canonicalFinal = {
      answer: renderState.answer,
      ...(renderState.error ? { error: renderState.error } : {})
    }
    await persistWork(stateAdapter, work)
  }
  leaseLost.throwIfAborted()
  await clearStopControl(stateAdapter, target.ackMessageName)
  const outcome = await finalizeRender(client, target, renderState)
  incr('googlechatbot_delivery_total', { outcome, source: 'recovery' })
  work.stage = 'final'
  await persistWork(stateAdapter, work)
  await recordAssistantFinal(config, stateAdapter, work.event, target, {
    outcome,
    answer: renderState.answer
  })
  await finishThreadRun(client, stateAdapter, work.event.thread_key, {
    lastEventId: work.lastEventId
  })
}

function durableRenderTarget(config: AppConfig, state: StateAdapter, work: GoogleChatWorkObligation) {
  if (!work.event) throw new Error('Google Chat work is missing its normalized event')
  const ackMessageName = work.ackMessageName ?? ''
  return {
    spaceName: work.event.space_name,
    ackMessageName,
    threadName: work.event.chat.thread_name,
    fallbackMessageId: `client-centaur-${work.workId.replace(/-/g, '')}`,
    liveCards: () => liveStopCards(config, state, ackMessageName)
  }
}

/** The Stop button stays on the acknowledgement only while its binding exists;
 * a stop or a final deletes the binding, so the next status edit drops it. */
async function liveStopCards(
  config: AppConfig,
  state: StateAdapter,
  ackMessageName: string
): Promise<ReturnType<typeof stopControlCards>> {
  if (!ackMessageName) return []
  const control = await state.get<StopControl>(stopControlKey(ackMessageName)).catch(() => null)
  return control ? stopControlCards(stopCardAction(config)) : []
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
  const parameterFunction = ['__action_method_name__', 'actionName', 'method', 'invokedFunction', 'function']
    .map(key => parameters[key])
    .find(value => typeof value === 'string')
  // A Workspace Add-on click echoes the app's endpoint URL as the invoked
  // function and carries the real name as a parameter; the URL can never
  // mask or stand in for that name.
  const invokedFunction = nonUrlFunctionName(envelope.common?.invokedFunction)
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

function nonUrlFunctionName(value: string | undefined): string | undefined {
  if (!value || /^https?:\/\//i.test(value)) return undefined
  return value
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

/** The handoff decision for one accepted message, made under the thread's
 * handoff lock: start an execution (and then render it outside the lock), or
 * end here because the message steered, was refused, was stopped, or was an
 * unmentioned reply that found a run already active. */
type StartedTurn = {
  execution: { execution_id: string }
  session: Awaited<ReturnType<typeof createSession>>
  execute: GoogleChatTurnMessage
  overrides: Awaited<ReturnType<MessageOverridesStrategy>>
  spaceDefault: ReturnType<typeof resolveSpaceDefault>
  resolvedHarnessType: string | undefined
  resolvedModel: string | undefined
  resolvedProvider: string | undefined
  turnReasoning: string | undefined
}

async function driveSession(
  config: AppConfig,
  client: ChatEdgeClient,
  runtime: BotRuntime,
  event: NormalizedChatEvent,
  ackMessageName: string,
  identity: IdentityContext,
  durableState: StateAdapter,
  work: GoogleChatWorkObligation,
  leaseLost: AbortSignal
): Promise<void> {
  const threadKey = event.thread_key
  incr('googlechatbot_runs_total', { outcome: 'started' })
  try {
    // Session create, the active-execution check, and append-or-execute are
    // one serialized decision per thread. Rendering below runs outside the
    // lock, so a later mention can reach this execution while it streams.
    const started = await withThreadHandoff(durableState, threadKey, lost =>
      handoffTurn(config, client, runtime, event, ackMessageName, identity, durableState, work, lost)
    )
    if (!started) return
    await renderTurn(config, client, event, ackMessageName, durableState, work, leaseLost, started)
  } catch (error) {
    if (error instanceof LeaseLostError) throw error
    incr('googlechatbot_runs_total', { outcome: 'failed' })
    incr('centaur_session_delivery_total', { delivery_status: 'failed' })
    logError('googlechatbot_session_drive_failed', error)
    // Once the canonical answer is durable, a Chat PATCH/create failure is a
    // render obligation, not a new execution error. Leave it for recovery so
    // the exact answer is retried with the stable fallback message ID.
    if (work.canonicalFinal) throw error
    work.canonicalFinal = { answer: '', error: error instanceof Error ? error.message : String(error) }
    await persistWork(durableState, work)
    await clearStopControl(durableState, ackMessageName)
    const delivered = await deliverDriveError(client, event, ackMessageName, error)
    if (!delivered) throw error
    work.stage = 'final'
    await persistWork(durableState, work)
    await finishThreadRun(client, durableState, threadKey)
  }
}

async function handoffTurn(
  config: AppConfig,
  client: ChatEdgeClient,
  runtime: BotRuntime,
  event: NormalizedChatEvent,
  ackMessageName: string,
  identity: IdentityContext,
  durableState: StateAdapter,
  work: GoogleChatWorkObligation,
  handoffLost: AbortSignal
): Promise<StartedTurn | undefined> {
  const threadKey = event.thread_key
  const { execute, history } = turnMessagesFromEvent(event)
  const threadState =
    (await durableState.get<GoogleChatThreadState>(threadStateKey(threadKey))) ?? {}
  // Every exit that starts no execution of its own also drops the Stop
  // binding this acknowledgement was created with.
  const noRun = async () => {
    await clearStopControl(durableState, ackMessageName)
    return undefined
  }
  if (threadState.executedMessageIds?.includes(execute.id)) {
    await removeAck(client, ackMessageName)
    incr('googlechatbot_dedupe_total', { outcome: 'thread_duplicate' })
    return noRun()
  }
  if (work.proactive && !proactivePermitted(runtime, threadState, event)) {
    // A stored positive decision is not authorization: the feature, the
    // exact space list, the thread's opt-in (a stop clears it), and the
    // generation (a run started since) are all re-checked here, under the
    // lock, before any execution. Context for the next turn, never its own.
    await skipProactiveTurn(client, ackMessageName, threadKey, execute.id)
    return noRun()
  }
  // A mention (never an unmentioned reply) opts the thread into contextual
  // replies until a stop. DMs are always addressed, so they never need it. A
  // mention older than the thread's latest stop cannot undo that stop, so the
  // opt-in is decided against the freshest state at the point it is written.
  const sentAt = eventTimeMs(event, work)
  const eligibilityFor = (current: GoogleChatThreadState): Partial<GoogleChatThreadState> =>
    runtime.proactivity
    && event.is_mention
    && event.space_type !== 'DIRECT_MESSAGE'
    && proactiveSpaceAllowed(runtime.proactivity, event.space_name)
    && sentAt > (current.stopRequestedAt ?? 0)
      ? { proactiveEligible: true, proactiveEligibleAt: sentAt }
      : {}
  const eligibility = eligibilityFor(threadState)
  // Inline directives (--model, -rsn, --bedrock, --claude, ...) are stripped from
  // the prompt and applied to the harness/turn, matching the Slack integration.
  // GOOGLECHATBOT_MESSAGE_OVERRIDES_STRATEGY=llm swaps the literal-flag parser
  // for an LLM that also understands natural-language requests.
  const overrides = await runtime.messageOverrides(execute.text)
  execute.text = overrides.cleanedText
  // Explicit harness/model/provider selections are sticky per thread. Reasoning
  // remains a per-turn override and is deliberately not persisted.
  const spaceDefault = resolveSpaceDefault(runtime.spaceDefaults, threadKey)
  let resolvedHarnessType =
    overrides.harnessType ?? valueOrUndefined(threadState.harnessType) ?? spaceDefault?.harnessType
  let resolvedModel =
    overrides.model
    ?? (overrides.harnessType ? undefined : valueOrUndefined(threadState.model))
    ?? spaceDefault?.model
  let resolvedProvider =
    overrides.provider
    ?? (overrides.harnessType ? undefined : valueOrUndefined(threadState.provider))
    ?? spaceDefault?.provider
  const selectedOverrides = {
    harnessType: resolvedHarnessType,
    model: resolvedModel,
    provider: resolvedProvider
  }
  const enabledOverrides = resolveEnabledOverrides(
    selectedOverrides, config.GOOGLECHATBOT_DEFAULT_HARNESS, config.GOOGLECHATBOT_ENABLED_HARNESSES
  )
  const disabledHarnessReset = enabledOverrides !== selectedOverrides
  resolvedHarnessType = enabledOverrides.harnessType
  resolvedModel = enabledOverrides.model
  resolvedProvider = enabledOverrides.provider
  const pinnedPersonaId = Object.hasOwn(threadState, 'personaId')
    ? valueOrUndefined(threadState.personaId)
    : overrides.personaId ?? spaceDefault?.personaId
  const requestedHarnessType =
    resolvedHarnessType ?? config.GOOGLECHATBOT_DEFAULT_HARNESS ?? 'codex'
  const harnessDefaultModel = defaultModelForHarness(
    requestedHarnessType,
    harnessDefaultModels(config)
  )
  const requestedModel = resolvedModel ?? harnessDefaultModel
  const resolvedReasoning = reasoningForModel(
    requestedHarnessType,
    requestedModel,
    overrides.reasoning ?? spaceDefault?.reasoning
  )
  const session = await createSession(
    config,
    threadKey,
    conversationName(event),
    requestedHarnessType,
    {
      userId: event.user_id,
      userName: event.user_name,
      identity: {
        verified: identity.verified,
        ...(event.user_email ? { userEmail: event.user_email } : {}),
        spaceType: event.space_type,
        confirmSpace: () => identity.confirmSpace(event.space_name)
      }
    },
    {
      // api-rs pins the first persisted persona for the thread's lifetime;
      // re-sending the pinned one keeps it across a harness restart.
      ...(pinnedPersonaId ? { personaId: pinnedPersonaId } : {}),
      restartOnHarnessConflict: Boolean(overrides.harnessType)
    }
  )

  // A stop recorded after this message was sent, or a Stop card bound to this
  // very obligation, means the message must neither start a run nor steer an
  // existing one. Stop intent is written without the handoff lock, so it is
  // re-read after the session call. A stopped turn never opts the thread in;
  // it ends contextual participation for its own generation (a mention sent
  // after this one keeps its opt-in) and raises the cutoff to its own time.
  handoffLost.throwIfAborted()
  const latest = (await durableState.get<GoogleChatThreadState>(threadStateKey(threadKey))) ?? {}
  if (work.proactive && !proactivePermitted(runtime, latest, event)) {
    // A stop or a newer turn may have landed while the session call was held.
    await skipProactiveTurn(client, ackMessageName, threadKey, execute.id)
    return noRun()
  }
  const cardStopAt = await workStopRequestedAt(durableState, work.workId)
  if (stopRequestedFor(latest, event, work) || cardStopAt !== null) {
    // The cutoff is the STOP's own time (text: already in the thread state;
    // card: the click's event time carried by the work-scoped marker), never
    // this message's or the processing time: a mention sent after this one
    // but before the stop must not run either, while one sent after the
    // stop still runs and opts in.
    const stopAt = Math.max(latest.stopRequestedAt ?? 0, cardStopAt ?? 0)
    // Only the thread's current generation may promote its card's stop to
    // thread state. Once a message newer than this one has executed or opted
    // the thread in, this work is finalized as cancelled with no thread-wide
    // effect: a stale card, even recovered later, cannot touch its successor.
    // Ownership, not only clock order: this work never executed (or is not
    // the active execution), so while another execution is active the thread
    // is someone else's generation, even when timestamps tie or truncate.
    const superseded =
      (latest.lastExecutedAt ?? 0) > sentAt
      || (latest.proactiveEligibleAt ?? 0) > sentAt
      || (work.executionId
        ? latest.activeExecutionId !== work.executionId
        : latest.activeExecution === true)
    await clearStopControl(durableState, ackMessageName)
    await deliverStoppedBeforeStart(client, ackMessageName)
    await updateThreadState(durableState, threadKey, {
      executedMessageIds: [execute.id],
      ...(superseded ? {} : { stopRequestedAt: stopAt }),
      ...(!superseded && (latest.proactiveEligibleAt ?? 0) <= stopAt ? { proactiveEligible: false } : {}),
      ...dmTranscriptUpdate(event, execute)
    }, config.GOOGLECHATBOT_THREAD_HISTORY_LIMIT)
    work.stage = 'final'
    await persistWork(durableState, work)
    incr('googlechatbot_runs_total', { outcome: 'stopped_before_start' })
    return undefined
  }

  // Append only unforwarded messages to the active execution. Replaying the
  // full DM transcript here would steer old turns again. Keep a steering
  // notice until the active execution delivers its answer.
  const forwarded = new Set(threadState.forwardedMessageIds ?? [])
  const appended = [...history, execute].filter(message => !forwarded.has(message.id))
  if (session.activeExecution) {
    if (work.proactive) {
      // An unmentioned reply starts a run or does nothing; it never steers
      // one. The next turn collects it as thread context.
      await skipProactiveTurn(client, ackMessageName, threadKey, execute.id)
      return noRun()
    }
    if (!canFoldIntoActiveRun(event, threadState)) {
      await refuseFoldForOtherRequester(client, ackMessageName, threadKey, execute.id)
      return noRun()
    }
    // In a shared space only the sender's own message steers the run. The
    // listed thread history can hold other people's messages, including
    // ones refused above, and steering those in would carry them into a
    // turn that holds the starter's grants after all.
    const steered = event.space_type === 'DIRECT_MESSAGE' ? appended : [execute]
    handoffLost.throwIfAborted()
    await appendSessionMessages(config, threadKey, steered)
    const held = await holdSteeringAck(client, ackMessageName)
    await updateThreadState(durableState, threadKey, {
      activeExecution: true,
      forwardedMessageIds: steered.map(message => message.id),
      ...(held ? { steeringAckMessageNames: [ackMessageName] } : {}),
      ...dmTranscriptUpdate(event, execute),
      ...eligibility
    }, config.GOOGLECHATBOT_THREAD_HISTORY_LIMIT)
    incr('googlechatbot_runs_total', { outcome: 'folded' })
    logWarn('googlechatbot_folded_into_active_run', {
      thread_key: threadKey,
      message_id: execute.id
    })
    return noRun()
  }

  // Deliberately NOT appended before the execute: api-rs forwards appended
  // user messages into any active execution, so a turn that loses the
  // check-then-execute race above would be steered into the other run and
  // then folded again below. Appended after the run is ours.
  // A persona-pinned model overrides any model or provider selection. api-rs
  // ignores both on a pinned thread; don't send them, so a rejected pin isn't
  // blamed on a sticky model.
  const personaModel = session.personaModel
  const turnReasoning = personaModel
    ? reasoningForModel(
        session.harnessType ?? requestedHarnessType,
        personaModel,
        overrides.reasoning ?? spaceDefault?.reasoning
      )
    : resolvedReasoning
  let execution
  try {
    handoffLost.throwIfAborted()
    execution = await executeSession(config, threadKey, execute, {
      overrides: {
        model: personaModel ? undefined : resolvedModel,
        provider: personaModel ? undefined : resolvedProvider,
        reasoning: turnReasoning
      },
      // Include history in the execution input so a replacement sandbox has
      // prior context. Durable message rows do not seed a new harness turn.
      history,
      // The person behind this turn, for their own per-user grants (their
      // desktop, their credentials) in any space, DM or group.
      requester: {
        verified: identity.verified,
        ...(event.user_email ? { userEmail: event.user_email } : {})
      },
      ...(session.harnessType ? { harnessType: session.harnessType } : {})
    })
  } catch (error) {
    // The handoff lock serializes this bot's executes, but api-rs is the
    // authority: an execution it still reports active rejects the second
    // execute on its one-active-execution index (409 once api-rs types the
    // conflict; an opaque 500 on older servers). Re-check and fold into the
    // live run instead of erroring into the thread.
    if (work.proactive && classifyExecuteConflict(error) !== 'unrelated') {
      await skipProactiveTurn(client, ackMessageName, threadKey, execute.id)
      return noRun()
    }
    const folded = await foldIntoActiveRun(config, client, threadKey, execute, ackMessageName, error, {
      conversationName: conversationName(event),
      harnessType: resolvedHarnessType ?? config.GOOGLECHATBOT_DEFAULT_HARNESS,
      // The other run started between the check and this execute, so read
      // its requester fresh rather than from the state loaded above.
      canFold: async () =>
        canFoldIntoActiveRun(
          event,
          (await durableState.get<GoogleChatThreadState>(threadStateKey(threadKey))) ?? {}
        )
    })
    if (folded === 'refused') return noRun()
    if (folded) {
      await updateThreadState(durableState, threadKey, {
        forwardedMessageIds: [execute.id],
        ...(folded.steeringAckHeld ? { steeringAckMessageNames: [ackMessageName] } : {}),
        ...dmTranscriptUpdate(event, execute),
        ...eligibility
      }, config.GOOGLECHATBOT_THREAD_HISTORY_LIMIT)
      return noRun()
    }
    throw error
  }
  // Slack's rule: session_messages records each human turn exactly once.
  // The execution is already running, so a failed append must not abort the
  // render loop: the DM transcript below is the context source and
  // this append must persist only: execute already supplied the input.
  await appendSessionMessagesBestEffort(config, threadKey, appended)
  await updateThreadState(durableState, threadKey, {
    activeExecution: true,
    activeExecutionId: execution.execution_id,
    activeRequesterEmail: event.user_email ?? null,
    executedMessageIds: [execute.id],
    forwardedMessageIds: appended.map(message => message.id),
    lastExecutedAt: sentAt,
    ...eligibilityFor(latest),
    ...dmTranscriptUpdate(event, execute),
    ...(overrides.harnessType ? { harnessType: overrides.harnessType } : {}),
    ...(overrides.model
      ? { model: overrides.model }
      : overrides.harnessType ? { model: null } : {}),
    ...(overrides.provider
      ? { provider: overrides.provider }
      : overrides.harnessType ? { provider: null } : {}),
    ...(disabledHarnessReset
      ? { harnessType: requestedHarnessType, model: null, provider: null }
      : {}),
    ...(session.personaId !== undefined ? { personaId: session.personaId } : {})
  }, config.GOOGLECHATBOT_THREAD_HISTORY_LIMIT)
  work.executionId = execution.execution_id
  work.stage = 'rendering'
  await persistWork(durableState, work)
  return {
    execution,
    session,
    execute,
    overrides,
    spaceDefault,
    resolvedHarnessType,
    resolvedModel,
    resolvedProvider,
    turnReasoning
  }
}

async function renderTurn(
  config: AppConfig,
  client: ChatEdgeClient,
  event: NormalizedChatEvent,
  ackMessageName: string,
  durableState: StateAdapter,
  work: GoogleChatWorkObligation,
  leaseLost: AbortSignal,
  started: StartedTurn
): Promise<void> {
  const threadKey = event.thread_key
  const { execution, session, execute, resolvedHarnessType, resolvedModel, resolvedProvider, turnReasoning } = started
  const personaModel = session.personaModel
  // Match Slack response metadata: first response, every response, or disabled.
  const isFirstAssistantMessage = !event.history_messages?.length
  // The persisted harness can differ from this turn's selection when the
  // thread predates it or a persona pins one.
  const effectiveHarnessType =
    session.harnessType ?? resolvedHarnessType ?? config.GOOGLECHATBOT_DEFAULT_HARNESS
  // Without an explicit --model/--opus/... override the harness runs its
  // configured default (CLAUDE_MODEL/CODEX_MODEL, else the baked harness
  // config); show that instead of dropping the model entirely.
  const effectiveModel =
    personaModel ?? resolvedModel ?? defaultModelForHarness(effectiveHarnessType, harnessDefaultModels(config))
  // Codex/Nanocodex run an effort level even when this turn asked for none;
  // show the one the harness actually applies (Nanocodex folds Minimal into
  // Low). Undefined for the Claude/Amp harnesses, which drop the segment.
  const effectiveReasoning = effectiveReasoningForHarness(
    effectiveHarnessType,
    turnReasoning,
    harnessDefaultReasoning(config)
  )
  const includeResponseMetadata =
    config.GOOGLECHATBOT_RESPONSE_METADATA_MODE === 'always' ||
    (config.GOOGLECHATBOT_RESPONSE_METADATA_MODE === 'first' && isFirstAssistantMessage)
  const fallbackNotice = personaFallbackNotice(
    session.unavailableRequestedPersonaId,
    session.personaId
  )
  const consoleSessionWidget = isFirstAssistantMessage || includeResponseMetadata || fallbackNotice
    ? buildResponseContextWidget({
        harnessType: effectiveHarnessType,
        metadataEnabled: includeResponseMetadata,
        model: effectiveModel,
        notice: fallbackNotice,
        reasoning: effectiveReasoning,
        serviceTier:
          config.GOOGLECHATBOT_RESPONSE_SERVICE_TIER_ENABLED && (personaModel || !resolvedProvider)
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
    fallbackMessageId: `client-centaur-${work.workId.replace(/-/g, '')}`,
    liveCards: () => liveStopCards(config, durableState, ackMessageName)
  }

  // Resume-on-drop: a dropped SSE connection leaves the answer half-written.
  // Re-open from the last event id (api-rs replays only newer events) and keep
  // accumulating into the same render state, so the final answer is delivered
  // even if the stream breaks mid-run. Bounded to avoid spinning forever.
  const state = createRenderState()
  let lastEventId = 0
  for (let attempt = 0; attempt < MAX_RESUME_ATTEMPTS && !state.terminal; attempt += 1) {
    leaseLost.throwIfAborted()
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
  leaseLost.throwIfAborted()
  if (!state.terminal) state.error ??= state.streamError
  work.canonicalFinal = { answer: state.answer, ...(state.error ? { error: state.error } : {}) }
  await persistWork(durableState, work)
  // The button's binding goes first so a click racing the final finds
  // nothing to stop, and the final itself replaces the card surface.
  await clearStopControl(durableState, ackMessageName)
  const deliveryOutcome = await finalizeRender(client, target, state)
  incr('googlechatbot_delivery_total', { outcome: deliveryOutcome, source: 'live' })
  work.stage = 'final'
  await persistWork(durableState, work)
  await recordAssistantFinal(config, durableState, event, target, {
    outcome: deliveryOutcome,
    answer: state.answer
  })
  await finishThreadRun(client, durableState, threadKey, { lastEventId })
  incr('googlechatbot_runs_total', { outcome: state.error ? 'failed' : 'completed' })
  // Reuse slackbotv2's delivery_status vocabulary so cross-bot dashboards
  // aggregate both: the final answer is written once and visible.
  incr('centaur_session_delivery_total', {
    delivery_status: state.error ? 'error_visible' : 'answer_visible'
  })
}

/** Google's timestamp for the message behind this work, falling back to when
 * the bot accepted it. Stops are ordered against this on the same clock. */
function eventTimeMs(event: NormalizedChatEvent, work: GoogleChatWorkObligation): number {
  const fromEvent = event.chat.event_time ? Date.parse(event.chat.event_time) : Number.NaN
  return Number.isFinite(fromEvent) ? fromEvent : Date.parse(work.acceptedAt)
}

/** Whether a stop was requested after this message was sent. */
function stopRequestedFor(
  state: GoogleChatThreadState,
  event: NormalizedChatEvent,
  work: GoogleChatWorkObligation
): boolean {
  return (state.stopRequestedAt ?? 0) >= eventTimeMs(event, work)
}

/** An unmentioned message may start a run only while nothing newer has: a
 * later execution already saw it as thread context. */
/** Whether an unmentioned message may start a run right now, whatever any
 * earlier classifier decision said: feature on, exact space, thread opted in
 * (a stop clears it), and nothing newer has run. */
function proactivePermitted(
  runtime: BotRuntime,
  state: GoogleChatThreadState,
  event: NormalizedChatEvent
): boolean {
  return Boolean(runtime.proactivity)
    && event.space_type !== 'DIRECT_MESSAGE'
    && proactiveSpaceAllowed(runtime.proactivity!, event.space_name)
    && state.proactiveEligible === true
    && proactiveStillCurrent(state, event)
}

function proactiveStillCurrent(state: GoogleChatThreadState, event: NormalizedChatEvent): boolean {
  if (state.activeExecution === true) return false
  const sentAt = event.chat.event_time ? Date.parse(event.chat.event_time) : Number.NaN
  return !Number.isFinite(sentAt) || (state.lastExecutedAt ?? 0) < sentAt
}

async function skipProactiveTurn(
  client: ChatEdgeClient,
  ackMessageName: string,
  threadKey: string,
  messageId: string
): Promise<void> {
  incr('googlechatbot_proactive_decisions_total', { outcome: 'skip_active_execution' })
  logInfo('googlechatbot_proactive_handoff_skipped', { thread_key: threadKey, message_id: messageId })
  await removeAck(client, ackMessageName)
}

async function deliverStoppedBeforeStart(client: ChatEdgeClient, ackMessageName: string): Promise<void> {
  if (!ackMessageName) return
  try {
    await client.updateMessage(ackMessageName, { text: STOPPED_BEFORE_START_TEXT, cardsV2: [] })
  } catch (error) {
    logWarn('googlechatbot_stopped_ack_update_failed', error)
    await removeAck(client, ackMessageName)
  }
}

/** Record a delivered answer in the DM transcript and in session_messages,
 * keyed by the Google message name it was delivered under (`deliverFinal`
 * PATCHes the ack, or creates under the deterministic fallback id). Both the
 * live and the recovery delivery path must call this, or a crash between
 * delivery and record loses the answer from the thread's memory. */
async function recordAssistantFinal(
  config: AppConfig,
  durableState: StateAdapter,
  event: NormalizedChatEvent,
  target: { spaceName: string; ackMessageName: string; fallbackMessageId?: string },
  delivery: { outcome: 'updated' | 'created'; answer: string }
): Promise<void> {
  if (event.space_type !== 'DIRECT_MESSAGE' || !delivery.answer.trim()) return
  const messageName = delivery.outcome === 'updated'
    ? target.ackMessageName
    : target.fallbackMessageId && `${target.spaceName}/messages/${target.fallbackMessageId}`
  if (!messageName) return
  const turn = assistantTurnMessage(messageName, delivery.answer)
  await appendSessionMessagesBestEffort(config, event.thread_key, [turn])
  await updateThreadState(durableState, event.thread_key, {
    forwardedMessageIds: [turn.id],
    transcript: [transcriptEntryFromTurn(turn)]
  }, config.GOOGLECHATBOT_THREAD_HISTORY_LIMIT)
}

/** A DM's transcript is this bot's only durable memory of the thread. */
function dmTranscriptUpdate(
  event: NormalizedChatEvent,
  turn: GoogleChatTurnMessage
): Pick<GoogleChatThreadState, 'transcript'> {
  return event.space_type === 'DIRECT_MESSAGE'
    ? { transcript: [transcriptEntryFromTurn(turn)] }
    : {}
}

/** Record the transcript without sending it into the harness again. Once a
 * run is in flight (or an answer delivered), log append failures, never abort. */
async function appendSessionMessagesBestEffort(
  config: AppConfig,
  threadKey: string,
  messages: GoogleChatTurnMessage[]
): Promise<void> {
  try {
    await appendSessionMessages(config, threadKey, messages, { forwardToActiveExecution: false })
  } catch (error) {
    logWarn('googlechatbot_session_append_failed', error, {
      thread_key: threadKey,
      message_count: messages.length
    })
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
  state: StateAdapter,
  event: NormalizedChatEvent
): Promise<void> {
  const threadKey = event.thread_key
  const requester = event.user_name || event.user_id || 'unknown user'
  let text: string
  try {
    const response = await requestStop(config, state, {
      threadKey,
      requestedAt: event.chat.event_time ? Date.parse(event.chat.event_time) : Date.now(),
      reason: `Interrupted from Google Chat by ${requester}`
    })
    const interrupted = response !== 'stale' && response.interrupted
    incr('googlechatbot_stop_commands_total', {
      outcome: interrupted ? 'interrupted' : 'no_active_run',
      source: 'text'
    })
    text = interrupted
      ? '⏹️ Stopped the current run.'
      : 'There is no active run in this thread to stop.'
  } catch (error) {
    incr('googlechatbot_stop_commands_total', { outcome: 'failed', source: 'text' })
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

/**
 * The Stop button. Nothing in the click is trusted beyond what Google signed:
 * the message the card sits on and the space. That message's durable binding
 * names the work it may cancel; the binding is deleted at the turn's final
 * and when a stop lands, so a button that outlived its turn finds nothing.
 * The binding check and the interrupt run under the thread handoff lock, so
 * no newer execution can start between them and be interrupted in its place.
 */
async function handleStopCard(
  config: AppConfig,
  client: ChatEdgeClient,
  state: StateAdapter,
  work: GoogleChatWorkObligation
): Promise<void> {
  const payload = work.action!.payload
  const ackMessageName = payload.message_name
  const record = (outcome: string) =>
    incr('googlechatbot_stop_commands_total', { outcome, source: 'card' })
  if (!ackMessageName || !/^spaces\/[^/]+\/messages\/[^/]+$/.test(ackMessageName)) {
    record('stale')
    return
  }
  const control = await state.get<StopControl>(stopControlKey(ackMessageName))
  if (!control || control.spaceName !== payload.space_name) {
    record('stale')
    logInfo('googlechatbot_stop_card_stale', { space_name: payload.space_name })
    return
  }
  // Before the lock, the intent is scoped to the one obligation the card
  // names: a turn of that work still starting sees it and does not execute,
  // while a stale card can affect nothing newer. Thread-wide effects (the
  // cutoff, proactive opt-out) are written only after the binding is
  // validated under the handoff lock.
  // Google's click time orders the stop against message times on one clock.
  const clickedAt = Date.parse(work.envelope?.eventTime ?? work.acceptedAt)
  const requestedAt = Number.isFinite(clickedAt) ? clickedAt : Date.now()
  await requestWorkStop(state, control.workId, requestedAt)
  const requester = payload.user_name || payload.user_id || 'unknown user'
  let response: InterruptSessionResponse | 'stale'
  try {
    response = await requestStop(config, state, {
      threadKey: control.threadKey,
      requestedAt,
      reason: `Interrupted from Google Chat by ${requester}`,
      boundTo: async threadState => {
        const target = await state.get<GoogleChatWorkObligation>(workKey(control.workId))
        // Bound to its own execution: once that one is no longer the thread's
        // active execution, the button is stale however it was delivered.
        // A pending obligation (no execution yet) names no execution either:
        // while another one is active it cannot authorize an interrupt. Its
        // own turn still honours the work-scoped intent when it reaches the
        // handoff.
        if (
          !target
          || target.stage === 'final'
          || (target.executionId
            ? threadState.activeExecutionId !== target.executionId
            : threadState.activeExecution === true)
        ) {
          return false
        }
        // The next status edit or the final drops the button (liveCards
        // re-reads this binding); no Google call sits in front of the interrupt.
        await clearStopControl(state, ackMessageName)
        return true
      }
    })
  } catch (error) {
    record('failed')
    logError('googlechatbot_stop_card_failed', error)
    await replyInThread(client, payload, clampPlainText(
      `⚠️ Couldn't stop the run: ${error instanceof Error ? error.message : String(error)}`
    ))
    return
  }
  if (response === 'stale') {
    record('stale')
    logInfo('googlechatbot_stop_card_stale', { space_name: payload.space_name })
    return
  }
  record(response.interrupted ? 'interrupted' : 'no_active_run')
  if (!response.interrupted) {
    await replyInThread(client, payload, 'There is no active run in this thread to stop.')
  }
}

/**
 * A text stop persists its thread-wide intent first, outside any lock: a
 * handoff that is still waiting on the session API reads it before it would
 * execute, so the run never starts. A card stop persists only its work-scoped
 * intent before the lock (see handleStopCard) and the thread-wide intent once
 * its binding is validated. Then, under the thread handoff lock so no newer
 * execution can slip in between, interrupt the execution that is active,
 * unless it started from a message sent after this stop: an older stop never
 * kills a newer turn. A stop also ends proactive replies until the next
 * mention, unless it predates that mention.
 */
async function requestStop(
  config: AppConfig,
  state: StateAdapter,
  stop: {
    threadKey: string
    requestedAt: number
    reason: string
    /** Extra binding for a Stop card, checked under the lock before any
     * thread-wide effect; false means the card no longer names the active
     * execution. */
    boundTo?: (threadState: GoogleChatThreadState) => Promise<boolean>
  }
): Promise<InterruptSessionResponse | 'stale'> {
  // The cutoff never moves backwards (updateThreadState keeps the max), and a
  // stop older than the mention that opted the thread in leaves that opt-in.
  const persistIntent = async () => {
    const before = (await state.get<GoogleChatThreadState>(threadStateKey(stop.threadKey))) ?? {}
    await updateThreadState(state, stop.threadKey, {
      stopRequestedAt: stop.requestedAt,
      ...(stop.requestedAt >= (before.proactiveEligibleAt ?? 0) ? { proactiveEligible: false } : {})
    })
  }
  if (!stop.boundTo) await persistIntent()
  return withThreadHandoff(state, stop.threadKey, async () => {
    const threadState =
      (await state.get<GoogleChatThreadState>(threadStateKey(stop.threadKey))) ?? {}
    if (stop.boundTo) {
      if (!(await stop.boundTo(threadState))) return 'stale'
      await persistIntent()
    }
    const newerTurnActive =
      threadState.activeExecution === true
      && (threadState.lastExecutedAt ?? 0) > stop.requestedAt
    if (newerTurnActive) {
      logInfo('googlechatbot_stop_skipped_newer_turn', { thread_key: stop.threadKey })
      return { interrupted: false }
    }
    return interruptSessionExecution(config, stop.threadKey, stop.reason)
  })
}

async function replyInThread(
  client: ChatEdgeClient,
  payload: GoogleChatActionPayload,
  text: string
): Promise<void> {
  try {
    await client.createMessage(payload.space_name, { text }, {
      ...(payload.thread_name ? { threadName: payload.thread_name } : {})
    })
  } catch (error) {
    logError('googlechatbot_stop_reply_failed', error)
  }
}

function proactiveSpaceAllowed(proactivity: ProactivityRuntime, spaceName: string): boolean {
  return proactivity.spaces.includes(spaceName)
}

/**
 * Whether an unmentioned message in an eligible thread should get a reply.
 * Silent on every other outcome: the wrong space, a thread without a prior
 * mention, an active run, an empty message, a decline, or a classifier error
 * or timeout. The thread is re-checked after the decision because a stop or
 * a new run may have landed while the classifier ran; the handoff lock makes
 * the final check before any execution.
 */
async function shouldReplyProactively(
  config: AppConfig,
  client: ChatEdgeClient,
  runtime: BotRuntime,
  state: StateAdapter,
  work: GoogleChatWorkObligation,
  event: NormalizedChatEvent
): Promise<boolean> {
  const proactivity = runtime.proactivity
  if (!proactivity) return false
  const startedAt = Date.now()
  const record = (outcome: string, fields: Record<string, unknown> = {}) => {
    incr('googlechatbot_proactive_decisions_total', { outcome })
    logInfo('googlechatbot_proactive_decision', {
      outcome,
      phase_ms: Date.now() - startedAt,
      thread_key: event.thread_key,
      ...fields
    })
  }
  const skipReason = async () => {
    if (event.space_type === 'DIRECT_MESSAGE' || !proactiveSpaceAllowed(proactivity, event.space_name)) {
      return 'space'
    }
    const threadState = (await state.get<GoogleChatThreadState>(threadStateKey(event.thread_key))) ?? {}
    if (threadState.proactiveEligible !== true) return 'not_eligible'
    if (!proactiveStillCurrent(threadState, event)) return 'active_execution'
    if (!normalizedEventText(event).trim()) return 'empty'
    return undefined
  }
  const early = await skipReason()
  if (early) {
    record(`skip_${early}`)
    return false
  }
  let decision
  try {
    const history = (await sharedThreadHistory(config, client, work, event))
      .slice(-PROACTIVE_HISTORY_MESSAGES)
      .map(message => proactiveThreadMessage(message))
    decision = await decideWithTimeout(proactivity.classifier, {
      botName: BOT_DISPLAY_NAME,
      history,
      message: {
        author: event.user_name || event.user_id,
        fromBot: false,
        text: normalizedEventText(event)
      }
    }, proactivity.timeoutMs)
  } catch (error) {
    record('error', { error: error instanceof Error ? error.message : String(error) })
    return false
  }
  if (!decision.respond) {
    record('decline', { probability: decision.probability })
    return false
  }
  const late = await skipReason()
  if (late) {
    record(`skip_${late}`, { probability: decision.probability })
    return false
  }
  record('respond', { probability: decision.probability })
  return true
}

function proactiveThreadMessage(
  message: NonNullable<NormalizedChatEvent['history_messages']>[number]
): ProactiveThreadMessage {
  const userName = message.metadata?.user_name
  return {
    author: typeof userName === 'string' && userName ? userName : message.user_id ?? 'unknown',
    fromBot: message.role === 'assistant',
    text: message.parts.map(part => (part.type === 'text' ? part.text : '')).filter(Boolean).join('\n')
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
 * the live run picks it up (steering) and turn the ack into a steering
 * notice. Returns the fold outcome when this event needs no run of its own. */
async function foldIntoActiveRun(
  config: AppConfig,
  client: ChatEdgeClient,
  threadKey: string,
  execute: GoogleChatTurnMessage,
  ackMessageName: string,
  error: unknown,
  session: { conversationName?: string; harnessType?: string; canFold: () => Promise<boolean> }
): Promise<{ steeringAckHeld: boolean } | 'refused' | false> {
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
  if (!(await session.canFold())) {
    await refuseFoldForOtherRequester(client, ackMessageName, threadKey, execute.id)
    return 'refused'
  }
  await appendSessionMessages(config, threadKey, [execute])
  const steeringAckHeld = await holdSteeringAck(client, ackMessageName)
  incr('googlechatbot_runs_total', { outcome: 'folded' })
  logWarn('googlechatbot_folded_into_active_run', {
    thread_key: threadKey,
    message_id: execute.id,
    reason: 'execute_conflict'
  })
  return { steeringAckHeld }
}

/** A message from someone other than the running turn's verified starter, in a
 * shared space: not appended, so it cannot steer a turn holding the starter's
 * per-person grants. The eager ack becomes a "still running" notice that
 * stays, since the message itself is not carried into any run. */
async function refuseFoldForOtherRequester(
  client: ChatEdgeClient,
  ackMessageName: string,
  threadKey: string,
  messageId: string
): Promise<void> {
  incr('googlechatbot_runs_total', { outcome: 'refused_other_requester' })
  logWarn('googlechatbot_fold_refused_other_requester', { thread_key: threadKey, message_id: messageId })
  if (!ackMessageName) return
  try {
    await client.updateMessage(ackMessageName, { text: BUSY_STATUS, cardsV2: [] })
  } catch (error) {
    logWarn('googlechatbot_busy_ack_update_failed', error)
    await removeAck(client, ackMessageName)
  }
}

/** slackbotv2 reacts to a steering message and clears the reaction when the
 * live run finishes (#1519). Chat's `reactions.create` is user-auth only, so
 * the acknowledgement is the eager "thinking…" bubble edited into a steering
 * notice instead; `finishThreadRun` deletes it. Falls back to removing the
 * bubble when the edit fails so no "thinking…" is stranded. */
async function holdSteeringAck(client: ChatEdgeClient, ackMessageName: string): Promise<boolean> {
  if (!ackMessageName) return false
  try {
    await client.updateMessage(ackMessageName, { text: STEERING_STATUS, cardsV2: [] })
    return true
  } catch (error) {
    logWarn('googlechatbot_steering_ack_update_failed', error)
    await removeAck(client, ackMessageName)
    return false
  }
}

/** Marks the thread idle and removes the steering notices the run collected.
 * A crash between hold and finish strands a notice — the same ceiling
 * slackbotv2 accepts for its process-local reactions. */
async function finishThreadRun(
  client: ChatEdgeClient,
  durableState: StateAdapter,
  threadKey: string,
  update: Partial<GoogleChatThreadState> = {}
): Promise<void> {
  const held =
    (await durableState.get<GoogleChatThreadState>(threadStateKey(threadKey)))
      ?.steeringAckMessageNames ?? []
  await updateThreadState(durableState, threadKey, {
    ...update,
    activeExecution: false,
    activeExecutionId: null,
    activeRequesterEmail: null,
    steeringAckMessageNames: []
  })
  for (const name of held) await removeAck(client, name)
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
    ...(config.CENTAUR_PI_MODEL ? { pi: config.CENTAUR_PI_MODEL } : {}),
    ...(config.CENTAUR_OMP_MODEL ? { omp: config.CENTAUR_OMP_MODEL } : {}),
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
