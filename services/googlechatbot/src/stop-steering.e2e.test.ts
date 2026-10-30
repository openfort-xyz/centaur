import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createMemoryState } from '@chat-adapter/state-memory'
import { createGooglechatbot, type Googlechatbot } from './index'
import { loadConfig } from './config'
import { generateRsaKeyPair, signJwt } from './chat/test-jwt'
import { renderMetrics, resetMetrics } from './metrics'
import { STOP_CARD_FUNCTION } from './renderer'
import {
  acceptWork,
  persistStopControl,
  threadStateKey,
  type GoogleChatThreadState,
  type GoogleChatWorkObligation
} from './state'
import { installSessionMock, threadKeyFor, waitFor, type SessionMock } from './test-session-mock'

const BASE_ENV = {
  CHAT_EVENTS_PATH: '/api/chat/events',
  GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'false',
  GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS: '3600000'
}
const DM_THREAD = threadKeyFor('DM', 'T1')
const SPACE_THREAD = threadKeyFor('ROOM', 'T1')
const BOT = 'users/123456789'
// Every runtime a test creates; drained before the next test so background
// renders and sweeps cannot land on a later test's mock.
const runtimes: Googlechatbot[] = []
function tracked(runtime: Googlechatbot): Googlechatbot {
  runtimes.push(runtime)
  return runtime
}
async function drainRuntimes(): Promise<void> {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown(10_000)))
}

type Message = Record<string, unknown>

function dmEvent(id: string, text: string, eventTime = new Date().toISOString()) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'MESSAGE',
      eventTime,
      space: { name: 'spaces/DM', spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
      message: {
        name: `spaces/DM/messages/${id}`,
        text,
        thread: { name: 'spaces/DM/threads/T1' },
        threadReply: true,
        sender: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' }
      },
      user: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' }
    })
  }
}

function mentionEvent(id: string, text: string, user = 'users/U1', eventTime = new Date().toISOString()) {
  return {
    type: 'MESSAGE',
    eventTime,
    space: { name: 'spaces/ROOM', spaceType: 'SPACE' },
    message: {
      name: `spaces/ROOM/messages/${id}`,
      text,
      thread: { name: 'spaces/ROOM/threads/T1' },
      threadReply: true,
      sender: { name: user, displayName: user, type: 'HUMAN' },
      annotations: [{ type: 'USER_MENTION', userMention: { user: { name: BOT, type: 'BOT' }, type: 'MENTION' } }]
    },
    user: { name: user, displayName: user, type: 'HUMAN' }
  }
}

function cardClick(ackMessageName: string, space = 'spaces/DM', eventTime = new Date().toISOString()) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'CARD_CLICKED',
      eventTime,
      space: { name: space, spaceType: space === 'spaces/DM' ? 'DIRECT_MESSAGE' : 'SPACE' },
      message: { name: ackMessageName, thread: { name: `${space}/threads/T1` } },
      user: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' },
      common: { invokedFunction: STOP_CARD_FUNCTION, parameters: { work_id: 'forged', execution_id: 'forged' } }
    })
  }
}

function ackOf(mock: SessionMock, space = 'spaces/DM'): [string, Message] {
  const entry = [...mock.messages.entries()].find(([name, message]) =>
    name.startsWith(`${space}/messages/client-centaur-ack-`) && typeof message.text === 'string'
  )
  if (!entry) throw new Error('no acknowledgement posted')
  return entry
}

function stopButtonOn(message: Message): boolean {
  return JSON.stringify(message.cardsV2 ?? []).includes(STOP_CARD_FUNCTION)
}

