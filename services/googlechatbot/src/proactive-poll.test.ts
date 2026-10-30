import { beforeEach, describe, expect, test } from 'bun:test'
import { createMemoryState } from '@chat-adapter/state-memory'
import type { StateAdapter } from 'chat'
import { ChatEdgeClient } from './chat/client'
import { EventDeduper, chatDedupKey } from './chat/dedup'
import type { ChatListMessage } from './chat/types'
import { loadConfig } from './config'
import { renderMetrics, resetMetrics } from './metrics'
import {
  compareRfc3339,
  cursorKey,
  oneNanosecondBefore,
  pollSpace,
  type PollCursor
} from './proactive-poll'
import { threadStateKey, type GoogleChatWorkObligation } from './state'

const SPACE = 'spaces/ROOM'
const THREAD = 'spaces/ROOM/threads/T1'
const THREAD_KEY = `chat:spaces:ROOM:${THREAD.replace(/\//g, ':')}`
const BOT = 'users/123456789'
// Timestamps must sit inside CHAT_EVENT_MAX_AGE_SECONDS of the wall clock, so
// everything is relative to a whole second taken a minute ago. `nanos` adds
// sub-millisecond digits the way Google's createTime carries them.
const BASE_MS = Math.floor(Date.now() / 1000) * 1000 - 60_000
function at(offsetMs: number, nanos = 0): string {
  const iso = new Date(BASE_MS + offsetMs).toISOString()
  if (nanos === 0) return iso
  const fraction = ((BASE_MS + offsetMs) % 1000) * 1_000_000 + nanos
  return `${iso.slice(0, 19)}.${String(fraction).padStart(9, '0')}Z`
}

function listed(id: string, createTime: string, extra: Partial<ChatListMessage> = {}): ChatListMessage {
  return {
    name: `${SPACE}/messages/${id}`,
    text: `message ${id}`,
    createTime,
    thread: { name: THREAD },
    threadReply: true,
    sender: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' },
    ...extra
  }
}

function harness(opts: { state?: StateAdapter; pages?: ChatListMessage[][]; now?: number } = {}) {
  const state = opts.state ?? createMemoryState()
  const config = loadConfig({
    GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'false',
    GOOGLECHATBOT_PROACTIVITY_ENABLED: 'true',
    GOOGLECHATBOT_PROACTIVITY_SPACES: SPACE,
    OPENAI_API_KEY: 'k'
  })
  const client = new ChatEdgeClient(config)
  const listCalls: Array<{ filter?: string; pageToken?: string }> = []
  const pages = opts.pages ?? [[]]
  client.getSpace = async () => ({ name: SPACE, spaceType: 'SPACE' })
  client.getBotUserName = async () => BOT
  client.listMessages = async (_space, listOpts = {}) => {
    listCalls.push({ filter: listOpts.filter, pageToken: listOpts.pageToken })
    // The real API accepts only `>` on createTime; `>=` is INVALID_ARGUMENT
    // (verified live against a shared space).
    if (!/^createTime > "[^"]+"$/.test(listOpts.filter ?? '')) {
      throw new Error(`Invalid filter query: ${listOpts.filter}`)
    }
    const index = listOpts.pageToken ? Number(listOpts.pageToken) : 0
    const page = pages[index] ?? []
    return { messages: page, ...(index + 1 < pages.length ? { nextPageToken: String(index + 1) } : {}) }
  }
  const enqueued: GoogleChatWorkObligation[] = []
  const deps = {
    client,
    config,
    deduper: new EventDeduper(state, 60_000),
    spaces: [SPACE],
    state,
    enqueue: (work: GoogleChatWorkObligation) => { enqueued.push(work) },
    now: () => opts.now ?? BASE_MS
  }
  return { state, client, deps, enqueued, listCalls }
}

const names = (works: GoogleChatWorkObligation[]) =>
  works.map(work => work.envelope?.message?.name?.split('/').pop())

