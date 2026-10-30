import { createPostgresState } from '@chat-adapter/state-pg'
import type { Logger, StateAdapter } from 'chat'
import pg from 'pg'
import type { AppConfig } from './config'
import type { GoogleChatEnvelope, NormalizedChatEvent } from './chat/types'
import type { GoogleChatWorkflowEvent } from './chat/types'
import { DEFAULT_THREAD_HISTORY_LIMIT } from './chat/normalize'
import type { GoogleChatTurnMessage } from './session-api'
import { setGauge } from './metrics'

export const WORK_INDEX_KEY = 'googlechatbot:work:index'
const WORK_KEY_PREFIX = 'googlechatbot:work:'
const WORK_INDEX_MAX_LENGTH = 2_000
const WORK_INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const STOP_CONTROL_TTL_MS = 24 * 60 * 60 * 1_000
const THREAD_STATE_IDS_CAP = 500

export type StateConnectionStatus = {
  attempts: number
  connected: boolean
  lastError?: string
}

/** A retained DM turn. Keep attachment metadata only; parts can contain 100 MiB of bytes. */
export type TranscriptEntry = {
  id: string
  role: 'user' | 'assistant'
  text: string
  userId: string
  userName: string
  timestamp?: string
  attachments: Array<{ name: string; mimeType: string; size: number }>
}

export type GoogleChatThreadState = {
  activeExecution?: boolean
  executedMessageIds?: string[]
  forwardedMessageIds?: string[]
  harnessType?: string | null
  lastEventId?: number
  model?: string | null
  /** Persona pinned by api-rs when the thread's session was created. Null
   * means the thread is pinned without a persona. */
  personaId?: string | null
  provider?: string | null
  /** Verified email of the person whose message started the active execution;
   * null when it started without one. In a shared space, follow-ups from
   * anyone else are not folded into that run: its proxy carries the starter's
   * own per-turn grants (their desktop, their credentials), so another
   * sender's instructions must not steer it. Cleared when the run finishes. */
  activeRequesterEmail?: string | null
  /** "Added to the running turn…" bubbles for messages folded into the live
   * execution; deleted when that run finalizes. Updates append; `[]` clears. */
  steeringAckMessageNames?: string[]
  /** Local thread transcript for direct messages, where Google refuses to list
   * messages under app auth. Bounded and deduped by message id. */
  transcript?: TranscriptEntry[]
  /** api-rs execution id of the running turn; null once it finishes. A Stop
   * card binds to this so a stale button cannot stop a later execution. */
  activeExecutionId?: string | null
  /** Google event time (ms) of the message that most recently started an
   * execution. An unmentioned message older than this was already context for
   * that run and never starts its own. */
  lastExecutedAt?: number
  /** Google event time (ms) of the latest stop request. A turn whose message
   * predates it does not start; one already executing is interrupted. */
  stopRequestedAt?: number
  /** Set by a mention in an allowed space and cleared by a stop: unmentioned
   * replies in this thread may get a proactive response. */
  proactiveEligible?: boolean
  /** Google event time (ms) of the mention that last opted the thread in, so
   * a stop sent before that mention cannot undo it. */
  proactiveEligibleAt?: number
}

export type CanonicalFinal = {
  answer: string
  error?: string
}

export type GoogleChatWorkObligation = {
  acceptedAt: string
  ackMessageName?: string
  /** Reaction the delegated actor placed on the original message; removed
   * when this work finishes, whatever the outcome. */
  ackReactionName?: string
  action?: GoogleChatWorkflowEvent
  /** An unmentioned message the proactive classifier may answer. It starts an
   * execution or does nothing; it never steers an active one. */
  proactive?: boolean
  canonicalFinal?: CanonicalFinal
  dedupeKey: string
  /** Parsed authenticated envelope, retained until background normalization. */
  envelope?: GoogleChatEnvelope
  event?: NormalizedChatEvent
  eventType?: string
  executionId?: string
  failures: number
  identityVerified: boolean
  identityUserEmail?: string
  lastEventId: number
  replacementMessageName?: string
  stage: 'accepted' | 'thinking' | 'rendering' | 'final'
  workId: string
}

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger
}

