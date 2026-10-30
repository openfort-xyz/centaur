import { afterAll, describe, expect, test } from 'bun:test'
import { createMemoryState } from '@chat-adapter/state-memory'
import { createPostgresState } from '@chat-adapter/state-pg'
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config'
import {
  assistantTurnMessage,
  ensureStateConnected,
  WORK_INDEX_KEY,
  persistWork,
  threadStateKey,
  transcriptEntryFromTurn,
  transcriptHistoryMessages,
  updateThreadState,
  workKey,
  type GoogleChatThreadState,
  type GoogleChatWorkObligation,
  type StateConnectionStatus
} from './state'
import { EventDeduper } from './chat/dedup'

const postgresUrl = process.env.GOOGLECHATBOT_TEST_DATABASE_URL ?? 'postgres:///postgres'
const adapters: Array<ReturnType<typeof createPostgresState>> = []

afterAll(async () => {
  await Promise.all(adapters.map(adapter => adapter.disconnect()))
})

test('steering ack names append on hold and clear on an empty update', async () => {
  const state = createMemoryState()
  await state.connect()
  await updateThreadState(state, 'thread-steering', { steeringAckMessageNames: ['spaces/A/messages/1'] })
  await updateThreadState(state, 'thread-steering', {
    activeExecution: true,
    steeringAckMessageNames: ['spaces/A/messages/2']
  })
  expect((await state.get<GoogleChatThreadState>(threadStateKey('thread-steering')))
    ?.steeringAckMessageNames).toEqual(['spaces/A/messages/1', 'spaces/A/messages/2'])
  await updateThreadState(state, 'thread-steering', { activeExecution: false, steeringAckMessageNames: [] })
  expect(await state.get<GoogleChatThreadState>(threadStateKey('thread-steering'))).toMatchObject({
    activeExecution: false,
    steeringAckMessageNames: []
  })
  await state.disconnect()
})

