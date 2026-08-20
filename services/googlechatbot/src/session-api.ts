import type { RustSessionStreamEvent } from '@centaur/harness-events'
import { createHash } from 'node:crypto'
import type { AppConfig } from './config'
import { centaurApiKey } from './config'
import type { GoogleChatHarnessAssignment } from './harness-rollout'
import { logWarn } from './logging'
import { addGauge, incr } from './metrics'
import type { ChatSpaceType, NormalizedChatEvent, NormalizedPart } from './chat/types'
import type { SpaceDmConfirmation } from './chat/space-verify'
import { resolveSessionIdentity, type ResolvedSessionIdentity } from './chat/verify'

// ---------------------------------------------------------------------------
// api-rs session contract
//
// This is the Google Chat analog of services/discordbot/src/session-api.ts and
// services/slackbotv2/src/session-api.ts. The legacy chatbot drove the deleted
// Python API via POST /workflows/runs plus an outbox poll; api-rs replaced that
// with a session lifecycle:
//
//   POST /api/session/{thread_key}            create the session
//   POST /api/session/{thread_key}/messages   append prior thread turns
//   POST /api/session/{thread_key}/execute    start an agent run for this turn
//   GET  /api/session/{thread_key}/events     SSE stream of the run's output
//
// The platform is opaque to api-rs (metadata.platform is advisory), so the
// only Google-Chat-specific bits are the metadata source/platform tags and the
// conversation display name.
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }
export type JsonObject = { [key: string]: JsonValue | undefined }

/** A single Google Chat turn flattened into the shape api-rs expects. */
export type GoogleChatTurnMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  parts: NormalizedPart[]
  isMention: boolean
  userId: string
  userName: string
  /** Requester email when the Chat sender profile exposes it (see
   * NormalizedChatEvent.user_email). Rides the session/message metadata so the
   * Console can attribute the thread to the signed-in user (#875 analogue). */
  userEmail?: string
  timestamp?: string
  /** Upload destination for the session-context block (executing turn only). */
  spaceName?: string
  threadName?: string
}

type CreateSessionRequest = {
  harness_type: string
  metadata: JsonObject
  on_harness_conflict?: 'restart'
}

type AppendMessagesRequest = {
  messages: Array<{
    client_message_id?: string
    role: 'user' | 'assistant'
    parts: JsonValue[]
    metadata: JsonObject
  }>
}

type ExecuteSessionRequest = {
  idempotency_key?: string
  idle_timeout_ms?: number
  input_lines: string[]
  max_duration_ms?: number
  metadata: JsonObject
}

export type ExecuteSessionResponse = {
  execution_id: string
}

/** api-rs marks a session `executing` for the lifetime of an in-flight run and
 * flips it back to `idle`/`failed` when the run settles (see
 * `mark_execution_running` / `mark_execution_completed` in centaur-session-sqlx).
 * Treating that status as the source of truth lets a stateless bot detect an
 * active run without its own state store. */
const ACTIVE_SESSION_STATUS = 'executing'

/** Wall-clock ceiling on a single execution, sent as `max_duration_ms`.
 *
 * api-rs only arms `spawn_max_duration_failure` when the caller supplies this,
 * so omitting it means a turn that blocks on a slow tool runs unbounded. On
 * 2026-08-04 a turn sat 45 minutes on an untimed `browser-agent` call and only
 * the out-of-band stuck-execution-reaper cronjob stopped it — after which the
 * agent process kept running, because the reaper only writes to Postgres.
 *
 * Defaulted in code rather than left to `SESSION_MAX_DURATION_MS` alone: the
 * bound is a safety property, and a missing env var in one values file is
 * exactly how it went missing in production. Config tunes it; it does not
 * enable it. */
export const DEFAULT_SESSION_MAX_DURATION_MS = 30 * 60 * 1000

/** Mirrors `DEFAULT_SESSION_IDLE_TIMEOUT_MS` in slackbotv2's session-api. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 3 * 60 * 60 * 1000
export const SESSION_CONTROL_TIMEOUT_MS = 30_000
export const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const STAGED_ATTACHMENT_CHUNK_CHARS = 700 * 1024

/** Config tunes the bound; it does not enable it — an unset env var still gets
 * the built-in ceiling. */
function sessionMaxDurationMs(config: AppConfig): number {
  return config.SESSION_MAX_DURATION_MS ?? DEFAULT_SESSION_MAX_DURATION_MS
}

/** Resolve `idle_timeout_ms`, mirroring slackbotv2's `sessionIdleTimeoutMs`.
 *
 * This is not merely a sandbox-lifecycle knob: `record_max_duration_failure`
 * in centaur-session-runtime only calls `spawn_idle_pause` — the thing that
 * actually suspends the sandbox and so stops the agent process — when an idle
 * timeout is present. Sending `max_duration_ms` without this fails the
 * execution row while leaving the runaway process alive, which is the state
 * the 2026-08-04 incident ended in. */