export function createDefaultState(
  config: AppConfig,
  logger: Logger = noopLogger,
  onPoolError?: (error: Error) => void
): StateAdapter {
  const pool = new pg.Pool({
    connectionString:
      config.GOOGLECHATBOT_DATABASE_URL ?? config.DATABASE_URL ?? config.POSTGRES_URL,
    connectionTimeoutMillis: config.GOOGLECHATBOT_STATE_POOL_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: config.GOOGLECHATBOT_STATE_POOL_IDLE_TIMEOUT_MS,
    max: config.GOOGLECHATBOT_STATE_POOL_MAX
  })
  pool.on('error', error => {
    onPoolError?.(error)
    logger.warn('googlechatbot postgres pool error', { error: error.message })
  })
  return createPostgresState({
    client: pool,
    keyPrefix: config.GOOGLECHATBOT_STATE_KEY_PREFIX,
    logger: logger.child('postgres-state')
  })
}

export async function ensureStateConnected(
  state: StateAdapter,
  config: AppConfig,
  status: StateConnectionStatus,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    status.attempts = attempt + 1
    try {
      await state.connect()
      status.connected = true
      status.lastError = undefined
      setGauge('googlechatbot_state_connected', 1)
      return
    } catch (error) {
      status.connected = false
      status.lastError = error instanceof Error ? error.message : String(error)
      setGauge('googlechatbot_state_connected', 0)
      const delay = Math.min(
        config.GOOGLECHATBOT_STATE_CONNECT_INITIAL_DELAY_MS * 2 ** attempt,
        config.GOOGLECHATBOT_STATE_CONNECT_MAX_DELAY_MS
      )
      await sleep(delay)
    }
  }
}

export function threadStateKey(threadKey: string): string {
  return `googlechatbot:thread:${threadKey}`
}

export function workKey(workId: string): string {
  return `googlechatbot:work:${workId}`
}

/** Per-obligation render lease: one process at a time drives a given piece of
 * work (live or recovery), and nothing else. It never serializes a thread. */
export function workLeaseKey(workId: string): string {
  return `googlechatbot:work:lease:${workId}`
}

const HANDOFF_TTL_MS = 30_000
const HANDOFF_RENEW_MS = 10_000
const HANDOFF_WAIT_MS = 90_000

export function threadHandoffKey(threadKey: string): string {
  return `googlechatbot:handoff:${threadKey}`
}

/**
 * Serialize the thread's handoff decisions: whether a message starts an
 * execution, steers the active one, or is a stop that must interrupt exactly
 * the execution it saw. Held only across session create/append/execute and
 * stop checks, never across rendering, so a follow-up can reach the active
 * execution while another process owns the response. Waits for a busy lock
 * rather than skipping, because a stop must not be dropped. The lock is
 * renewed while held; `run` receives a signal that aborts if ownership is
 * lost and must check it before each side effect.
 */
export async function withThreadHandoff<T>(
  state: StateAdapter,
  threadKey: string,
  run: (lost: AbortSignal) => Promise<T>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))
): Promise<T> {
  const key = threadHandoffKey(threadKey)
  const deadline = Date.now() + HANDOFF_WAIT_MS
  let lease = await acquireLease(state, key, HANDOFF_TTL_MS, HANDOFF_RENEW_MS)
  while (!lease) {
    if (Date.now() >= deadline) throw new Error(`Google Chat thread handoff is busy: ${threadKey}`)
    await sleep(50)
    lease = await acquireLease(state, key, HANDOFF_TTL_MS, HANDOFF_RENEW_MS)
  }
  try {
    return await run(lease.lost)
  } finally {
    await lease.release()
  }
}