describe('RFC 3339 cursor helpers', () => {
  test('orders timestamps with different fractional precision correctly', () => {
    expect(compareRfc3339('2026-10-29T10:00:00Z', '2026-10-29T10:00:00.123456Z')).toBe(-1)
    expect(compareRfc3339('2026-10-29T10:00:00.5Z', '2026-10-29T10:00:00.123456789Z')).toBe(1)
    expect(compareRfc3339('2026-10-29T10:00:00.100Z', '2026-10-29T10:00:00.1Z')).toBe(0)
    expect(compareRfc3339('2026-10-29T10:00:01Z', '2026-10-29T10:00:00.999999999Z')).toBe(1)
    expect(compareRfc3339('2026-10-29T12:00:00+02:00', '2026-10-29T10:00:00Z')).toBe(0)
  })

  test('steps back one nanosecond across fraction and second boundaries', () => {
    expect(oneNanosecondBefore('2026-10-29T10:00:00.000000001Z')).toBe('2026-10-29T10:00:00.000000000Z')
    expect(oneNanosecondBefore('2026-10-29T10:00:00Z')).toBe('2026-10-29T09:59:59.999999999Z')
    expect(oneNanosecondBefore('2026-10-29T10:00:00.5Z')).toBe('2026-10-29T10:00:00.499999999Z')
    expect(compareRfc3339(oneNanosecondBefore('2026-10-29T10:00:00.123Z'), '2026-10-29T10:00:00.123Z')).toBe(-1)
  })
})