describe('stop reaches api-rs while the response stream is open', () => {
  let mock: SessionMock
  beforeEach(() => {
    resetMetrics()
    mock = installSessionMock()
  })
  afterEach(async () => {
    await drainRuntimes()
    mock.restore()
  })

  const bot = (env: Record<string, string> = {}) => {
    const state = createMemoryState()
    const runtime = tracked(createGooglechatbot(loadConfig({ ...BASE_ENV, ...env }), { state }))
    return { runtime, state, app: runtime.app }
  }

  test('a mentioned "stop" interrupts the live execution before its stream closes', async () => {
    const { app, state } = bot()
    await app.request('/api/chat/events', dmEvent('M1', 'keep working until told otherwise'))
    await waitFor(() => mock.streams.size === 1)
    const [ackName, ack] = ackOf(mock)
    expect(stopButtonOn(ack)).toBe(true)

    await app.request('/api/chat/events', dmEvent('STOP', 'stop'))
    await waitFor(() => mock.interrupts.length === 1)
    expect(mock.interrupts[0]).toMatchObject({ threadKey: DM_THREAD, whileOpen: true, executionId: 'exec-1' })
    expect(mock.executions).toHaveLength(1)

    await waitFor(() => mock.messages.get(ackName)?.text !== undefined
      && String(mock.messages.get(ackName)?.text).includes('interrupted'))
    expect(stopButtonOn(mock.messages.get(ackName)!)).toBe(false)
    expect([...mock.messages.values()].some(m => String(m.text).includes('Stopped the current run'))).toBe(true)
    const thread = await state.get<GoogleChatThreadState>(threadStateKey(DM_THREAD))
    expect(thread?.activeExecution).toBe(false)
    expect(thread?.activeExecutionId).toBeNull()
    expect(renderMetrics()).toContain('googlechatbot_stop_commands_total{outcome="interrupted",source="text"} 1')
  }, 20_000)

  test('the Stop card interrupts the execution it is bound to and drops the button', async () => {
    const { app } = bot()
    await app.request('/api/chat/events', dmEvent('M1', 'long task'))
    await waitFor(() => mock.streams.size === 1)
    const [ackName] = ackOf(mock)

    const response = await app.request('/api/chat/events', cardClick(ackName))
    expect(response.status).toBe(200)
    await waitFor(() => mock.interrupts.length === 1)
    expect(mock.interrupts[0]!.whileOpen).toBe(true)
    expect(mock.interrupts[0]!.executionId).toBe('exec-1')
    await waitFor(() => stopButtonOn(mock.messages.get(ackName)!) === false)
    await waitFor(() => String(mock.messages.get(ackName)?.text).includes('interrupted'))
    expect(mock.executions).toHaveLength(1)
    expect(renderMetrics()).toContain('googlechatbot_stop_commands_total{outcome="interrupted",source="card"} 1')
  }, 20_000)

  test('status PATCHes keep the Stop control; the final replaces it', async () => {
    const { app } = bot()
    await app.request('/api/chat/events', dmEvent('M1', 'status please'))
    await waitFor(() => mock.streams.size === 1)
    const [ackName] = ackOf(mock)

    // Chat API (project-number) mode: a bare function name, no parameters.
    expect(JSON.stringify(mock.messages.get(ackName)!.cardsV2))
      .toContain(JSON.stringify({ action: { function: STOP_CARD_FUNCTION } }))
    mock.status('exec-1', 'running the test suite')
    await waitFor(() => String(mock.messages.get(ackName)?.text).includes('running the test suite'))
    const statusPatch = mock.calls.find(c =>
      c.method === 'PATCH' && String((c.body as Message).text).includes('running the test suite'))
    expect(statusPatch).toBeTruthy()
    expect(JSON.stringify((statusPatch!.body as Message).cardsV2)).toContain(STOP_CARD_FUNCTION)
    expect(stopButtonOn(mock.messages.get(ackName)!)).toBe(true)

    mock.finish('exec-1', 'all green')
    await waitFor(() => mock.messages.get(ackName)?.text === 'all green')
    expect(stopButtonOn(mock.messages.get(ackName)!)).toBe(false)
    expect(mock.interrupts).toHaveLength(0)
  }, 20_000)

  test('a stop that lands while session creation is pending prevents the execute', async () => {
    const { app, state } = bot()
    let releaseCreate!: () => void
    let createWaiting = false
    mock.beforeSessionCreate = async () => {
      if (createWaiting) return
      createWaiting = true
      await new Promise<void>(resolve => { releaseCreate = resolve })
    }
    const sentAt = new Date().toISOString()
    await app.request('/api/chat/events', dmEvent('M1', 'slow to start', sentAt))
    await waitFor(() => createWaiting)
    const [ackName] = ackOf(mock)

    await app.request('/api/chat/events', dmEvent('STOP', 'stop', new Date(Date.parse(sentAt) + 1000).toISOString()))
    // Stop intent is durable before the slow create returns.
    await waitFor(async () =>
      Boolean((await state.get<GoogleChatThreadState>(threadStateKey(DM_THREAD)))?.stopRequestedAt))
    releaseCreate()
    await waitFor(() => mock.messages.get(ackName)?.text === '⏹️ Stopped before the run started.')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mock.executions).toHaveLength(0)
    expect(stopButtonOn(mock.messages.get(ackName)!)).toBe(false)
    expect(renderMetrics()).toContain('googlechatbot_runs_total{outcome="stopped_before_start"} 1')
  }, 20_000)

  test('a Stop card pressed before the execute lands cancels that turn and nothing later', async () => {
    const { app } = bot()
    let releaseCreate!: () => void
    let createWaiting = false
    mock.beforeSessionCreate = async () => {
      if (createWaiting) return
      createWaiting = true
      await new Promise<void>(resolve => { releaseCreate = resolve })
    }
    const sentAt = new Date().toISOString()
    await app.request('/api/chat/events', dmEvent('M1', 'slow to start', sentAt))
    await waitFor(() => createWaiting)
    const [ackName] = ackOf(mock)
    await app.request('/api/chat/events', cardClick(ackName, 'spaces/DM', new Date(Date.parse(sentAt) + 1000).toISOString()))
    await new Promise(resolve => setTimeout(resolve, 50))
    releaseCreate()
    await waitFor(() => mock.messages.get(ackName)?.text === '⏹️ Stopped before the run started.')
    expect(mock.executions).toHaveLength(0)

    // A message sent after the stop still runs: the stop is older than it.
    mock.beforeSessionCreate = undefined
    await app.request('/api/chat/events', dmEvent('M2', 'try again', new Date(Date.parse(sentAt) + 5000).toISOString()))
    await waitFor(() => mock.executions.length === 1)
    expect(mock.interrupts).toHaveLength(0)
    mock.finish('exec-1', 'done')
  }, 20_000)

  test('a Stop card from a finished turn cannot interrupt a newer execution', async () => {
    const { app } = bot()
    await app.request('/api/chat/events', dmEvent('M1', 'first'))
    await waitFor(() => mock.streams.size === 1)
    const [ack1] = ackOf(mock)
    mock.finish('exec-1', 'first answer')
    await waitFor(() => mock.messages.get(ack1)?.text === 'first answer')

    await app.request('/api/chat/events', dmEvent('M2', 'second'))
    await waitFor(() => mock.executions.length === 2 && mock.streams.has('exec-2'))
    await app.request('/api/chat/events', cardClick(ack1))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(mock.interrupts).toHaveLength(0)
    expect(mock.streams.get('exec-2')?.closed).toBe(false)
    expect(renderMetrics()).toContain('googlechatbot_stop_commands_total{outcome="stale",source="card"} 1')
    mock.finish('exec-2', 'second answer')
  }, 20_000)

  test('a Stop card bound to an execution that is no longer active is refused under the lock', async () => {
    // The binding still exists (its turn crashed before clearing it) but the
    // thread has moved on to a newer execution; the click must not touch it.
    const state = createMemoryState()
    await state.connect()
    const stale: GoogleChatWorkObligation = {
      acceptedAt: new Date().toISOString(),
      ackMessageName: 'spaces/DM/messages/client-centaur-ack-old',
      dedupeKey: 'message:old',
      event: {
        thread_key: DM_THREAD, message_id: 'spaces/DM/messages/OLD', space_name: 'spaces/DM',
        space_type: 'DIRECT_MESSAGE', user_id: 'users/U1', user_name: 'Alice', is_mention: true,
        parts: [{ type: 'text', text: 'old' }], chat: { thread_name: 'spaces/DM/threads/T1' }
      },
      executionId: 'exec-old',
      failures: 0,
      identityVerified: false,
      lastEventId: 0,
      stage: 'rendering',
      workId: crypto.randomUUID()
    }
    await state.set(`googlechatbot:work:${stale.workId}`, stale)
    await persistStopControl(state, stale.ackMessageName!, {
      workId: stale.workId, threadKey: DM_THREAD, spaceName: 'spaces/DM'
    })
    await state.set(threadStateKey(DM_THREAD), {
      activeExecution: true, activeExecutionId: 'exec-new', lastExecutedAt: Date.now() + 10_000
    } satisfies GoogleChatThreadState)
    await state.disconnect()
    await state.connect()
    await state.set(threadStateKey(DM_THREAD), {
      activeExecution: true, activeExecutionId: 'exec-new', lastExecutedAt: Date.now() + 10_000,
      proactiveEligible: true, proactiveEligibleAt: Date.now() - 60_000
    } satisfies GoogleChatThreadState)
    await state.disconnect()
    const runtime = tracked(createGooglechatbot(loadConfig(BASE_ENV), { state }))
    await runtime.stateConnected
    await runtime.app.request('/api/chat/events', cardClick(stale.ackMessageName!))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(mock.interrupts).toHaveLength(0)
    expect(renderMetrics()).toContain('googlechatbot_stop_commands_total{outcome="stale",source="card"} 1')
    // Zero thread-wide side effects: no cutoff written, opt-in untouched.
    const after = await state.get<GoogleChatThreadState>(threadStateKey(DM_THREAD))
    expect(after?.stopRequestedAt).toBeUndefined()
    expect(after?.proactiveEligible).toBe(true)
  }, 20_000)

  test('a stale Stop card cannot cancel a newer message that is still starting', async () => {
    const { app, state } = bot()
    await app.request('/api/chat/events', dmEvent('M1', 'first'))
    await waitFor(() => mock.streams.size === 1)
    const [ack1] = ackOf(mock)
    // The old turn crashed before clearing its binding: re-create it.
    const control = { workId: (await state.get<{ workId: string }>(`googlechatbot:stop-control:${ack1}`))!.workId, threadKey: DM_THREAD, spaceName: 'spaces/DM' }
    mock.finish('exec-1', 'first answer')
    await waitFor(() => mock.messages.get(ack1)?.text === 'first answer')
    await persistStopControl(state, ack1, control)

    let releaseCreate!: () => void
    let createWaiting = false
    mock.beforeSessionCreate = async () => {
      if (createWaiting) return
      createWaiting = true
      await new Promise<void>(resolve => { releaseCreate = resolve })
    }
    await app.request('/api/chat/events', dmEvent('M2', 'second, still starting'))
    await waitFor(() => createWaiting)
    await app.request('/api/chat/events', cardClick(ack1))
    await new Promise(resolve => setTimeout(resolve, 200))
    releaseCreate()
    await waitFor(() => mock.executions.length === 2)
    expect(mock.executions[1]!.idempotencyKey).toBe('spaces/DM/messages/M2')
    expect(mock.interrupts).toHaveLength(0)
    expect((await state.get<GoogleChatThreadState>(threadStateKey(DM_THREAD)))?.stopRequestedAt).toBeUndefined()
    mock.finish('exec-2', 'second answer')
  }, 20_000)

  test('a held Google write never delays the interrupt behind a Stop card or text stop', async () => {
    const HOLD_MS = 3_000
    const { app } = bot()
    await app.request('/api/chat/events', dmEvent('M1', 'work'))
    await waitFor(() => mock.streams.size === 1)
    const [ackName] = ackOf(mock)
    const inner = globalThis.fetch
    let held = 0
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH' || (init?.method ?? 'GET') === 'DELETE') {
        held += 1
        await new Promise(resolve => setTimeout(resolve, HOLD_MS))
      }
      return inner(input as string, init)
    }) as typeof fetch
    try {
      mock.status('exec-1', 'still working')
      const clickedAt = Date.now()
      await app.request('/api/chat/events', cardClick(ackName))
      await new Promise(resolve => setTimeout(resolve, 200))
      await app.request('/api/chat/events', dmEvent('STOP', 'stop'))
      await waitFor(() => mock.interrupts.length >= 1, HOLD_MS)
      expect(Date.now() - clickedAt).toBeLessThan(HOLD_MS)
      expect(mock.interrupts[0]!.whileOpen).toBe(true)
      expect(mock.interrupts[0]!.executionId).toBe('exec-1')
      await new Promise(resolve => setTimeout(resolve, HOLD_MS + 500))
      expect(held).toBeGreaterThanOrEqual(1)
      // The final is the last write: its text and cards win.
      await waitFor(() => String(mock.messages.get(ackName)?.text).includes('interrupted'))
      expect(stopButtonOn(mock.messages.get(ackName)!)).toBe(false)
    } finally {
      globalThis.fetch = inner
    }
  }, 20_000)

  test('a Stop card bound to work that never executed cannot interrupt a newer active run', async () => {
    // The old obligation was acknowledged but never reached execute (its
    // binding survived a crash); the thread has since moved on to exec-new.
    const state = createMemoryState()
    await state.connect()
    const pending: GoogleChatWorkObligation = {
      acceptedAt: new Date().toISOString(),
      ackMessageName: 'spaces/DM/messages/client-centaur-ack-pending',
      dedupeKey: 'message:pending',
      event: {
        thread_key: DM_THREAD, message_id: 'spaces/DM/messages/OLD', space_name: 'spaces/DM',
        space_type: 'DIRECT_MESSAGE', user_id: 'users/U1', user_name: 'Alice', is_mention: true,
        parts: [{ type: 'text', text: 'old' }], chat: { thread_name: 'spaces/DM/threads/T1' }
      },
      failures: 0,
      identityVerified: false,
      lastEventId: 0,
      stage: 'thinking',
      workId: crypto.randomUUID()
    }
    await state.set(`googlechatbot:work:${pending.workId}`, pending)
    await persistStopControl(state, pending.ackMessageName!, {
      workId: pending.workId, threadKey: DM_THREAD, spaceName: 'spaces/DM'
    })
    await state.set(threadStateKey(DM_THREAD), {
      activeExecution: true, activeExecutionId: 'exec-new', lastExecutedAt: Date.now() - 10_000,
      proactiveEligible: true, proactiveEligibleAt: Date.now() - 60_000
    } satisfies GoogleChatThreadState)
    await state.disconnect()
    const runtime = tracked(createGooglechatbot(loadConfig(BASE_ENV), { state }))
    await runtime.stateConnected
    await runtime.app.request('/api/chat/events', cardClick(pending.ackMessageName!))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(mock.interrupts).toHaveLength(0)
    const after = await state.get<GoogleChatThreadState>(threadStateKey(DM_THREAD))
    expect(after?.stopRequestedAt).toBeUndefined()
    expect(after?.proactiveEligible).toBe(true)
    expect(after?.activeExecutionId).toBe('exec-new')
    expect(renderMetrics()).toContain('googlechatbot_stop_commands_total{outcome="stale",source="card"} 1')
  }, 20_000)

  test('a mentioned "stop" older than the active turn does not kill it', async () => {
    const { app } = bot()
    const sentAt = Date.now()
    await app.request('/api/chat/events', dmEvent('M1', 'current', new Date(sentAt).toISOString()))
    await waitFor(() => mock.streams.size === 1)
    // Delivered late: Google's event time predates the running turn's message.
    await app.request('/api/chat/events', dmEvent('OLDSTOP', 'stop', new Date(sentAt - 60_000).toISOString()))
    await waitFor(() => [...mock.messages.values()].some(m => String(m.text).includes('no active run')))
    expect(mock.interrupts).toHaveLength(0)
    expect(mock.streams.get('exec-1')?.closed).toBe(false)
    mock.finish('exec-1', 'done')
  }, 20_000)

  test('the ack reaction is added by the delegated actor and removed on final and on stop', async () => {
    const env = {
      GOOGLECHATBOT_REACTION_ACTOR_USER: 'actor@example.com',
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'bot@example.iam.gserviceaccount.com', private_key: 'fixture'
      })
    }
    const { app, runtime } = bot(env)
    const scopes: string[] = []
    const exchanged: Array<{ scope: string; subject?: string }> = []
    ;(runtime.client as unknown as { exchangeJwtForToken: (scope: string, sub?: string) => Promise<unknown> })
      .exchangeJwtForToken = async (scope: string, sub?: string) => {
        scopes.push(scope)
        exchanged.push({ scope, ...(sub ? { subject: sub } : {}) })
        return { token: 'actor-token', expiry: Date.now() + 3_600_000 }
      }
    await app.request('/api/chat/events', dmEvent('M1', 'react to me'))
    await waitFor(() => mock.reactions.size === 1)
    const [reactionName, reaction] = [...mock.reactions.entries()][0]!
    expect(reaction).toEqual({ messageName: 'spaces/DM/messages/M1', unicode: '👀' })
    expect(exchanged).toContainEqual({
      scope: 'https://www.googleapis.com/auth/chat.messages.reactions', subject: 'actor@example.com'
    })
    const reactionCall = mock.calls.find(c => c.method === 'POST' && c.url.includes('/reactions'))
    expect(reactionCall).toBeTruthy()
    await waitFor(() => mock.streams.size === 1)
    mock.finish('exec-1', 'done')
    await waitFor(() => !mock.reactions.has(reactionName))
    expect(renderMetrics()).toContain('googlechatbot_reactions_total{operation="delete",outcome="ok"} 1')

    await app.request('/api/chat/events', dmEvent('M2', 'and again'))
    await waitFor(() => mock.reactions.size === 1 && mock.streams.has('exec-2'))
    await app.request('/api/chat/events', dmEvent('STOP', 'stop'))
    await waitFor(() => mock.interrupts.length === 1)
    await waitFor(() => mock.reactions.size === 0)
  }, 20_000)

  test('reaction failures never block the turn and a 403 disables further attempts', async () => {
    const env = {
      GOOGLECHATBOT_REACTION_ACTOR_USER: 'actor@example.com',
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'bot@example.iam.gserviceaccount.com', private_key: 'fixture'
      })
    }
    const { app, runtime } = bot(env)
    ;(runtime.client as unknown as { exchangeJwtForToken: () => Promise<unknown> })
      .exchangeJwtForToken = async () => ({ token: 'app-token', expiry: Date.now() + 3_600_000 })
    let attempts = 0
    runtime.client.createReaction = async () => {
      attempts += 1
      const { ChatApiError } = await import('./chat/client')
      throw new ChatApiError('POST', 'reactions', 403, 'PERMISSION_DENIED')
    }
    await app.request('/api/chat/events', dmEvent('M1', 'first'))
    await waitFor(() => mock.streams.size === 1)
    mock.finish('exec-1', 'one')
    await waitFor(() => ackOf(mock)[1].text === 'one')
    await app.request('/api/chat/events', dmEvent('M2', 'second'))
    await waitFor(() => mock.executions.length === 2)
    mock.finish('exec-2', 'two')
    expect(attempts).toBe(1)
    expect(renderMetrics()).toContain('googlechatbot_reactions_total{operation="create",outcome="failed"} 1')
  }, 20_000)

  test('without a delegated actor no reaction call is made', async () => {
    const { app } = bot()
    await app.request('/api/chat/events', dmEvent('M1', 'plain'))
    await waitFor(() => mock.streams.size === 1)
    expect(mock.calls.some(c => c.url.includes('/reactions'))).toBe(false)
    mock.finish('exec-1', 'done')
  }, 20_000)
})