function sessionIdleTimeoutMs(config: AppConfig): number {
  if (config.SESSION_IDLE_TIMEOUT_MS !== undefined) return config.SESSION_IDLE_TIMEOUT_MS
  return Math.min(DEFAULT_SESSION_IDLE_TIMEOUT_MS, sessionMaxDurationMs(config))
}

type CreateSessionResponse = {
  // api-rs returns the session object flat on the response body; the nested
  // `session` shape never existed in api-rs and made activeExecution always
  // false (so execute-vs-execute conflicts 500'd instead of folding).
  status?: string
  session?: { status?: string }
  harness_type?: string
}

export type CreateSessionResult = {
  /** Lifecycle status reported by api-rs, e.g. `idle` / `executing` / `failed`. */
  status: string
  /** True when a run is already in flight for this thread. A second
   * `/execute` would collide with the `one active execution per thread` index
   * and 500, so the caller should append-and-fold instead of executing. */
  activeExecution: boolean
  /** The harness persisted by api-rs. */
  harnessType?: string
  /** The Google Chat-owned experiment/cohort used for this thread. */
  harnessAssignment?: GoogleChatHarnessAssignment
}

export class SessionApiError extends Error {
  readonly body: string
  readonly retryable: boolean
  readonly status: number

  constructor(input: { action: string; body?: string; retryable: boolean; status: number; statusText: string }) {
    // api-rs is internal and its error bodies can carry internals; the message
    // stays generic because it is surfaced verbatim into the Google Chat thread.
    super(`Centaur session ${input.action} failed: ${input.status} ${input.statusText}`)
    this.name = 'SessionApiError'
    this.body = input.body ?? ''
    this.retryable = input.retryable
    this.status = input.status
  }
}

export function isRetryableSessionApiError(error: unknown): boolean {
  if (error instanceof SessionApiError) return error.retryable
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'TypeError'
}

/** How an `/execute` failure relates to api-rs's one-active-execution-per-thread
 * invariant. `conflict` is the typed 409; `recheck` is an opaque 500 that *may*
 * be the same collision on servers that predate the typed conflict, so the
 * caller must confirm a run is active before folding; `unrelated` is any other
 * failure. */
export type ExecuteConflictClass = 'conflict' | 'recheck' | 'unrelated'

export function classifyExecuteConflict(error: unknown): ExecuteConflictClass {
  if (!(error instanceof SessionApiError)) return 'unrelated'
  if (error.status === 409) return 'conflict'
  if (error.status === 500) return 'recheck'
  return 'unrelated'
}

/**
 * Build the turn message executed for a Google Chat event, plus the prior
 * thread turns appended as context.
 */
export function turnMessagesFromEvent(event: NormalizedChatEvent): {
  execute: GoogleChatTurnMessage
  history: GoogleChatTurnMessage[]
} {
  const history: GoogleChatTurnMessage[] = (event.history_messages ?? []).map((message, index) => ({
    id: message.message_id || `${event.thread_key}:history:${index}`,
    role: message.role === 'assistant' ? 'assistant' : 'user',
    text: textFromParts(message.parts),
    parts: message.parts,
    isMention: false,
    userId: message.user_id ?? '',
    userName: stringFromMetadata(message.metadata, 'user_name')
  }))

  const execute: GoogleChatTurnMessage = {
    id: event.message_id,
    role: 'user',
    text: textFromParts(event.parts),
    parts: event.parts,
    isMention: event.is_mention,
    userId: event.user_id,
    userName: event.user_name,
    ...(event.user_email ? { userEmail: event.user_email } : {}),
    timestamp: event.chat.event_time,
    spaceName: event.space_name,
    threadName: event.chat.thread_name
  }

  return { execute, history }
}

/** The identity an inbound event claims, paired with whether that event was
 * actually authenticated. `verified` is required so a caller cannot supply a
 * claim without stating its provenance. */
export type RequesterIdentityClaim = {
  /** True ONLY when the request carried a valid Google signature — never
   * derived from a verification result's `ok`. */
  verified: boolean
  /** Verified Workspace Add-on userIdToken email, when present. */
  userEmail?: string
  /** The space type THE BODY CLAIMS. A signed Chat request does not bind its
   * body, so this is only a pre-filter that saves an API call; what actually
   * reaches the metadata is `confirmSpace`'s answer. */
  spaceType: ChatSpaceType
  /** Asks Google what the space is. Required — a caller must not be able to
   * assert a DM without one. */
  confirmSpace: () => Promise<SpaceDmConfirmation>
}

export type SessionRequester = {
  userId?: string
  userName?: string
  /** Omit entirely for calls that are not starting a turn on someone's behalf
   * (e.g. the idempotent re-check in the fold path). */
  identity?: RequesterIdentityClaim
}