export async function persistWork(
  state: StateAdapter,
  obligation: GoogleChatWorkObligation
): Promise<void> {
  await state.set(workKey(obligation.workId), obligation, WORK_INDEX_TTL_MS)
}

/** First durable write of an obligation. Also appends it to the rolling list
 * index that in-memory adapters recover from; Postgres recovery queries the
 * records themselves (see listPendingWorkIds), so a long-lived obligation can
 * never be evicted from discovery by later accepted work. */
export async function acceptWork(
  state: StateAdapter,
  obligation: GoogleChatWorkObligation
): Promise<void> {
  await persistWork(state, obligation)
  await state.appendToList(WORK_INDEX_KEY, obligation.workId, {
    maxLength: WORK_INDEX_MAX_LENGTH,
    ttlMs: WORK_INDEX_TTL_MS
  })
}

/** Durably stored pending work, oldest first. Authoritative on Postgres: every
 * unexpired `googlechatbot:work:<id>` record is returned regardless of how
 * many obligations were accepted after it. Other adapters (tests) fall back to
 * the append-once list index. */
export async function listPendingWorkIds(
  state: StateAdapter,
  keyPrefix: string
): Promise<string[]> {
  const pool = postgresPool(state)
  if (!pool) return Array.from(new Set(await state.getList<string>(WORK_INDEX_KEY)))
  const result = await pool.query<{ cache_key: string }>(
    `SELECT cache_key FROM chat_state_cache
     WHERE key_prefix = $1
       AND cache_key LIKE $2
       AND cache_key NOT LIKE $3
       AND cache_key <> $4
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY updated_at ASC`,
    [keyPrefix, `${WORK_KEY_PREFIX}%`, `${WORK_KEY_PREFIX}lease:%`, WORK_INDEX_KEY]
  )
  return result.rows.map(row => row.cache_key.slice(WORK_KEY_PREFIX.length))
}

function postgresPool(state: StateAdapter): pg.Pool | undefined {
  const candidate = state as { getClient?: () => pg.Pool }
  return typeof candidate.getClient === 'function' ? candidate.getClient() : undefined
}

/** Durable binding from the acknowledgement that carries a Stop button to the
 * work it may cancel. Written when the button is shown and deleted at final,
 * so a click on a button that outlived its turn finds nothing to stop. */
export type StopControl = { workId: string; threadKey: string; spaceName: string }

/** A Stop card's intent, scoped to the one obligation its binding names.
 * Written before the handoff lock so a turn still starting sees it; a stale
 * card therefore touches nothing but its own long-finished work. */
export function workStopKey(workId: string): string {
  // Outside WORK_KEY_PREFIX on purpose: pending-work discovery scans that
  // namespace, and a stop marker must never be mistaken for an obligation.
  return `googlechatbot:stop-work:${workId}`
}

/** Records when the stop was requested on Google's clock (the click's event
 * time), so the turn it stops can raise the thread cutoff to that instant. */
export async function requestWorkStop(
  state: StateAdapter,
  workId: string,
  requestedAt: number = Date.now()
): Promise<void> {
  await state.set(workStopKey(workId), requestedAt, STOP_CONTROL_TTL_MS)
}

export async function workStopRequested(state: StateAdapter, workId: string): Promise<boolean> {
  return (await workStopRequestedAt(state, workId)) !== null
}

