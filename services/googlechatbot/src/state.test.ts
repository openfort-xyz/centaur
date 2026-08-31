import { afterAll, describe, expect, test } from 'bun:test'
import { createMemoryState } from '@chat-adapter/state-memory'
import { createPostgresState } from '@chat-adapter/state-pg'
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config'
import {
  assistantTurnMessage,
  ensureStateConnected,
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
    // Adapter schema initialization is not concurrency-safe on a brand-new DB;
    // production migrations create it ahead of replicas, so establish one first.
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
  })
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