describe('durable Google Chat state', () => {
  test('readiness stays disconnected through bounded exponential retries', async () => {
    const state = createMemoryState()
    let attempts = 0
    state.connect = async () => {
      attempts += 1
      if (attempts < 3) throw new Error('not ready')
    }
    const delays: number[] = []
    const status: StateConnectionStatus = { attempts: 0, connected: false }
    await ensureStateConnected(
      state,
      loadConfig({
        GOOGLECHATBOT_STATE_CONNECT_INITIAL_DELAY_MS: '2',
        GOOGLECHATBOT_STATE_CONNECT_MAX_DELAY_MS: '3'
      }),
      status,
      async delay => {
        expect(status.connected).toBe(false)
        delays.push(delay)
      }
    )
    expect(status).toEqual({ attempts: 3, connected: true, lastError: undefined })
    expect(delays).toEqual([2, 3])
  })

  test('two Postgres adapters share dedupe, thread state, and obligations across restart', async () => {
    const prefix = `googlechatbot-test-${randomUUID()}`
    const first = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    const second = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    adapters.push(first, second)
    // Initialize the adapter schema before connecting the second test replica.
    await first.connect()
    await second.connect()

    const dedupe1 = new EventDeduper(first, 60_000)
    const dedupe2 = new EventDeduper(second, 60_000)
    expect(await dedupe1.acquire('message:1', 'first')).toBe(true)
    expect(await dedupe2.acquire('message:1', 'second')).toBe(false)
    await dedupe1.complete('message:1')

    await updateThreadState(first, 'thread-1', {
      activeExecution: true,
      executedMessageIds: ['m1'],
      forwardedMessageIds: ['m1'],
      harnessType: 'codex',
      lastEventId: 7,
      model: 'gpt-5.6-sol',
      provider: 'openai'
    })
    const work = obligation()
    await persistWork(first, work)

    await Promise.all([first.disconnect(), second.disconnect()])
    const restarted = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    adapters.push(restarted)
    await restarted.connect()
    expect(await restarted.get(threadStateKey('thread-1'))).toMatchObject({
      activeExecution: true,
      executedMessageIds: ['m1'],
      forwardedMessageIds: ['m1'],
      harnessType: 'codex',
      lastEventId: 7,
      model: 'gpt-5.6-sol',
      provider: 'openai'
    })
    expect(await restarted.get(workKey(work.workId))).toMatchObject({ workId: work.workId })
    expect(await new EventDeduper(restarted, 60_000).acquire('message:1', 'third')).toBe(false)

    const actionSecond = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    adapters.push(actionSecond)
    await actionSecond.connect()
    const actionA = new EventDeduper(restarted, 60_000)
    expect(await actionA.acquire('action:user-1:approve:a', 'a')).toBe(true)
    expect(await new EventDeduper(actionSecond, 60_000).acquire('action:user-1:approve:a', 'b'))
      .toBe(false)
    expect(await actionA.acquire('action:user-2:approve:a', 'c')).toBe(true)
    expect(await actionA.acquire('action:user-1:reject:a', 'd')).toBe(true)
    expect(await actionA.acquire('action:user-1:approve:b', 'e')).toBe(true)

    await updateThreadState(restarted, 'thread-capped', {
      executedMessageIds: Array.from({ length: 510 }, (_, index) => `e${index}`),
      forwardedMessageIds: Array.from({ length: 510 }, (_, index) => `f${index}`),
      harnessType: 'codex',
      model: 'gpt-5.6-sol',
      provider: 'openai'
    })
    const capped = await restarted.get<{
      executedMessageIds: string[]
      forwardedMessageIds: string[]
      reasoning?: string
    }>(threadStateKey('thread-capped'))
    expect(capped?.executedMessageIds).toHaveLength(500)
    expect(capped?.executedMessageIds[0]).toBe('e10')
    expect(capped?.forwardedMessageIds).toHaveLength(500)
    expect(capped?.forwardedMessageIds[0]).toBe('f10')
    expect(capped).not.toHaveProperty('reasoning')

    await restarted.disconnect()
    const restartedAgainA = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    const restartedAgainB = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    adapters.push(restartedAgainA, restartedAgainB)
    await restartedAgainA.connect()
    await restartedAgainB.connect()
    expect(await restartedAgainA.get(threadStateKey('thread-capped'))).toMatchObject({
      harnessType: 'codex', model: 'gpt-5.6-sol', provider: 'openai'
    })
    expect(await restartedAgainB.get(workKey(work.workId))).toMatchObject({ workId: work.workId })
  }, 120_000)
  test('the DM transcript round-trips, dedupes by id, caps at limit, drops bytes', async () => {
    const state = createMemoryState()
    await state.connect()
    const entry = transcriptEntryFromTurn({
      id: 'spaces/AAAA/messages/M1',
      role: 'user',
      text: 'look at this',
      parts: [
        { type: 'text', text: 'look at this' },
        {
          type: 'image',
          name: 'shot.png',
          mime_type: 'image/png',
          size: 3,
          source: { type: 'base64', media_type: 'image/png', data: 'QUFB' }
        }
      ],
      isMention: true,
      userId: 'users/U1',
      userName: 'Alice',
      timestamp: '2026-08-31T00:00:00Z'
    })
    expect(entry.attachments).toEqual([{ name: 'shot.png', mimeType: 'image/png', size: 3 }])
    expect(JSON.stringify(entry)).not.toContain('QUFB')

    // Same entry twice: a redelivered webhook must not grow the transcript.
    await updateThreadState(state, 'dm-thread', { transcript: [entry] }, 3)
    await updateThreadState(state, 'dm-thread', { transcript: [entry] }, 3)
    const stored = await state.get<GoogleChatThreadState>(threadStateKey('dm-thread'))
    expect(stored?.transcript).toEqual([entry])

    const answer = transcriptEntryFromTurn(assistantTurnMessage('spaces/AAAA/messages/A1', 'hi'))
    await updateThreadState(state, 'dm-thread', { transcript: [answer] }, 3)
    expect(transcriptHistoryMessages(
      (await state.get<GoogleChatThreadState>(threadStateKey('dm-thread')))?.transcript,
      'spaces/AAAA/messages/A1'
    )).toEqual([{
      message_id: 'spaces/AAAA/messages/M1',
      role: 'user',
      parts: [{ type: 'text', text: 'look at this\n[attachment: shot.png (image/png, 3 bytes)]' }],
      user_id: 'users/U1',
      metadata: { user_name: 'Alice', create_time: '2026-08-31T00:00:00Z' }
    }])

    for (const id of ['m2', 'm3', 'm4']) {
      await updateThreadState(state, 'dm-thread', { transcript: [{ ...entry, id }] }, 3)
    }
    const capped = await state.get<GoogleChatThreadState>(threadStateKey('dm-thread'))
    expect(capped?.transcript?.map(item => item.id)).toEqual(['m2', 'm3', 'm4'])
  })
})