export async function createSession(
  config: AppConfig,
  threadKey: string,
  conversationName?: string,
  harnessType?: string,
  requester?: SessionRequester,
  options: {
    harnessAssignment?: GoogleChatHarnessAssignment
    restartOnHarnessConflict?: boolean
  } = {}
): Promise<CreateSessionResult> {
  const name = conversationName?.trim()
  const claim = requester?.identity
  const identity = claim
    ? await resolveSessionIdentity({
        config,
        verified: claim.verified,
        userEmail: claim.userEmail,
        claimedSpaceType: claim.spaceType,
        confirmSpace: claim.confirmSpace
      })
    : undefined
  if (identity && !identity.email.emit) {
    // Never silent: centaur attaches a person's OAuth credentials off this key,
    // so its absence has to be explainable after the fact.
    incr('googlechatbot_session_identity_total', {
      outcome: 'suppressed',
      reason: identity.email.reason
    })
    logWarn('googlechatbot_session_identity_suppressed', {
      thread_key: threadKey,
      reason: identity.email.reason
    })
  } else if (identity) {
    incr('googlechatbot_session_identity_total', { outcome: 'emitted', reason: 'none' })
  }
  const body: CreateSessionRequest = {
    harness_type: harnessType ?? 'codex',
    metadata: {
      source: 'googlechatbot',
      platform: 'googlechat',
      thread_id: threadKey,
      // Requester identity mirrored from slackbotv2's session metadata
      // (slack_user_id/…): the Console matches user_email against the
      // signed-in user's email to grant thread visibility (#875 analogue).
      ...(requester?.userId ? { user_id: requester.userId } : {}),
      ...(requester?.userName ? { user_name: requester.userName } : {}),
      // Identity keys api-rs gates its DM-principal labelling on. Only
      // `user_email` is credential-bearing, and only it is withheld when the
      // gate fails; the other two describe the request and always ship.
      ...identityMetadata(identity),
      ...(options.harnessAssignment
        ? { harness_assignment: harnessAssignmentMetadata(options.harnessAssignment) }
        : {}),
      // api-rs reads this as the session principal's display name.
      ...(name ? { googlechat_conversation_name: name } : {})
    }
  }
  const post = async (request: CreateSessionRequest): Promise<CreateSessionResponse> => {
    const response = await sessionApiRequest('create_session', 'create session', signal =>
      fetch(apiSessionUrl(config, threadKey), {
        method: 'POST', headers: apiHeaders(config), body: JSON.stringify(request), signal
      }), config.GOOGLECHATBOT_SESSION_API_TIMEOUT_MS
    )
    return (await response.json().catch(() => ({}))) as CreateSessionResponse
  }

  let payload: CreateSessionResponse
  try {
    payload = await post(body)
  } catch (error) {
    const existingHarness = existingHarnessFromConflict(error)
    if (!existingHarness) throw error
    payload = await post({ ...body, harness_type: existingHarness })
    const status = payload.status ?? payload.session?.status ?? ''
    if (options.restartOnHarnessConflict && status !== ACTIVE_SESSION_STATUS) {
      payload = await post({ ...body, on_harness_conflict: 'restart' })
    }
  }
  const status = payload.status ?? payload.session?.status ?? ''
  const resolvedHarness = payload.harness_type?.trim()
  const harnessAssignment = options.harnessAssignment && resolvedHarness
    ? { ...options.harnessAssignment, cohort: resolvedHarness }
    : options.harnessAssignment
  return {
    status,
    activeExecution: status === ACTIVE_SESSION_STATUS,
    ...(resolvedHarness ? { harnessType: resolvedHarness } : {}),
    ...(harnessAssignment ? { harnessAssignment } : {})
  }
}

function harnessAssignmentMetadata(assignment: GoogleChatHarnessAssignment): JsonObject {
  return {
    experiment: assignment.experiment,
    requested_harness: assignment.requestedHarness,
    cohort: assignment.cohort,
    rollout_percent: assignment.rolloutPercent
  }
}