describe('proactive poller', () => {
  beforeEach(() => resetMetrics())

  test('seeds the cursor at now, queries with > one nanosecond back, and ignores earlier messages', async () => {
    const { state, deps, enqueued, listCalls } = harness({ pages: [[listed('OLD', at(-1000))]] })
    await state.connect()
    await state.set(threadStateKey(THREAD_KEY), { proactiveEligible: true })
    await pollSpace(deps, SPACE, 1000)
    expect(listCalls[0]!.filter).toBe(`createTime > "${oneNanosecondBefore(at(0))}"`)
    expect(enqueued).toHaveLength(0)
    expect(await state.get<PollCursor>(cursorKey(SPACE))).toEqual({ createTime: at(0), names: [] })
  })

  test('accepts eligible unmentioned messages once, sharing the webhook dedupe key', async () => {
    const { state, deps, enqueued } = harness({
      pages: [[
        listed('M1', at(1000, 1)),
        listed('BOT', at(2000), { sender: { name: BOT, type: 'BOT' } }),
        listed('MENTION', at(3000), {
          annotations: [{ type: 'USER_MENTION', userMention: { user: { name: BOT, type: 'BOT' }, type: 'MENTION' } }]
        }),
        listed('EMPTY', at(4000), { text: '   ' }),
        listed('M2', at(5000))
      ]]
    })
    await state.connect()
    await state.set(threadStateKey(THREAD_KEY), { proactiveEligible: true })
    await pollSpace(deps, SPACE, 1000)
    expect(names(enqueued)).toEqual(['M1', 'M2'])
    expect(enqueued[0]).toMatchObject({ identityVerified: true, stage: 'accepted', eventType: 'MESSAGE' })
    expect(enqueued[0]!.envelope).toMatchObject({
      type: 'MESSAGE', eventTime: at(1000, 1), space: { name: SPACE, spaceType: 'SPACE' }
    })
    // The webhook would use exactly this key, so a double delivery is one turn.
    const key = chatDedupKey({ eventTime: at(5000), spaceName: SPACE, messageName: `${SPACE}/messages/M2` })
    expect(await deps.deduper.acquire(key, 'webhook')).toBe(false)
    expect(await state.get<PollCursor>(cursorKey(SPACE))).toEqual({
      createTime: at(5000), names: [`${SPACE}/messages/M2`]
    })
    // The next pass looks back one nanosecond, lists the cursor message again
    // and skips it by name; the filter never uses `>=`.
    const relisted: string[] = []
    deps.client.listMessages = async (_space, listOpts = {}) => {
      relisted.push(listOpts.filter ?? '')
      return { messages: [listed('M2', at(5000))] }
    }
    await pollSpace(deps, SPACE, 1000)
    expect(relisted).toEqual([`createTime > "${oneNanosecondBefore(at(5000))}"`])
    expect(enqueued).toHaveLength(2)
    const metrics = renderMetrics()
    expect(metrics).toContain('googlechatbot_proactive_collected_total{outcome="bot"} 1')
    expect(metrics).toContain('googlechatbot_proactive_collected_total{outcome="mention"} 1')
    expect(metrics).toContain('googlechatbot_proactive_collected_total{outcome="empty"} 1')
  })

  test('ignores threads without a prior mention and messages seen during an active run', async () => {
    const { state, deps, enqueued } = harness({
      pages: [[listed('M1', at(1000)), listed('M2', at(2000), { thread: { name: 'spaces/ROOM/threads/T2' } })]]
    })
    await state.connect()
    await state.set(threadStateKey(THREAD_KEY), { proactiveEligible: true, activeExecution: true })
    await pollSpace(deps, SPACE, 1000)
    expect(enqueued).toHaveLength(0)
    expect(renderMetrics()).toContain('googlechatbot_proactive_collected_total{outcome="active_execution"} 1')
    expect(renderMetrics()).toContain('googlechatbot_proactive_collected_total{outcome="not_eligible"} 1')
    // Both were handled, so the cursor moves past them.
    expect((await state.get<PollCursor>(cursorKey(SPACE)))?.createTime).toBe(at(2000))
  })

  test('follows pagination across a shared timestamp without skipping or repeating', async () => {
    const { state, deps, enqueued } = harness({
      pages: [
        [listed('A', at(1000)), listed('B', at(2000))],
        [listed('C', at(2000)), listed('D', at(3000))]
      ]
    })
    await state.connect()
    await state.set(threadStateKey(THREAD_KEY), { proactiveEligible: true })
    await pollSpace(deps, SPACE, 1000)
    expect(names(enqueued)).toEqual(['A', 'B', 'C', 'D'])
    expect(await state.get<PollCursor>(cursorKey(SPACE))).toEqual({
      createTime: at(3000), names: [`${SPACE}/messages/D`]
    })
  })

  test('two messages at the cursor timestamp split across passes are both answered once', async () => {
    const { state, deps, enqueued } = harness({ pages: [[listed('A', at(1000))]] })
    await state.connect()
    await state.set(threadStateKey(THREAD_KEY), { proactiveEligible: true })
    await pollSpace(deps, SPACE, 1000)
    expect(names(enqueued)).toEqual(['A'])
    // B shares A's createTime but only became visible after the first pass.
    deps.client.listMessages = async () => ({ messages: [listed('A', at(1000)), listed('B', at(1000))] })
    await pollSpace(deps, SPACE, 1000)
    await pollSpace(deps, SPACE, 1000)
    expect(names(enqueued)).toEqual(['A', 'B'])
    expect(await state.get<PollCursor>(cursorKey(SPACE))).toEqual({
      createTime: at(1000), names: [`${SPACE}/messages/A`, `${SPACE}/messages/B`]
    })
  })

  test('does not advance past a message whose acceptance failed', async () => {
    const { state, deps, enqueued } = harness({
      pages: [[listed('A', at(1000)), listed('B', at(2000)), listed('C', at(3000))]]
    })
    await state.connect()
    await state.set(threadStateKey(THREAD_KEY), { proactiveEligible: true })
    const realSet = state.set.bind(state)
    let failOnce = true
    state.set = async (key, value, ttl) => {
      const record = value as { envelope?: { message?: { name?: string } } }
      if (failOnce && key.startsWith('googlechatbot:work:') && record.envelope?.message?.name?.endsWith('/B')) {
        failOnce = false
        throw new Error('transient database failure')
      }
      return realSet(key, value, ttl)
    }
    await pollSpace(deps, SPACE, 1000)
    expect(names(enqueued)).toEqual(['A'])
    expect(await state.get<PollCursor>(cursorKey(SPACE))).toEqual({
      createTime: at(1000), names: [`${SPACE}/messages/A`]
    })
    expect(renderMetrics()).toContain('googlechatbot_proactive_poll_total{outcome="halted"} 1')
    // The failed message was released from dedupe and is accepted next pass.
    await pollSpace(deps, SPACE, 1000)
    expect(names(enqueued)).toEqual(['A', 'B', 'C'])
  })

  test('only one poller holds a space at a time', async () => {
    const { state, deps, listCalls } = harness({ pages: [[]] })
    await state.connect()
    const other = harness({ state, pages: [[]] })
    await Promise.all([pollSpace(deps, SPACE, 1000), pollSpace(other.deps, SPACE, 1000)])
    expect(listCalls.length + other.listCalls.length).toBe(1)
  })

  test('a polled message older than the event age limit is dropped, not replied to late', async () => {
    const { state, deps, enqueued } = harness({
      pages: [[listed('LATE', at(-20 * 60_000))]],
      now: BASE_MS - 21 * 60_000
    })
    await state.connect()
    await state.set(threadStateKey(THREAD_KEY), { proactiveEligible: true })
    await pollSpace(deps, SPACE, 1000)
    expect(enqueued).toHaveLength(0)
    expect(renderMetrics()).toContain('rejected_stale_event_timestamp')
  })
})
