import { randomUUID } from 'node:crypto'
import { createPostgresState } from '@chat-adapter/state-pg'
import type { Logger, StateAdapter } from 'chat'
import pg from 'pg'
import type { AppConfig } from './config'
import type { GoogleChatEnvelope, NormalizedChatEvent } from './chat/types'
import type { GoogleChatWorkflowEvent } from './chat/types'
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

export type GoogleChatThreadState = {
  activeExecution?: boolean
  executedMessageIds?: string[]
  forwardedMessageIds?: string[]
  harnessType?: string | null
  lastEventId?: number
  model?: string | null
  provider?: string | null
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

export function dedupeStateKey(dedupeKey: string): string {
  return `googlechatbot:dedupe:${dedupeKey}`
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

export async function updateThreadState(
  state: StateAdapter,
  threadKey: string,
  update: Partial<GoogleChatThreadState>
): Promise<GoogleChatThreadState> {
  const key = threadStateKey(threadKey)
  const lock = await state.acquireLock(key, 30_000)
  if (!lock) throw new Error(`Google Chat thread state is busy: ${threadKey}`)
  try {
    const current = (await state.get<GoogleChatThreadState>(key)) ?? {}
    const next = { ...current, ...update }
    if (next.forwardedMessageIds) next.forwardedMessageIds = capIds(next.forwardedMessageIds)
    if (next.executedMessageIds) next.executedMessageIds = capIds(next.executedMessageIds)
    await state.set(key, next)
    return next
  } finally {
    await state.releaseLock(lock)
  }
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