function obligation(): GoogleChatWorkObligation {
  return {
    acceptedAt: new Date().toISOString(),
    dedupeKey: 'message:1',
    event: {
      thread_key: 'thread-1',
      message_id: 'm1',
      space_name: 'spaces/A',
      space_type: 'SPACE',
      user_id: 'users/U1',
      user_name: 'Alice',
      is_mention: true,
      parts: [{ type: 'text', text: 'hello' }],
      chat: {}
    },
    failures: 0,
    identityVerified: true,
    lastEventId: 0,
    stage: 'accepted',
    workId: randomUUID()
  }
}

describe('lease authority and stop ordering', () => {
  test('authority ends at the conservative deadline, not at the next refresh tick', async () => {
    // ttl 200 / refresh 75: the first renewal is issued at ~75 and answers at
    // ~115, so the database row expires at 275 (75 + 200). The second renewal
    // hangs. Authority must end at 275, not at the first tick after 315 (375).
    const { acquireLease } = await import('./state')
    const state = createMemoryState()
    await state.connect()
    const extendCalls: number[] = []
    const started = Date.now()
    state.extendLock = () => {
      extendCalls.push(Date.now() - started)
      if (extendCalls.length === 1) {
        return new Promise<boolean>(resolve => setTimeout(() => resolve(true), 40))
      }
      return new Promise<boolean>(() => undefined)
    }
    const lease = await acquireLease(state, 'review:lease', 200, 75)
    expect(lease).not.toBeNull()
    // Timers never fire early, so the revocation instant has a hard lower
    // bound at the row's expiry; a sleep-based "still owned at 250" check
    // would be racy under load because the sleep itself can overshoot 275.
    let lostAt = Number.NaN
    lease!.lost.addEventListener('abort', () => { lostAt = Date.now() - started }, { once: true })
    await new Promise(resolve => setTimeout(resolve, 300 - (Date.now() - started)))
    expect(lease!.lost.aborted).toBe(true)
    expect(lostAt).toBeGreaterThanOrEqual(270)
    // Exactly one renewal was in flight at a time: 75 (answered) and 150 (hung).
    expect(extendCalls).toHaveLength(2)
    expect(extendCalls[0]).toBeGreaterThanOrEqual(70)
    expect(extendCalls[1]).toBeGreaterThanOrEqual(145)
    // Release after loss touches nothing and is bounded even if the database hangs.
    let releases = 0
    state.releaseLock = async () => { releases += 1; await new Promise<void>(() => undefined) }
    const releaseStarted = Date.now()
    await lease!.release()
    expect(Date.now() - releaseStarted).toBeLessThan(100)
    expect(releases).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(extendCalls).toHaveLength(2)
    await state.disconnect()
  })

  test('a renewal answered after the deadline does not revive the lease, and release stops renewals', async () => {
    const { acquireLease } = await import('./state')
    const state = createMemoryState()
    await state.connect()
    const pending: Array<(value: boolean) => void> = []
    let extendCalls = 0
    state.extendLock = () => {
      extendCalls += 1
      return new Promise<boolean>(resolve => { pending.push(resolve) })
    }
    const lease = await acquireLease(state, 'review:lease', 200, 50)
    await new Promise(resolve => setTimeout(resolve, 230))
    expect(lease!.lost.aborted).toBe(true)
    expect(extendCalls).toBe(1)
    pending[0]!(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lease!.lost.aborted).toBe(true)

    // A healthy lease released explicitly issues no further renewals.
    state.extendLock = async () => true
    const healthy = await acquireLease(state, 'review:lease2', 500, 30)
    await healthy!.release()
    const before = extendCalls
    state.extendLock = async () => { extendCalls += 1; return true }
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(extendCalls).toBe(before)
    await state.disconnect()
  })

  test('the clock, not a pending timer, decides whether an acquire or a renewal answer is current', async () => {
    const { acquireLease } = await import('./state')
    const state = createMemoryState()
    await state.connect()
    const realNow = Date.now
    let offset = 0
    Date.now = () => realNow() + offset
    try {
      // An acquire whose answer arrives after its own TTL yields no authority.
      const realAcquire = state.acquireLock.bind(state)
      state.acquireLock = async (key, ttl) => {
        const lock = await realAcquire(key, ttl)
        offset += 500
        return lock
      }
      let releases = 0
      const realRelease = state.releaseLock.bind(state)
      state.releaseLock = async lock => { releases += 1; await realRelease(lock) }
      expect(await acquireLease(state, 'late-acquire', 200, 50)).toBeNull()
      expect(releases).toBe(1)
      state.acquireLock = realAcquire

      // A renewal that resolves after the deadline, before the deadline timer
      // has had a chance to run, still revokes synchronously.
      let resolveExtend!: (value: boolean) => void
      state.extendLock = () => new Promise<boolean>(resolve => { resolveExtend = resolve })
      const lease = await acquireLease(state, 'late-renewal', 200, 50)
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(lease!.lost.aborted).toBe(false)
      offset += 300
      resolveExtend(true)
      await Promise.resolve()
      await Promise.resolve()
      expect(lease!.lost.aborted).toBe(true)
      await lease!.release()
    } finally {
      Date.now = realNow
      await state.disconnect()
    }
  })

  test('an older late-delivered stop never lowers the cutoff or undoes a newer opt-in', async () => {
    const state = createMemoryState()
    await state.connect()
    await updateThreadState(state, 'T', { stopRequestedAt: 3000, proactiveEligible: false })
    await updateThreadState(state, 'T', { proactiveEligible: true, proactiveEligibleAt: 2500 })
    await updateThreadState(state, 'T', { stopRequestedAt: 1000 })
    const stored = await state.get<GoogleChatThreadState>(threadStateKey('T'))
    expect(stored?.stopRequestedAt).toBe(3000)
    expect(stored?.proactiveEligible).toBe(true)
    await updateThreadState(state, 'T', { stopRequestedAt: 4000 })
    expect((await state.get<GoogleChatThreadState>(threadStateKey('T')))?.stopRequestedAt).toBe(4000)
    await state.disconnect()
  })
})