/** The stop's request time, or null when no stop is bound to this work. */
export async function workStopRequestedAt(state: StateAdapter, workId: string): Promise<number | null> {
  const value = await state.get<number>(workStopKey(workId))
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function clearWorkStop(state: StateAdapter, workId: string): Promise<void> {
  await state.delete(workStopKey(workId))
}

export function stopControlKey(ackMessageName: string): string {
  return `googlechatbot:stop-control:${ackMessageName}`
}

export async function persistStopControl(
  state: StateAdapter,
  ackMessageName: string,
  control: StopControl
): Promise<void> {
  await state.set(stopControlKey(ackMessageName), control, STOP_CONTROL_TTL_MS)
}

export async function clearStopControl(state: StateAdapter, ackMessageName: string): Promise<void> {
  await state.delete(stopControlKey(ackMessageName))
}

/**
 * Merge thread state under a lock. ID lists and transcript entries append,
 * dedupe, and retain their newest bounded tail. Empty steering ack lists clear.
 */
export async function updateThreadState(
  state: StateAdapter,
  threadKey: string,
  update: Partial<GoogleChatThreadState>,
  transcriptLimit: number = DEFAULT_THREAD_HISTORY_LIMIT
): Promise<GoogleChatThreadState> {
  const key = threadStateKey(threadKey)
  const lock = await state.acquireLock(key, 30_000)
  if (!lock) throw new Error(`Google Chat thread state is busy: ${threadKey}`)
  try {
    const current = (await state.get<GoogleChatThreadState>(key)) ?? {}
    const next = { ...current, ...update }
    // A stop cutoff only ever moves forward: a late-delivered older stop must
    // not lower the cutoff a newer stop already set.
    if (update.stopRequestedAt !== undefined && current.stopRequestedAt !== undefined) {
      next.stopRequestedAt = Math.max(current.stopRequestedAt, update.stopRequestedAt)
    }
    if (next.forwardedMessageIds) {
      next.forwardedMessageIds = capIds([
        ...(current.forwardedMessageIds ?? []),
        ...(update.forwardedMessageIds ?? [])
      ])
    }
    if (next.executedMessageIds) {
      next.executedMessageIds = capIds([
        ...(current.executedMessageIds ?? []),
        ...(update.executedMessageIds ?? [])
      ])
    }
    if (update.steeringAckMessageNames) {
      next.steeringAckMessageNames = update.steeringAckMessageNames.length === 0
        ? []
        : capIds([
          ...(current.steeringAckMessageNames ?? []),
          ...update.steeringAckMessageNames
        ])
    }
    if (next.transcript) {
      next.transcript = capTranscript(
        [...(current.transcript ?? []), ...(update.transcript ?? [])],
        transcriptLimit
      )
    }
    await state.set(key, next)
    return next
  } finally {
    await state.releaseLock(lock)
  }
}

/** Transcript entry for a turn, keeping attachment metadata and dropping bytes. */
export function transcriptEntryFromTurn(message: GoogleChatTurnMessage): TranscriptEntry {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    userId: message.userId,
    userName: message.userName,
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    attachments: message.parts.flatMap(part =>
      part.type === 'text'
        ? []
        : [{ name: part.name, mimeType: part.mime_type, size: part.size }]
    )
  }
}

/** The delivered assistant answer as a turn message, keyed by the Google
 * message name it was delivered under so redelivery is idempotent. */
export function assistantTurnMessage(id: string, answer: string): GoogleChatTurnMessage {
  return {
    id,
    role: 'assistant',
    text: answer,
    parts: [],
    isMention: false,
    userId: '',
    userName: 'Centaur'
  }
}

/** Transcript replayed as the `history_messages` shape turnMessagesFromEvent
 * consumes. Attachments come back as a metadata note, never as bytes. */
export function transcriptHistoryMessages(
  transcript: TranscriptEntry[] | undefined,
  excludeMessageId: string
): NonNullable<NormalizedChatEvent['history_messages']> {
  return (transcript ?? [])
    .filter(entry => entry.id !== excludeMessageId)
    .map(entry => {
      const text = [
        entry.text,
        ...entry.attachments.map(
          file => `[attachment: ${file.name} (${file.mimeType}, ${file.size} bytes)]`
        )
      ].filter(Boolean).join('\n')
      return {
        message_id: entry.id,
        role: entry.role,
        parts: text ? [{ type: 'text' as const, text }] : [],
        user_id: entry.userId,
        metadata: {
          user_name: entry.userName,
          ...(entry.timestamp ? { create_time: entry.timestamp } : {})
        }
      }
    })
}