describe('stop ordering over the signed ingress', () => {
  let mock: SessionMock
  beforeEach(() => {
    resetMetrics()
    mock = installSessionMock()
  })
  afterEach(async () => {
    await drainRuntimes()
    mock.restore()
  })

  test('a late-delivered older stop cannot lower a newer stop cutoff or revive a stopped turn', async () => {
    const pair = await generateRsaKeyPair()
    const kid = 'stop-order-test'
    const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid }
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/service_accounts/v1/jwk/')) {
        return Response.json({ keys: [jwk] }, { headers: { 'cache-control': 'max-age=3600' } })
      }
      return inner(input as string, init)
    }) as typeof fetch
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt({ privateKey: pair.privateKey, kid, claims: {
      iss: 'chat@system.gserviceaccount.com', aud: 'parity-project', iat: now, exp: now + 300
    } })
    const state = createMemoryState()
    const runtime = tracked(createGooglechatbot(loadConfig({
      CHAT_EVENTS_PATH: '/api/chat/events',
      GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
      GOOGLECHATBOT_PROJECT_NUMBER: 'parity-project'
    }), { state }))
    const signed = async (event: ReturnType<typeof dmEvent>) => {
      const response = await runtime.app.request('/api/chat/events', {
        ...event,
        headers: { ...event.headers, authorization: `Bearer ${token}` }
      })
      expect(response.status).toBe(200)
    }
    const stopAt = async () =>
      (await state.get<GoogleChatThreadState>(threadStateKey(DM_THREAD)))?.stopRequestedAt
    let releaseCreate!: () => void
    let createWaiting = false
    mock.beforeSessionCreate = async () => {
      if (createWaiting) return
      createWaiting = true
      await new Promise<void>(resolve => { releaseCreate = resolve })
    }
    const t0 = Date.now()
    await signed(dmEvent('M1', 'pending turn', new Date(t0).toISOString()))
    await waitFor(() => createWaiting)
    const [ackName] = ackOf(mock)

    // Newer stop, then an older one Google delivered late.
    await signed(dmEvent('S2', 'stop', new Date(t0 + 2000).toISOString()))
    await waitFor(async () => (await stopAt()) === t0 + 2000)
    await signed(dmEvent('S1', 'stop', new Date(t0 - 5000).toISOString()))
    // Both stops persisted their intent before queueing behind the handoff
    // lock the pending turn holds; the cutoff never moved backwards.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await stopAt()).toBe(t0 + 2000)

    releaseCreate()
    // Both stop replies queue behind the handoff lock and then one quota
    // window apart on the per-space write scheduler; allow a slow runtime.
    await waitFor(() => mock.messages.get(ackName)?.text === '⏹️ Stopped before the run started.', 20_000)
    await waitFor(() => [...mock.messages.values()].filter(m => String(m.text).includes('no active run')).length === 2, 20_000)
    expect(await stopAt()).toBe(t0 + 2000)
    expect(mock.executions).toHaveLength(0)
    // api-rs was asked and had nothing to interrupt; no execution ever existed.
    expect(mock.interrupts.every(interrupt => interrupt.executionId === undefined)).toBe(true)

    // A message sent after the newest stop still runs.
    mock.beforeSessionCreate = undefined
    await signed(dmEvent('M2', 'after the stops', new Date(t0 + 3000).toISOString()))
    await waitFor(() => mock.executions.length === 1)
    expect(mock.executions[0]!.idempotencyKey).toBe('spaces/DM/messages/M2')
    mock.finish('exec-1', 'done')
    globalThis.fetch = inner
  }, 60_000)
})