describe('durable recovery boundaries on PostgreSQL', () => {
  // The disposable database can sit behind a slow port-forward; give each
  // integration case room without weakening what it asserts.
  const SLOW_DB_TIMEOUT_MS = 120_000
  const settle = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 60_000) => {
    const started = Date.now()
    while (!(await predicate())) {
      if (Date.now() - started > timeoutMs) throw new Error('condition never became true')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  test('an unfinished obligation stays discoverable after the list index evicted it', async () => {
    const { acceptWork, listPendingWorkIds } = await import('./state')
    const prefix = `googlechatbot-test-${randomUUID()}`
    const state = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    adapters.push(state)
    await state.connect()
    const first = obligation()
    await acceptWork(state, first)
    // 2,500 later accepted obligations, written directly so the test does not
    // spend minutes on a slow link; one more adapter append then trims the
    // rolling index to its 2,000-entry cap exactly as production would.
    await state.getClient().query(
      `INSERT INTO chat_state_lists (key_prefix, list_key, value, expires_at)
       SELECT $1, $2, to_jsonb(gen_random_uuid()::text)::text, now() + interval '30 days'
       FROM generate_series(1, 2500)`,
      [prefix, WORK_INDEX_KEY]
    )
    const latest = { ...obligation(), workId: randomUUID() }
    await acceptWork(state, latest)
    await persistWork(state, { ...latest, stage: 'thinking' })
    await state.delete(workKey(latest.workId))
    const indexed = await state.getList<string>(WORK_INDEX_KEY)
    expect(indexed.length).toBeLessThanOrEqual(2_000)
    expect(indexed.includes(first.workId)).toBe(false)
    expect(await listPendingWorkIds(state, prefix)).toEqual([first.workId])
  }, SLOW_DB_TIMEOUT_MS)

  test('a work-scoped stop marker is never discovered as pending work', async () => {
    const { acceptWork, clearWorkStop, listPendingWorkIds, requestWorkStop, workStopRequestedAt } = await import('./state')
    const prefix = `googlechatbot-test-${randomUUID()}`
    const state = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    adapters.push(state)
    await state.connect()
    const work = obligation()
    await acceptWork(state, work)
    await requestWorkStop(state, work.workId, 1_700_000_000_000)
    await requestWorkStop(state, randomUUID())
    expect(await workStopRequestedAt(state, work.workId)).toBe(1_700_000_000_000)
    expect(await listPendingWorkIds(state, prefix)).toEqual([work.workId])
    await clearWorkStop(state, work.workId)
    expect(await workStopRequestedAt(state, work.workId)).toBeNull()
  }, SLOW_DB_TIMEOUT_MS)

  test('an expired lease owner can neither renew nor release its successor', async () => {
    const { acquireLease } = await import('./state')
    const prefix = `googlechatbot-test-${randomUUID()}`
    const first = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    const second = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    adapters.push(first, second)
    await first.connect()
    await second.connect()
    const key = 'googlechatbot:work:lease:shared'
    const owner = await acquireLease(first, key, 2_000, 200)
    expect(owner).not.toBeNull()
    // A paused owner: its row expires before it renews, and a successor takes over.
    await first.getClient().query(
      `UPDATE chat_state_locks SET expires_at = now() - interval '1 second' WHERE key_prefix = $1 AND thread_id = $2`,
      [prefix, key]
    )
    const successor = await acquireLease(second, key, 60_000, 30_000)
    expect(successor).not.toBeNull()
    // The old owner's next renewal is refused and it learns it lost the lease.
    await settle(() => owner!.lost.aborted)
    await owner!.release()
    // The successor still holds the lease: the old owner's release did not touch it.
    expect(await acquireLease(first, key, 1_000, 500)).toBeNull()
    await successor!.release()
    const third = await acquireLease(first, key, 1_000, 500)
    expect(third).not.toBeNull()
    await third!.release()
  }, SLOW_DB_TIMEOUT_MS)

  test('the thread handoff lock renews while held and waits rather than skips', async () => {
    const { withThreadHandoff } = await import('./state')
    const prefix = `googlechatbot-test-${randomUUID()}`
    const state = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    adapters.push(state)
    await state.connect()
    const order: string[] = []
    let release!: () => void
    const held = withThreadHandoff(state, 'thread-h', async lost => {
      order.push('first-start')
      await new Promise<void>(resolve => { release = resolve })
      expect(lost.aborted).toBe(false)
      order.push('first-end')
    })
    await settle(() => order.includes('first-start'))
    const waiting = withThreadHandoff(state, 'thread-h', async () => { order.push('second') })
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(order).toEqual(['first-start'])
    release()
    await Promise.all([held, waiting])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  }, SLOW_DB_TIMEOUT_MS)

  test('legacy cache-entry thread leases are not consulted by lock-based workers', async () => {
    // Baseline workers leased a whole thread via setIfNotExists on a cache
    // key. The replacement uses the locks table, so the two never contend;
    // the chart therefore rolls googlechatbot out with Recreate so old and
    // new workers never run side by side. Legacy obligations themselves are
    // plain work records and remain recoverable.
    const { acceptWork, acquireLease, listPendingWorkIds } = await import('./state')
    const prefix = `googlechatbot-test-${randomUUID()}`
    const state = createPostgresState({ url: postgresUrl, keyPrefix: prefix })
    adapters.push(state)
    await state.connect()
    const legacy = obligation()
    await state.set(workKey(legacy.workId), legacy, 60_000)
    await state.set('googlechatbot:work:lease:thread-1', 'legacy-token', 60_000)
    expect(await listPendingWorkIds(state, prefix)).toEqual([legacy.workId])
    const lease = await acquireLease(state, 'googlechatbot:work:lease:thread-1', 1_000, 500)
    expect(lease).not.toBeNull()
    await lease!.release()
    await acceptWork(state, { ...obligation(), workId: randomUUID() })
    expect((await listPendingWorkIds(state, prefix)).length).toBe(2)
  }, SLOW_DB_TIMEOUT_MS)
})