export type WorkLease = {
  /** Token-checked release; a successor's lease is never touched. */
  release: () => Promise<void>
  /** Aborted once a renewal finds the lease expired or owned by a successor.
   * The worker must stop mutating or finishing the work after this. */
  lost: AbortSignal
}

export class LeaseLostError extends Error {
  constructor(key: string) {
    super(`Google Chat work lease was lost: ${key}`)
    this.name = 'LeaseLostError'
  }
}

/** Exclusive lease on `key` backed by the state adapter's token-checked locks:
 * acquisition, renewal, and release are each one ownership-checked statement,
 * so an expired owner can neither extend nor delete its successor's lease. */
export async function acquireLease(
  state: StateAdapter,
  key: string,
  ttlMs: number,
  refreshMs: number
): Promise<WorkLease | null> {
  const acquireAttemptedAt = Date.now()
  const lock = await state.acquireLock(key, ttlMs)
  if (!lock) return null
  if (Date.now() >= acquireAttemptedAt + ttlMs) {
    // The acquire itself took the whole TTL: the row may already be a
    // successor's. Give it back (bounded) rather than start with no authority.
    await Promise.race([
      state.releaseLock(lock).catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, ttlMs).unref?.())
    ])
    return null
  }
  const lost = new AbortController()
  // Authority ends at a conservative deadline the database can only be later
  // than: the time each acquire/renew was ISSUED plus the TTL, never the time
  // its answer arrived. A dedicated timer revokes at that instant, so a
  // renewal that never answers, or answers late, cannot stretch ownership
  // past the row's real expiry; nothing moves the deadline backwards, and a
  // confirmation that arrives after it does not revive the lease.
  let deadline = acquireAttemptedAt + ttlMs
  let released = false
  let renewing = false
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const revoke = () => {
    clearTimeout(deadlineTimer)
    clearInterval(renewTimer)
    if (!lost.signal.aborted) lost.abort(new LeaseLostError(key))
  }
  const armDeadline = () => {
    clearTimeout(deadlineTimer)
    deadlineTimer = setTimeout(revoke, Math.max(0, deadline - Date.now()))
    deadlineTimer.unref?.()
  }
  armDeadline()
  const renewTimer = setInterval(() => {
    if (lost.signal.aborted || released || renewing) return
    renewing = true
    const attemptedAt = Date.now()
    void state.extendLock(lock, ttlMs).then(extended => {
      renewing = false
      if (lost.signal.aborted || released) return
      // The deadline timer may still be queued behind this callback; the
      // clock, not the timer, decides whether this answer is current.
      if (Date.now() >= deadline) return revoke()
      if (!extended) return revoke()
      const confirmedUntil = attemptedAt + ttlMs
      if (confirmedUntil > deadline) {
        deadline = confirmedUntil
        armDeadline()
      }
    }).catch(() => {
      renewing = false
    })
  }, Math.min(refreshMs, ttlMs))
  renewTimer.unref?.()
  return {
    lost: lost.signal,
    release: async () => {
      // No renewal survives a release, whatever the database answers later.
      released = true
      clearInterval(renewTimer)
      clearTimeout(deadlineTimer)
      if (lost.signal.aborted) return
      // Bounded: a release that cannot reach the database must not hold a
      // draining process; the row expires on its own at the deadline.
      await Promise.race([
        state.releaseLock(lock).catch(() => undefined),
        new Promise<void>(resolve => setTimeout(resolve, ttlMs).unref?.())
      ])
    }
  }
}

function capIds(ids: string[]): string[] {
  return Array.from(new Set(ids)).slice(-THREAD_STATE_IDS_CAP)
}

function capTranscript(entries: TranscriptEntry[], limit: number): TranscriptEntry[] {
  const byId = new Map<string, TranscriptEntry>()
  for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry)
  return Array.from(byId.values()).slice(-Math.max(1, Math.floor(limit)))
}