describe('mentioned follow-ups while the response stream is open', () => {
  let mock: SessionMock
  beforeEach(() => {
    resetMetrics()
    mock = installSessionMock()
  })
  afterEach(async () => {
    await drainRuntimes()
    mock.restore()
  })

  test('the active requester steers the live turn; another requester is refused', async () => {
    // Verified identity comes from a Workspace Add-on user token, so sign both
    // the system bearer and the per-user token with a local key.
    const pair = await generateRsaKeyPair()
    const kid = 'steering-test'
    const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid }
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/service_accounts/v1/jwk/') || url.includes('/oauth2/v3/certs')) {
        return Response.json({ keys: [jwk] }, { headers: { 'cache-control': 'max-age=3600' } })
      }
      return inner(input as string, init)
    }) as typeof fetch
    const audience = 'https://chat.example.test/api/chat/events'
    const clientId = 'fixture-client.apps.googleusercontent.com'
    const now = Math.floor(Date.now() / 1000)
    const systemToken = await signJwt({ privateKey: pair.privateKey, kid, claims: {
      iss: 'https://accounts.google.com', aud: audience, iat: now, exp: now + 300,
      email: 'addon@example.iam.gserviceaccount.com', email_verified: true
    } })
    const userToken = (userId: string, email: string) => signJwt({ privateKey: pair.privateKey, kid, claims: {
      iss: 'https://accounts.google.com', aud: clientId, sub: userId.replace(/^users\//, ''),
      email, email_verified: true, iat: now, exp: now + 300
    } })
    const runtime = tracked(createGooglechatbot(loadConfig({
      CHAT_EVENTS_PATH: '/api/chat/events',
      GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
      GOOGLECHATBOT_INGRESS_MODE: 'workspace_addon',
      GOOGLECHATBOT_WEBHOOK_AUDIENCE: audience,
      GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL: 'addon@example.iam.gserviceaccount.com',
      GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID: clientId
    }), { state: createMemoryState() }))
    const send = async (id: string, text: string, user: string, email: string) => {
      const response = await runtime.app.request('/api/chat/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${systemToken}` },
        body: JSON.stringify({
          ...mentionEvent(id, text, user),
          authorizationEventObject: { userIdToken: await userToken(user, email) }
        })
      })
      expect(response.status).toBe(200)
    }
    const appendsFor = (thread: string) => mock.calls.filter(c =>
      c.method === 'POST' && decodeURIComponent(c.url).endsWith(`/api/session/${thread}/messages`)
      && (c.body as { forward_to_active_execution?: boolean }).forward_to_active_execution !== false)

    await send('M1', 'start the long job', 'users/U1', 'alice@example.com')
    await waitFor(() => mock.streams.has('exec-1'))

    // Same verified requester: appended to the live run while its stream is open.
    await send('M2', 'also run the linter', 'users/U1', 'alice@example.com')
    await waitFor(() => [...mock.messages.values()].some(m => String(m.text).includes('added to the running turn')))
    expect(appendsFor(SPACE_THREAD)).toHaveLength(1)
    expect(mock.streams.get('exec-1')?.closed).toBe(false)
    expect(mock.executions).toHaveLength(1)

    // Another verified person: not appended, told the turn is still running.
    await send('M3', 'and delete prod', 'users/U2', 'mallory@example.com')
    await waitFor(() => [...mock.messages.values()].some(m => String(m.text).includes("someone else's turn")))
    expect(appendsFor(SPACE_THREAD)).toHaveLength(1)
    expect(mock.executions).toHaveLength(1)
    expect(mock.streams.get('exec-1')?.closed).toBe(false)

    mock.finish('exec-1', 'job finished')
    await waitFor(() => [...mock.messages.values()].some(m => m.text === 'job finished'))
    // The steering notice is removed when the run finalizes.
    await waitFor(() => ![...mock.messages.values()].some(m => String(m.text).includes('added to the running turn')))
    globalThis.fetch = inner
  }, 20_000)
})