function existingHarnessFromConflict(error: unknown): string | undefined {
  if (!(error instanceof SessionApiError) || error.status !== 409) return undefined
  try {
    const body = JSON.parse(error.body) as Record<string, unknown>
    return body.code === 'harness_conflict' && typeof body.existing_harness === 'string'
      ? body.existing_harness
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The identity half of the create-session metadata.
 *
 * Two layers gate the same decision. api-rs labels a session principal with the
 * requester's identity — and auto-grants that person's OAuth credentials to
 * every session in the room — only when `googlechat_space_type` is
 * DIRECT_MESSAGE AND `googlechat_request_verified` is true AND there is a
 * `user_email` to name. This side withholds the email unless the request was
 * signature-verified, the sender's domain is allowlisted, and GOOGLE itself
 * confirmed the space is a 1:1 DM. Either layer alone is sufficient to deny.
 *
 * The two gate inputs ship unconditionally so a room stays observable — neither
 * names anybody, and api-rs cannot label without the email. The space type is
 * Google's confirmed value where one was obtained and the envelope's claim
 * otherwise, so it is a gate input, never a trust signal in itself.
 *
 * `single_user_bot_dm` is deliberately not emitted: the confirmation already
 * requires exactly one joined human, so the key would restate the check.
 */
function identityMetadata(identity: ResolvedSessionIdentity | undefined): JsonObject {
  if (!identity) return {}
  return {
    googlechat_space_type: identity.spaceType,
    googlechat_request_verified: identity.verified,
    ...(identity.email.emit ? { user_email: identity.email.userEmail } : {})
  }
}

export async function appendSessionMessages(
  config: AppConfig,
  threadKey: string,
  messages: GoogleChatTurnMessage[]
): Promise<void> {
  if (messages.length === 0) return
  const body: AppendMessagesRequest = {
    messages: messages.map(message => ({
      client_message_id: message.id,
      role: message.role,
      parts: sessionMessageParts(message),
      metadata: sessionMetadata(threadKey, message)
    }))
  }
  await sessionApiRequest('append_messages', 'append session messages', signal =>
    fetch(apiSessionUrl(config, threadKey, 'messages'), {
      method: 'POST',
      headers: apiHeaders(config),
      body: JSON.stringify(body),
      signal
    }), config.GOOGLECHATBOT_SESSION_API_TIMEOUT_MS
  )
}

export type TurnOverrides = {
  model?: string
  provider?: string
  reasoning?: string
}

export async function executeSession(
  config: AppConfig,
  threadKey: string,
  message: GoogleChatTurnMessage,
  opts: {
    overrides?: TurnOverrides
    history?: GoogleChatTurnMessage[]
    /** Harness api-rs persisted for this thread (see CreateSessionResult). */
    harnessType?: string
    harnessAssignment?: GoogleChatHarnessAssignment
  } = {}
): Promise<ExecuteSessionResponse> {
  const body: ExecuteSessionRequest = {
    idempotency_key: message.id,
    metadata: sessionMetadata(threadKey, message, {
      action: 'execute',
      ...(opts.harnessType ? { harness_type: opts.harnessType } : {}),
      ...(opts.harnessAssignment
        ? { harness_assignment: harnessAssignmentMetadata(opts.harnessAssignment) }
        : {})
    }),
    input_lines: toCodexInputLines(
      config,
      threadKey,
      message,
      opts.overrides,
      opts.history
    ),
    idle_timeout_ms: sessionIdleTimeoutMs(config),
    max_duration_ms: sessionMaxDurationMs(config)
  }
  const response = await sessionApiRequest('execute_session', 'execute session', signal =>
    fetch(apiSessionUrl(config, threadKey, 'execute'), {
      method: 'POST',
      headers: apiHeaders(config),
      body: JSON.stringify(body),
      signal
    }), config.GOOGLECHATBOT_SESSION_API_TIMEOUT_MS
  )
  return (await response.json()) as ExecuteSessionResponse
}

/** POST /api/workflows/events -- forwards a card-click (or any other
 * out-of-band UI action) to the workflows engine as a named event, mirroring
 * slackbotv2's dispatchSlackBlockAction. Not thread-scoped: this hits the same
 * api-rs route slackbotv2 uses, so `payload` carries whatever thread/space
 * context the caller wants the workflow to see. */
export async function emitWorkflowEvent(
  config: AppConfig,
  eventName: string,
  payload: Record<string, unknown>
): Promise<void> {
  await sessionApiRequest('emit_workflow_event', `emit workflow event ${eventName}`, signal =>
    fetch(new URL('/api/workflows/events', ensureTrailingSlash(config.CENTAUR_API_URL)).toString(), {
      method: 'POST',
      headers: apiHeaders(config),
      body: JSON.stringify({ event_name: eventName, payload }),
      signal
    }), config.GOOGLECHATBOT_SESSION_API_TIMEOUT_MS
  )
}

export type InterruptSessionResponse = {
  interrupted: boolean
}

/** POST /api/session/{thread_key}/interrupt — asks api-rs to interrupt the
 * thread's active run (slackbotv2's stop-command analog). `interrupted: false`
 * means there was nothing running; api-rs does not treat that as an error. */
export async function interruptSessionExecution(
  config: AppConfig,
  threadKey: string,
  reason: string
): Promise<InterruptSessionResponse> {
  const response = await sessionApiRequest('interrupt_session', 'interrupt session', signal =>
    fetch(apiSessionUrl(config, threadKey, 'interrupt'), {
      method: 'POST',
      headers: apiHeaders(config),
      body: JSON.stringify({ reason }),
      signal
    }), config.GOOGLECHATBOT_SESSION_API_TIMEOUT_MS
  )
  return (await response.json()) as InterruptSessionResponse
}

export async function openSessionEventStream(
  config: AppConfig,
  threadKey: string,
  afterEventId: number,
  executionId: string | undefined,
  onEventId: (eventId: number) => void
): Promise<AsyncIterable<RustSessionStreamEvent>> {
  const url = new URL(apiSessionUrl(config, threadKey, 'events'))
  url.searchParams.set('after_event_id', String(afterEventId))
  if (executionId) url.searchParams.set('execution_id', executionId)
  const response = await sessionApiRequest(
    'open_event_stream',
    'stream events',
    signal =>
      fetch(url.toString(), {
        method: 'GET',
        headers: apiHeaders(config, false),
        signal
      }),
    config.GOOGLECHATBOT_SESSION_STREAM_CONNECT_TIMEOUT_MS
  )
  if (!response.body) return emptyStream()
  return trackOpenStream(parseSessionEventStream(response.body, onEventId))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type SessionApiOperation =
  | 'create_session'
  | 'append_messages'
  | 'execute_session'
  | 'interrupt_session'
  | 'open_event_stream'
  | 'emit_workflow_event'

async function sessionApiRequest(
  operation: SessionApiOperation,
  action: string,
  request: (signal: AbortSignal) => Promise<Response>,
  timeoutMs = SESSION_CONTROL_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await request(controller.signal)
    await ensureApiOk(response, action)
    incr('googlechatbot_session_api_operations_total', { operation, outcome: 'success' })
    return response
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      incr('googlechatbot_upstream_timeouts_total', { operation })
    }
    incr('googlechatbot_session_api_operations_total', {
      operation,
      outcome: isRetryableSessionApiError(error) ? 'retryable_error' : 'error'
    })
    throw error
  } finally {
    // For SSE this intentionally stops timing once headers establish the body;
    // the session idle/max-duration policies own the established stream.
    clearTimeout(timer)
  }
}

async function* trackOpenStream<T>(stream: AsyncIterable<T>): AsyncIterable<T> {
  addGauge('googlechatbot_open_sse_connections', 1)
  try {
    for await (const event of stream) yield event
  } finally {
    addGauge('googlechatbot_open_sse_connections', -1)
  }
}

/** Collapse a user-controlled value to a single trimmed line so it cannot break
 * out of the Markdown instruction blocks it is interpolated into. */
function sanitizeContextValue(value: string | undefined): string {
  return (value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

function textFromParts(parts: NormalizedPart[]): string {
  return parts
    .filter((part): part is Extract<NormalizedPart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim()
}

function stringFromMetadata(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key]
  return typeof value === 'string' ? value : ''
}

function sessionMessageParts(message: GoogleChatTurnMessage): JsonValue[] {
  const parts: JsonValue[] = []
  if (message.text.trim()) parts.push({ type: 'text', text: message.text })
  for (const part of message.parts) {
    if (part.type === 'text') continue
    parts.push({
      type: 'attachment',
      attachment_type: part.type === 'image' ? 'image' : 'file',
      name: part.name,
      mime_type: part.mime_type,
      size: part.size
    })
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }]
}

/**
 * Per-message metadata for the /messages and /execute payloads.
 *
 * WARNING: the `user_email` below is of UNVERIFIED provenance. It is copied
 * straight off the inbound envelope and is deliberately NOT gated by
 * resolveIdentityEmission — an unsigned request can put any address here. It
 * exists for Console display/attribution only and must never be used to source
 * principal labels, DM-principal identity, or credential grants.
 *
 * Today api-rs registers principals only from the session metadata (see
 * createSession), which IS gated, so there is no bypass. Anyone wiring api-rs
 * to read identity out of message metadata must route through that verified
 * session path instead of reading this.
 */
function sessionMetadata(
  threadKey: string,
  message: GoogleChatTurnMessage,
  extra: JsonObject = {}
): JsonObject {
  return {
    source: 'googlechatbot',
    platform: 'googlechat',
    message_id: message.id,
    thread_id: threadKey,
    is_mention: message.isMention,
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    user_id: message.userId,
    user_name: message.userName,
    ...(message.userEmail ? { user_email: message.userEmail } : {}),
    ...extra
  }
}

function toCodexInputLine(
  threadKey: string,
  message: GoogleChatTurnMessage,
  overrides?: TurnOverrides,
  history?: GoogleChatTurnMessage[],
  staged: ReadonlyMap<NormalizedPart, string> = new Map()
): string {
  return JSON.stringify({
    type: 'user',
    thread_key: threadKey,
    trace_metadata: sessionMetadata(threadKey, message, { action: 'execute' }),
    // Per-turn knobs ride the blocks-protocol top-level fields (codex harness).
    ...(overrides?.model ? { model: overrides.model } : {}),
    ...(overrides?.provider ? { provider: overrides.provider } : {}),
    ...(overrides?.reasoning ? { reasoning: overrides.reasoning } : {}),
    message: {
      role: 'user',
      content: codexInputContent(threadKey, message, history, staged)
    }
  })
}

export function toCodexInputLines(
  config: AppConfig,
  threadKey: string,
  message: GoogleChatTurnMessage,
  overrides?: TurnOverrides,
  history?: GoogleChatTurnMessage[]
): string[] {
  const staged = new Map<NormalizedPart, string>()
  let aggregateBytes = 0
  for (const part of message.parts) {
    if (part.type === 'text' || !part.source?.data) continue
    const bytes = base64DecodedSize(part.source.data)
    if (bytes < 0 || bytes !== part.size) {
      throw new Error(`invalid attachment payload for ${part.name}`)
    }
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit: ${part.name}`)
    }
    aggregateBytes += bytes
    if (aggregateBytes > config.GOOGLECHATBOT_ATTACHMENT_AGGREGATE_MAX_BYTES) {
      throw new Error(
        `attachment payloads exceed ${config.GOOGLECHATBOT_ATTACHMENT_AGGREGATE_MAX_BYTES} byte aggregate limit`
      )
    }
    if (bytes > MAX_INLINE_ATTACHMENT_BYTES) {
      staged.set(part, `google-chat-${message.id}-${staged.size + 1}`)
    }
  }

  const lines: string[] = []
  for (const [part, id] of staged) lines.push(...stagedAttachmentInputLines(part, id))
  lines.push(toCodexInputLine(threadKey, message, overrides, history, staged))
  return lines
}

function base64DecodedSize(value: string): number {
  if (value.length === 0 || value.length % 4 !== 0) return -1
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index)
    if (
      !(code >= 48 && code <= 57)
      && !(code >= 65 && code <= 90)
      && !(code >= 97 && code <= 122)
      && code !== 43
      && code !== 47
    ) return -1
  }
  return value.length / 4 * 3 - padding
}

function stagedAttachmentInputLines(part: NormalizedPart, attachmentId: string): string[] {
  if (part.type === 'text' || !part.source?.data) return []
  const lines: string[] = []
  const chunkSize = STAGED_ATTACHMENT_CHUNK_CHARS - (STAGED_ATTACHMENT_CHUNK_CHARS % 4)
  const chunkCount = Math.ceil(part.source.data.length / chunkSize)
  const sha256 = createHash('sha256').update(Buffer.from(part.source.data, 'base64')).digest('hex')
  for (let offset = 0, index = 0; offset < part.source.data.length; offset += chunkSize, index++) {
    lines.push(JSON.stringify({
      type: 'attachment.chunk',
      attachmentId,
      name: part.name,
      mimeType: part.mime_type,
      attachmentType: part.type,
      chunkIndex: index,
      chunkCount,
      byteSize: part.size,
      sha256,
      final: offset + chunkSize >= part.source.data.length,
      dataBase64: part.source.data.slice(offset, offset + chunkSize)
    }))
  }
  return lines
}

/**
 * Upload-destination block prepended to every executed turn, mirroring
 * slackbotv2's "Slack Session Context". Gives the agent the exact space/thread
 * resource names so `google-chat upload` can deliver files into this thread
 * (the bot relays the upload; the DWD credential never leaves it).
 */
function chatSessionContext(message: GoogleChatTurnMessage, threadKey: string): string | undefined {
  if (!message.spaceName) return undefined
  const thread = message.threadName

  const lines = [
    '# Google Chat Session Context',
    '',
    'API-owned Google Chat upload destination for this turn:',
    `- session_context.google_chat.space_name: ${message.spaceName}`,
    ...(thread ? [`- session_context.google_chat.thread_name: ${thread}`] : []),
    `- thread_key: ${threadKey}`,
    '',
    'Use these exact resource names for Google Chat file uploads in this thread.',
    `Example: google-chat upload ${message.spaceName} /path/to/file${thread ? ` --thread ${thread}` : ''}`,
    'Do not recover this destination with Google Chat search.',
    '---'
  ]
  return lines.join('\n')
}

/**
 * Identity block prepended to every executed turn, mirroring slackbotv2's
 * "Requester Context". Google Chat profiles carry no custom fields, so there is
 * no verified GitHub handle to resolve — attribution falls back to the display
 * name, and the agent is told not to guess a GitHub username from it.
 */
function requesterIdentityContext(message: GoogleChatTurnMessage): string | undefined {
  if (!message.userId && !message.userName) return undefined
  // The display name is attacker-controllable (Google Chat webhooks aren't
  // signed), so flatten it to a single line before it enters this instruction
  // block — a newline would otherwise let it inject its own attribution lines.
  const userName = sanitizeContextValue(message.userName)
  const promptedBy = userName || 'unknown Google Chat requester'

  const lines = [
    '# Requester Context',
    '',
    'The Google Chat user who prompted this turn is:',
    ...(message.userId ? [`- Google Chat user ID: ${sanitizeContextValue(message.userId)}`] : []),
    ...(userName ? [`- Google Chat display name: ${userName}`] : []),
    '- GitHub handle: unavailable (Google Chat profiles carry no GitHub field)',
    '',
    '## GitHub PR Attribution',
    '',
    '- If you create a GitHub PR for this Google Chat request, '
      + `the PR body MUST contain this standalone line: \`Prompted by: ${promptedBy}\``,
    "- Use the requester's Google Chat display name because no verified GitHub "
      + 'handle is available.',
    '- Do not infer a GitHub username from the Google Chat display name or email.',
    '- The credited prompter is the requester in this section, not the thread OP/root author.',
    '- This is a GitHub PR body requirement, not a Google Chat response mention rule.',
    '',
    'The user message follows in the next content block.',
    '---'
  ]
  return lines.join('\n')
}

/** Newest-biased char budget for the thread-context block. Appended messages
 * in api-rs never reach the harness input, and the harness conversation state
 * dies with its sandbox (pool drains, reaps), so this block is the agent's
 * only durable memory of the thread — mirror slackbotv2's per-turn thread
 * context rather than relying on sandbox resume. */
const THREAD_CONTEXT_MAX_CHARS = 24_000

function threadHistoryContext(
  message: GoogleChatTurnMessage,
  history: GoogleChatTurnMessage[] | undefined
): string | undefined {
  const priorMessages = (history ?? []).filter(
    item => item.id !== message.id && item.text.trim()
  )
  if (priorMessages.length === 0) return undefined

  // Keep the newest messages inside the budget — recency carries the most
  // context for a reply, matching collectThreadHistory's cap direction.
  const kept: GoogleChatTurnMessage[] = []
  let totalChars = 0
  for (let index = priorMessages.length - 1; index >= 0; index--) {
    const item = priorMessages[index]
    if (!item) continue
    if (kept.length > 0 && totalChars + item.text.length > THREAD_CONTEXT_MAX_CHARS) break
    kept.unshift(item)
    totalChars += item.text.length
  }

  const lines = [
    '# Google Chat Thread Context',
    '',
    'Earlier messages in this Google Chat thread, in chronological order:'
  ]
  if (kept.length < priorMessages.length) {
    lines.push('', `…(${priorMessages.length - kept.length} earlier messages truncated)`)
  }
  for (const [index, item] of kept.entries()) {
    const author =
      item.role === 'assistant'
        ? 'assistant (you)'
        : sanitizeContextValue(item.userName) || 'user'
    lines.push('', `${index + 1}. ${author}:`, indentChatContext(item.text))
  }
  lines.push('', '# Current Request', '', 'The user message follows in the next content block.', '---')
  return lines.join('\n')
}

function indentChatContext(text: string): string {
  return text
    .split('\n')
    .map(line => `   ${line}`)
    .join('\n')
}

function codexInputContent(
  threadKey: string,
  message: GoogleChatTurnMessage,
  history?: GoogleChatTurnMessage[],
  staged: ReadonlyMap<NormalizedPart, string> = new Map()
): JsonValue[] {
  const content: JsonValue[] = []
  const sessionContext = chatSessionContext(message, threadKey)
  if (sessionContext) content.push({ type: 'text', text: sessionContext })
  const requesterContext = requesterIdentityContext(message)
  if (requesterContext) content.push({ type: 'text', text: requesterContext })
  const threadContext = threadHistoryContext(message, history)
  if (threadContext) content.push({ type: 'text', text: threadContext })
  if (message.text.trim()) content.push({ type: 'text', text: message.text })
  for (const part of message.parts) {
    if (part.type === 'text') continue
    const stagedAttachmentId = staged.get(part)
    if (stagedAttachmentId) {
      content.push({
        type: 'attachment',
        attachment_type: part.type,
        stagedAttachmentId,
        mimeType: part.mime_type,
        name: part.name,
        size: part.size
      })
      continue
    }
    if (part.source?.data && part.mime_type) {
      // Byte-bearing files use the shared harness attachment path so images
      // are materialized locally instead of becoming literal data URLs.
      content.push({
        type: 'attachment',
        attachment_type: part.type,
        dataBase64: part.source.data,
        mimeType: part.mime_type,
        name: part.name,
        size: part.size
      })
      continue
    }
    // No bytes (Drive file, oversized, or a failed download): a descriptive
    // placeholder so the agent at least knows a file was attached.
    content.push({
      type: 'text',
      text: `[Google Chat attachment: name=${part.name} type=${part.type} mime=${part.mime_type}]`
    })
  }
  return content.length > 0 ? content : [{ type: 'text', text: 'continue' }]
}

function apiSessionUrl(
  config: AppConfig,
  threadKey: string,
  suffix?: 'messages' | 'execute' | 'events' | 'interrupt'
): string {
  const path = `/api/session/${encodeURIComponent(threadKey)}${suffix ? `/${suffix}` : ''}`
  return new URL(path, ensureTrailingSlash(config.CENTAUR_API_URL)).toString()
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function apiHeaders(config: AppConfig, jsonBody = true): HeadersInit {
  const apiKey = centaurApiKey(config)
  return {
    ...(jsonBody ? { 'content-type': 'application/json' } : {}),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  }
}

async function ensureApiOk(response: Response, action: string): Promise<void> {
  if (response.ok) return
  let body = ''
  try {
    body = await response.text()
  } catch {
    body = ''
  }
  if (body) {
    logWarn('googlechatbot_session_api_error', {
      action,
      status: response.status,
      status_text: response.statusText,
      body
    })
  }
  throw new SessionApiError({
    action,
    body,
    retryable: isRetryableApiStatus(response.status),
    status: response.status,
    statusText: response.statusText
  })
}

function isRetryableApiStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

// ---------------------------------------------------------------------------
// SSE parsing (mirrors discordbot/slackbotv2 session-api stream handling)
// ---------------------------------------------------------------------------

type ParsedSessionEvent = {
  data: string
  event?: string
  id?: number
}

async function* parseSessionEventStream(
  stream: ReadableStream<Uint8Array>,
  onEventId: (eventId: number) => void
): AsyncIterable<RustSessionStreamEvent> {
  for await (const event of parseSseEvents(stream)) {
    if (typeof event.id === 'number') onEventId(event.id)
    if (event.event === 'session.output.line') {
      yield {
        data: event.data,
        event: event.event,
        eventId: event.id,
        eventKind: event.event
      }
      if (isTerminalCodexOutputLine(event.data)) return
      continue
    }
    if (event.event === 'session.activity_summary') {
      yield {
        data: sessionEventData(event),
        event: event.event,
        eventId: event.id,
        eventKind: event.event
      }
      continue
    }
    if (event.event === 'session.execution_failed' || event.event === 'session.stream_error') {
      yield {
        data: { error: sessionErrorMessage(event) },
        event: event.event,
        eventId: event.id,
        eventKind: event.event
      }
      return
    }
    if (event.event === 'session.execution_cancelled') {
      yield {
        data: { error: sessionErrorMessage(event, 'Execution cancelled') },
        event: event.event,
        eventId: event.id,
        eventKind: event.event
      }
      return
    }
    if (event.event === 'session.execution_completed') {
      yield {
        data: sessionEventData(event),
        event: event.event,
        eventId: event.id,
        eventKind: event.event
      }
      return
    }
  }
}

async function* parseSseEvents(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<ParsedSessionEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let eventId: number | undefined
  let data: string[] = []

  // The consumer returns early on terminal events, abandoning this generator at
  // a yield point. Without the finally the reader lock is never released and the
  // SSE connection leaks on every completed run.
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const emitted = parseSseLine(line, { data, eventId, eventName })
        data = emitted.state.data
        eventId = emitted.state.eventId
        eventName = emitted.state.eventName
        if (emitted.event) yield emitted.event
      }
    }

    buffer += decoder.decode()
    if (buffer) {
      const emitted = parseSseLine(buffer, { data, eventId, eventName })
      data = emitted.state.data
      eventId = emitted.state.eventId
      eventName = emitted.state.eventName
      if (emitted.event) yield emitted.event
    }
    if (data.length > 0) {
      yield { data: data.join('\n'), event: eventName, id: eventId }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function parseSseLine(
  line: string,
  state: { data: string[]; eventId?: number; eventName?: string }
): {
  event?: ParsedSessionEvent
  state: { data: string[]; eventId?: number; eventName?: string }
} {
  if (!line.trim()) {
    const event =
      state.data.length > 0
        ? { data: state.data.join('\n'), event: state.eventName, id: state.eventId }
        : undefined
    return { event, state: { data: [] } }
  }
  if (line.startsWith(':')) return { state }

  const separator = line.indexOf(':')
  const field = separator >= 0 ? line.slice(0, separator) : line
  const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : ''
  if (field === 'event') return { state: { ...state, eventName: value } }
  if (field === 'id') {
    const id = Number.parseInt(value, 10)
    return { state: { ...state, eventId: Number.isFinite(id) ? id : undefined } }
  }
  if (field === 'data' && value !== '[DONE]') {
    return { state: { ...state, data: [...state.data, value] } }
  }
  return { state }
}

function isTerminalCodexOutputLine(line: string): boolean {
  let payload: unknown
  try {
    payload = JSON.parse(line)
  } catch {
    // Non-JSON stdout lines (sandbox bootstrap notices) are noise, not a signal
    // that the turn finished; treating them as terminal drops the answer.
    return false
  }
  if (typeof payload !== 'object' || payload === null) return false
  const record = payload as Record<string, unknown>
  return (
    record.type === 'turn.completed' ||
    record.type === 'turn.failed' ||
    record.type === 'turn.done' ||
    record.method === 'error' ||
    record.method === 'turn/completed'
  )
}

function sessionEventData(event: ParsedSessionEvent): unknown {
  try {
    return JSON.parse(event.data)
  } catch {
    return event.data
  }
}

function sessionErrorMessage(event: ParsedSessionEvent, fallback?: string): string {
  let message = fallback ?? `${event.event ?? 'session error'}`
  try {
    const payload = JSON.parse(event.data)
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>
      if (typeof record.error === 'string') message = record.error
      else if (typeof record.message === 'string') message = record.message
    }
  } catch {
    if (event.data.trim()) message = event.data.trim()
  }
  return message
}

function emptyStream(): AsyncIterable<RustSessionStreamEvent> {
  return (async function* () {})()
}
