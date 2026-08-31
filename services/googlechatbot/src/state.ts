import { randomUUID } from 'node:crypto'
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
const WORK_INDEX_MAX_LENGTH = 2_000
const WORK_INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const THREAD_STATE_IDS_CAP = 500

export type StateConnectionStatus = {
  attempts: number
  connected: boolean
  lastError?: string
}

/** One delivered Google Chat turn, as this bot saw it on the webhook stream.
 *
 * Deliberately NOT a NormalizedPart list: `NormalizedPart.source.data` carries
 * inline attachment bytes (up to 100 MiB) and would land in the state row.
 * Earlier-turn attachments are re-fed to the agent as metadata only. */
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
  provider?: string | null
  /** Local thread transcript for direct messages, where Google refuses to list
   * messages under app auth. Bounded and deduped by message id. */
  transcript?: TranscriptEntry[]
}

export type CanonicalFinal = {
  answer: string
  error?: string
}

export type GoogleChatWorkObligation = {
  acceptedAt: string
  ackMessageName?: string
  action?: GoogleChatWorkflowEvent
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

export function workLeaseKey(threadKey: string): string {
  return `googlechatbot:work:lease:${threadKey}`
}

export async function persistWork(
  state: StateAdapter,
  obligation: GoogleChatWorkObligation
): Promise<void> {
  await state.set(workKey(obligation.workId), obligation, WORK_INDEX_TTL_MS)
  await state.appendToList(WORK_INDEX_KEY, obligation.workId, {
    maxLength: WORK_INDEX_MAX_LENGTH,
    ttlMs: WORK_INDEX_TTL_MS
  })
}

/**
 * Merge an update into the stored thread state.
 *
 * Scalar fields replace. The id lists and `transcript` are APPENDED to what is
 * stored and then deduped (by id) and capped, so a caller may pass only its new
 * entries and does not have to re-read the row it is racing with.
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

export async function acquireLease(
  state: StateAdapter,
  key: string,
  ttlMs: number,
  refreshMs: number
): Promise<(() => Promise<void>) | null> {
  const token = randomUUID()
  if (!(await state.setIfNotExists(key, token, ttlMs))) return null
  const timer = setInterval(() => {
    void state.get<string>(key).then(value => {
      if (value === token) return state.set(key, token, ttlMs)
    }).catch(() => undefined)
  }, refreshMs)
  return async () => {
    clearInterval(timer)
    if ((await state.get<string>(key).catch(() => null)) === token) {
      await state.delete(key).catch(() => undefined)
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