describe('Workspace Add-on Stop card callback', () => {
  let mock: SessionMock
  beforeEach(() => {
    resetMetrics()
    mock = installSessionMock()
  })
  afterEach(async () => {
    await drainRuntimes()
    mock.restore()
  })

  const ENDPOINT = 'https://chat.example.test/api/chat/events'
  const CLIENT_ID = 'fixture-client.apps.googleusercontent.com'
  const SIGNER = 'addon@example.iam.gserviceaccount.com'

  const stopButton = (message: Message) => {
    const cards = message.cardsV2 as Array<{ cardId: string; card: { sections: Array<{ widgets: Array<{ buttonList: { buttons: Array<{ text: string; onClick: { action: { function: string; parameters?: unknown } } }> } }> }> } }> | undefined
    return cards?.find(card => card.cardId === 'centaur-stop')?.card.sections[0]?.widgets[0]?.buttonList.buttons[0]
  }

  async function addonRuntime() {
    const pair = await generateRsaKeyPair()
    const kid = 'addon-stop-test'
    const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid }
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/service_accounts/v1/jwk/') || url.includes('/oauth2/v3/certs')) {
        return Response.json({ keys: [jwk] }, { headers: { 'cache-control': 'max-age=3600' } })
      }
      return inner(input as string, init)
    }) as typeof fetch
    mock.requireAddonCallback = ENDPOINT
    const now = Math.floor(Date.now() / 1000)
    const systemToken = await signJwt({ privateKey: pair.privateKey, kid, claims: {
      iss: 'https://accounts.google.com', aud: ENDPOINT, iat: now, exp: now + 300, email: SIGNER, email_verified: true
    } })
    const userTokenFor = (sub: string, email: string) => signJwt({ privateKey: pair.privateKey, kid, claims: {
      iss: 'https://accounts.google.com', aud: CLIENT_ID, sub, email, email_verified: true, iat: now, exp: now + 300
    } })
    const userToken = await userTokenFor('U1', 'alice@example.com')
    const otherUserToken = await userTokenFor('U2', 'mallory@example.com')
    const state = createMemoryState()
    const runtime = tracked(createGooglechatbot(loadConfig({
      CHAT_EVENTS_PATH: '/api/chat/events',
      GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
      GOOGLECHATBOT_INGRESS_MODE: 'workspace_addon',
      GOOGLECHATBOT_WEBHOOK_AUDIENCE: ENDPOINT,
      GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL: SIGNER,
      GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID: CLIENT_ID
    }), { state }))
    // `token: null` sends no bearer at all (an unsigned delivery).
    const post = (body: unknown, token: string | null = systemToken) => runtime.app.request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    })
    const message = (id: string, text: string, eventTime = new Date().toISOString()) => ({
      authorizationEventObject: { userIdToken: userToken },
      commonEventObject: { hostApp: 'CHAT', platform: 'WEB' },
      chat: {
        eventTime,
        user: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' },
        messagePayload: {
          space: { name: 'spaces/DM', spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
          message: {
            name: `spaces/DM/messages/${id}`, text, thread: { name: 'spaces/DM/threads/T1' }, threadReply: true,
            sender: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' }
          }
        }
      }
    })
    // The documented Add-on click, driven from the rendered card: Google echoes
    // the button's `function` (the endpoint) as the invoked function and its
    // parameters on commonEventObject; the contextual message is the card the
    // APP authored, and the interacting human is `chat.user`.
    const click = (
      ackMessageName: string,
      opts: {
        parameters?: Record<string, string> | null
        eventTime?: string
        userIdToken?: string | null
        user?: { name: string; displayName: string; type: 'HUMAN' } | null
      } = {}
    ) => {
      const action = stopButton(mock.messages.get(ackMessageName) ?? {})?.onClick.action
      const rendered = action?.parameters as Array<{ key: string; value: string }> | undefined
      const parameters = opts.parameters === null
        ? undefined
        : opts.parameters ?? Object.fromEntries((rendered ?? []).map(parameter => [parameter.key, parameter.value]))
      return {
        ...(opts.userIdToken === null ? {} : { authorizationEventObject: { userIdToken: opts.userIdToken ?? userToken } }),
        commonEventObject: {
          hostApp: 'CHAT', platform: 'WEB', invokedFunction: action?.function ?? ENDPOINT,
          ...(parameters ? { parameters } : {})
        },
        chat: {
          eventTime: opts.eventTime ?? new Date().toISOString(),
          ...(opts.user === null ? {} : { user: opts.user ?? { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' } }),
          buttonClickedPayload: {
            space: { name: 'spaces/DM', spaceType: 'DIRECT_MESSAGE' },
            message: {
              name: ackMessageName, thread: { name: 'spaces/DM/threads/T1' },
              sender: { name: 'users/123456789', displayName: 'Centaur', type: 'BOT' },
              cardsV2: (mock.messages.get(ackMessageName)?.cardsV2 as unknown) ?? []
            }
          }
        }
      }
    }
    return { runtime, state, post, message, click, otherUserToken, restore: () => { globalThis.fetch = inner } }
  }

  test('the Stop card calls back to the exact configured endpoint and its click interrupts the open stream', async () => {
    const addon = await addonRuntime()
    try {
      expect((await addon.post(addon.message('M1', 'long task'))).status).toBe(200)
      await waitFor(() => mock.streams.size === 1)
      const [ackName, ack] = ackOf(mock)
      expect(stopButton(ack)!.onClick.action).toEqual({
        function: ENDPOINT, parameters: [{ key: 'actionName', value: STOP_CARD_FUNCTION }]
      })
      mock.status('exec-1', 'still working')
      await waitFor(() => String(mock.messages.get(ackName)?.text).includes('still working'))
      expect(stopButton(mock.messages.get(ackName)!)!.onClick.action.function).toBe(ENDPOINT)

      expect((await addon.post(addon.click(ackName))).status).toBe(200)
      await waitFor(() => mock.interrupts.length === 1)
      expect(mock.interrupts[0]).toMatchObject({ whileOpen: true, executionId: 'exec-1' })
      await waitFor(() => String(mock.messages.get(ackName)?.text).includes('interrupted'))
      expect(stopButton(mock.messages.get(ackName)!)).toBeUndefined()
      expect(mock.executions).toHaveLength(1)
      expect(renderMetrics()).toContain('googlechatbot_stop_commands_total{outcome="interrupted",source="card"} 1')
    } finally {
      addon.restore()
    }
  }, 20_000)

  test('an Add-on click during a pending session create stops that turn before it executes', async () => {
    const addon = await addonRuntime()
    try {
      let releaseCreate!: () => void
      let createWaiting = false
      mock.beforeSessionCreate = async () => {
        if (createWaiting) return
        createWaiting = true
        await new Promise<void>(resolve => { releaseCreate = resolve })
      }
      const sentAt = new Date().toISOString()
      await addon.post(addon.message('M1', 'slow to start', sentAt))
      await waitFor(() => createWaiting)
      const [ackName] = ackOf(mock)
      await addon.post(addon.click(ackName, { eventTime: new Date(Date.parse(sentAt) + 1000).toISOString() }))
      await new Promise(resolve => setTimeout(resolve, 100))
      releaseCreate()
      await waitFor(() => mock.messages.get(ackName)?.text === '⏹️ Stopped before the run started.')
      expect(mock.executions).toHaveLength(0)
      expect(stopButton(mock.messages.get(ackName)!)).toBeUndefined()
      // The click itself settles only after the stopped turn releases the
      // handoff lock; wait for it so its metric cannot leak into a later test.
      await waitFor(() => /source="card"\} 1/.test(renderMetrics()))
      expect(mock.interrupts.every(interrupt => interrupt.executionId === undefined)).toBe(true)
    } finally {
      addon.restore()
    }
  }, 20_000)

  test('stale, malformed, and unverified Add-on callbacks have no effect', async () => {
    const addon = await addonRuntime()
    try {
      await addon.post(addon.message('M1', 'first'))
      await waitFor(() => mock.streams.size === 1)
      const [ack1] = ackOf(mock)
      mock.finish('exec-1', 'first answer')
      await waitFor(() => mock.messages.get(ack1)?.text === 'first answer')
      await addon.post(addon.message('M2', 'second'))
      await waitFor(() => mock.executions.length === 2 && mock.streams.has('exec-2'))
      const ack2 = [...mock.messages.keys()].find(name => name.includes('client-centaur-ack-') && name !== ack1)!

      const liveClick = addon.click(ack2)
      // Stale: the first turn's button after its final (the card is gone, so
      // replay the parameters it carried).
      expect((await addon.post(addon.click(ack1, { parameters: { actionName: STOP_CARD_FUNCTION } }))).status).toBe(200)
      // Malformed: the endpoint echoed with no actionName names no action.
      expect((await addon.post(addon.click(ack2, { parameters: null }))).status).toBe(200)
      expect((await addon.post(addon.click(ack2, { parameters: { work_id: 'forged', execution_id: 'exec-2' } }))).status).toBe(200)
      // Unverified: no Google-signed bearer at all.
      expect((await addon.post(liveClick, null)).status).toBe(401)
      // Signed, but the verified person is not the interacting user.
      expect((await addon.post(addon.click(ack2, { userIdToken: addon.otherUserToken }))).status).toBe(401)
      // Signed, but the envelope names no interacting human at all.
      expect((await addon.post(addon.click(ack2, { user: null }))).status).toBe(401)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(mock.interrupts).toHaveLength(0)
      expect(mock.streams.get('exec-2')?.closed).toBe(false)
      expect((await addon.state.get<GoogleChatThreadState>(threadStateKey(DM_THREAD)))?.stopRequestedAt).toBeUndefined()
      expect(renderMetrics()).toContain('googlechatbot_stop_commands_total{outcome="stale",source="card"} 1')

      // The live button still works afterwards.
      expect((await addon.post(addon.click(ack2))).status).toBe(200)
      await waitFor(() => mock.interrupts.length === 1)
      expect(mock.interrupts[0]!.executionId).toBe('exec-2')
    } finally {
      addon.restore()
    }
  }, 20_000)
})
