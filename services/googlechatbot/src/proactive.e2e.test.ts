import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createMemoryState } from '@chat-adapter/state-memory'
import { createGooglechatbot, type Googlechatbot, type ProactivityRuntime } from './index'
import { loadConfig } from './config'
import { renderMetrics, resetMetrics } from './metrics'
import type { ProactiveClassifierInput } from './proactive-classifier'
import { acceptWork, persistStopControl, threadStateKey, workKey, type GoogleChatThreadState, type GoogleChatWorkObligation } from './state'
import { installSessionMock, threadKeyFor, waitFor, type SessionMock } from './test-session-mock'

const ENV = {
  CHAT_EVENTS_PATH: '/api/chat/events',
  GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'false',
  GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS: '3600000'
}
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
const THREAD = threadKeyFor('ROOM', 'T1')

function roomMessage(id: string, text: string, opts: { mention?: boolean; user?: string; eventTime?: string } = {}) {
  const user = opts.user ?? 'users/U1'
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'MESSAGE',
      eventTime: opts.eventTime ?? new Date().toISOString(),
      space: { name: 'spaces/ROOM', spaceType: 'SPACE' },
      message: {
        name: `spaces/ROOM/messages/${id}`,
        text,
        thread: { name: 'spaces/ROOM/threads/T1' },
        threadReply: true,
        sender: { name: user, displayName: user === 'users/U1' ? 'Alice' : 'Bob', type: 'HUMAN' },
        ...(opts.mention
          ? { annotations: [{ type: 'USER_MENTION', userMention: { user: { name: BOT, type: 'BOT' }, type: 'MENTION' } }] }
          : {})
      },
      user: { name: user, displayName: 'Alice', type: 'HUMAN' }
    })
  }
}

type Decision = { respond: boolean; probability?: number } | Error | 'hang'

function proactivity(decide: (input: ProactiveClassifierInput) => Decision, spaces = ['spaces/ROOM']): {
  runtime: ProactivityRuntime
  inputs: ProactiveClassifierInput[]
} {
  const inputs: ProactiveClassifierInput[] = []
  return {
    inputs,
    runtime: {
      spaces,
      timeoutMs: 100,
      classifier: async (input, signal) => {
        inputs.push(input)
        const decision = decide(input)
        if (decision === 'hang') {
          await new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }
        if (decision instanceof Error) throw decision
        return decision as { respond: boolean; probability?: number }
      }
    }
  }
}

describe('contextual replies in an opted-in space', () => {
  let mock: SessionMock
  beforeEach(() => {
    resetMetrics()
    mock = installSessionMock()
  })
  afterEach(async () => {
    await drainRuntimes()
    mock.restore()
  })

  const bot = (runtime: ProactivityRuntime, env: Record<string, string> = {}) => {
    const state = createMemoryState()
    const app = tracked(createGooglechatbot(loadConfig({ ...ENV, ...env }), { state, proactivity: runtime })).app
    return { app, state }
  }
  const thread = (state: ReturnType<typeof createMemoryState>) =>
    state.get<GoogleChatThreadState>(threadStateKey(THREAD))

  test('a mention opts the thread in; a meaningful follow-up is answered without a mention', async () => {
    const { runtime, inputs } = proactivity(input =>
      input.message.text.includes('thanks') ? { respond: false, probability: 0.1 } : { respond: true, probability: 0.9 })
    const { app, state } = bot(runtime)

    // Before any mention nothing is classified or answered.
    await app.request('/api/chat/events', roomMessage('M0', 'is anyone around?'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(inputs).toHaveLength(0)
    expect(mock.executions).toHaveLength(0)

    await app.request('/api/chat/events', roomMessage('M1', 'why is the deploy red?', { mention: true }))
    await waitFor(() => mock.streams.has('exec-1'))
    expect((await thread(state))?.proactiveEligible).toBe(true)
    mock.finish('exec-1', 'The migration timed out.')
    await waitFor(async () => (await thread(state))?.activeExecution === false)

    // Thanks: classified, declined, silent. Google lists newest first.
    mock.listed.push(
      { name: 'spaces/ROOM/messages/A1', text: 'The migration timed out.', sender: { name: BOT, type: 'BOT' }, createTime: new Date().toISOString(), threadReply: true },
      { name: 'spaces/ROOM/messages/M1', text: 'why is the deploy red?', sender: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' }, createTime: new Date().toISOString(), threadReply: true }
    )
    await app.request('/api/chat/events', roomMessage('M2', 'thanks!'))
    await waitFor(() => inputs.length === 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mock.executions).toHaveLength(1)
    expect(inputs[0]!.message).toEqual({ author: 'Alice', fromBot: false, text: 'thanks!' })
    expect(inputs[0]!.history.map(message => [message.fromBot, message.text])).toEqual([
      [false, 'why is the deploy red?'], [true, 'The migration timed out.']
    ])
    expect(renderMetrics()).toContain('googlechatbot_proactive_decisions_total{outcome="decline"} 1')

    // A real follow-up: answered as its own execution, with an acknowledgement.
    await app.request('/api/chat/events', roomMessage('M3', 'can you retry it?'))
    await waitFor(() => mock.executions.length === 2)
    expect(mock.executions[1]!.idempotencyKey).toBe('spaces/ROOM/messages/M3')
    expect([...mock.messages.values()].some(m => String(m.text).includes('thinking'))).toBe(true)
    expect(renderMetrics()).toContain('googlechatbot_proactive_decisions_total{outcome="respond"} 1')
    mock.finish('exec-2', 'Retried.')
  }, 20_000)

  test('classifier errors and timeouts stay silent', async () => {
    let mode: Decision = new Error('classifier unavailable')
    const { runtime } = proactivity(() => mode)
    const { app, state } = bot(runtime)
    await state.connect()
    await state.set(threadStateKey(THREAD), { proactiveEligible: true } satisfies GoogleChatThreadState)
    await app.request('/api/chat/events', roomMessage('E1', 'what about staging?'))
    await waitFor(() => renderMetrics().includes('googlechatbot_proactive_decisions_total{outcome="error"} 1'))
    mode = 'hang'
    await app.request('/api/chat/events', roomMessage('E2', 'and prod?'))
    await waitFor(() => renderMetrics().includes('googlechatbot_proactive_decisions_total{outcome="error"} 2'))
    expect(mock.executions).toHaveLength(0)
    expect(mock.messages.size).toBe(0)
  }, 20_000)

  test('an unmentioned message never steers an active run, however it is timed', async () => {
    let releaseDecision: (() => void) | undefined
    const { runtime, inputs } = proactivity(() => ({ respond: true, probability: 0.99 }))
    const gated: ProactivityRuntime = {
      ...runtime,
      timeoutMs: 10_000,
      classifier: async (input, signal) => {
        if (releaseDecision === undefined && input.message.text === 'one more') {
          await new Promise<void>(resolve => { releaseDecision = resolve })
        }
        return runtime.classifier(input, signal)
      }
    }
    const { app, state } = bot(gated)
    await state.connect()
    await state.set(threadStateKey(THREAD), { proactiveEligible: true } satisfies GoogleChatThreadState)

    await app.request('/api/chat/events', roomMessage('M1', 'start the job', { mention: true }))
    await waitFor(() => mock.streams.has('exec-1'))

    // Arrives while the run is active: skipped before the classifier runs.
    await app.request('/api/chat/events', roomMessage('M2', 'also do the other thing'))
    await waitFor(() => renderMetrics().includes('skip_active_execution'))
    expect(inputs).toHaveLength(0)
    const appends = () => mock.calls.filter(c => c.method === 'POST'
      && decodeURIComponent(c.url).endsWith(`/api/session/${THREAD}/messages`)
      && (c.body as { forward_to_active_execution?: boolean }).forward_to_active_execution !== false)
    expect(appends()).toHaveLength(0)

    // Decided while idle, but a mention starts a run before the handoff: the
    // decision is dropped under the lock instead of steering or starting late.
    mock.finish('exec-1', 'done')
    await waitFor(async () => (await thread(state))?.activeExecution === false)
    // M3 is newer than the finished run but older than the mention M4.
    const sentAt = Date.now()
    await app.request('/api/chat/events', roomMessage('M3', 'one more', { eventTime: new Date(sentAt).toISOString() }))
    await waitFor(() => Boolean(releaseDecision))
    await app.request('/api/chat/events', roomMessage('M4', 'actually do this', { mention: true, eventTime: new Date(sentAt + 1000).toISOString() }))
    await waitFor(() => mock.streams.has('exec-2'))
    releaseDecision!()
    await waitFor(() => renderMetrics().includes('googlechatbot_proactive_decisions_total{outcome="skip_active_execution"} 2'))
    expect(mock.executions.map(e => e.idempotencyKey)).toEqual(['spaces/ROOM/messages/M1', 'spaces/ROOM/messages/M4'])
    expect(appends()).toHaveLength(0)

    // Collected before a later turn and only processed afterwards: context,
    // never its own execution, even once the thread is idle again.
    mock.finish('exec-2', 'done')
    await waitFor(async () => (await thread(state))?.activeExecution === false)
    await app.request('/api/chat/events', roomMessage('M5', 'late one', { eventTime: new Date(sentAt + 500).toISOString() }))
    await waitFor(() => renderMetrics().includes('googlechatbot_proactive_decisions_total{outcome="skip_active_execution"} 3'))
    expect(mock.executions).toHaveLength(2)
    expect(inputs.map(input => input.message.text)).toEqual(['one more'])
  }, 20_000)

  test('a stop ends participation until the next mention', async () => {
    const { runtime, inputs } = proactivity(() => ({ respond: true, probability: 0.99 }))
    const { app, state } = bot(runtime)
    await app.request('/api/chat/events', roomMessage('M1', 'hello bot', { mention: true }))
    await waitFor(() => mock.streams.has('exec-1'))
    await app.request('/api/chat/events', roomMessage('S1', 'stop', { mention: true }))
    await waitFor(() => mock.interrupts.length === 1)
    await waitFor(async () => (await thread(state))?.activeExecution === false)
    expect((await thread(state))?.proactiveEligible).toBe(false)

    await app.request('/api/chat/events', roomMessage('M2', 'are you still there?'))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(inputs).toHaveLength(0)
    expect(renderMetrics()).toContain('googlechatbot_proactive_decisions_total{outcome="skip_not_eligible"} 1')

    // An unmentioned "stop" in an eligible thread is honoured without a classifier call.
    await app.request('/api/chat/events', roomMessage('M3', 'back again', { mention: true }))
    await waitFor(() => mock.streams.has('exec-2'))
    expect((await thread(state))?.proactiveEligible).toBe(true)
    await app.request('/api/chat/events', roomMessage('S2', 'please stop'))
    await waitFor(() => mock.interrupts.length === 2)
    expect(inputs).toHaveLength(0)
    expect((await thread(state))?.proactiveEligible).toBe(false)
  }, 20_000)

  test('a stop older than the mention that opted the thread in does not end participation', async () => {
    const { runtime, inputs } = proactivity(() => ({ respond: true, probability: 0.9 }))
    const { app, state } = bot(runtime)
    const t0 = Date.now()
    await app.request('/api/chat/events', roomMessage('M1', 'start here', { mention: true, eventTime: new Date(t0).toISOString() }))
    await waitFor(() => mock.streams.has('exec-1'))
    mock.finish('exec-1', 'started')
    await waitFor(async () => (await thread(state))?.activeExecution === false)
    expect((await thread(state))?.proactiveEligibleAt).toBe(t0)

    // Delivered late: sent before the mention, so it cannot revoke it.
    await app.request('/api/chat/events', roomMessage('S0', 'stop', { mention: true, eventTime: new Date(t0 - 10_000).toISOString() }))
    await waitFor(() => [...mock.messages.values()].some(m => String(m.text).includes('no active run')))
    const after = await thread(state)
    expect(after?.proactiveEligible).toBe(true)
    expect(after?.stopRequestedAt).toBe(t0 - 10_000)

    await app.request('/api/chat/events', roomMessage('M2', 'and then?', { eventTime: new Date(t0 + 1000).toISOString() }))
    await waitFor(() => mock.executions.length === 2)
    expect(inputs).toHaveLength(1)
    mock.finish('exec-2', 'then this')

    // A stop sent after the mention does end it.
    await app.request('/api/chat/events', roomMessage('S1', 'stop', { mention: true, eventTime: new Date(t0 + 2000).toISOString() }))
    await waitFor(async () => (await thread(state))?.proactiveEligible === false)
  }, 20_000)

  for (const kind of ['text', 'card'] as const) {
    test(`a ${kind} stop during a pending start leaves participation off until a fresh mention`, async () => {
      const { runtime, inputs } = proactivity(() => ({ respond: true, probability: 0.9 }))
      const { app, state } = bot(runtime)
      let releaseCreate!: () => void
      let createWaiting = false
      mock.beforeSessionCreate = async () => {
        if (createWaiting) return
        createWaiting = true
        await new Promise<void>(resolve => { releaseCreate = resolve })
      }
      const t0 = Date.now()
      await app.request('/api/chat/events', roomMessage('M1', 'start work', { mention: true, eventTime: new Date(t0).toISOString() }))
      await waitFor(() => createWaiting)
      const ack = [...mock.messages.keys()].find(name => name.includes('client-centaur-ack-'))!
      if (kind === 'text') {
        await app.request('/api/chat/events', roomMessage('S1', 'stop', { mention: true, eventTime: new Date(t0 + 1000).toISOString() }))
        await waitFor(async () => Boolean((await thread(state))?.stopRequestedAt))
      } else {
        await app.request('/api/chat/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'CARD_CLICKED', eventTime: new Date(t0 + 1000).toISOString(),
            space: { name: 'spaces/ROOM', spaceType: 'SPACE' },
            message: { name: ack, thread: { name: 'spaces/ROOM/threads/T1' } },
            user: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' },
            common: { invokedFunction: 'centaur_stop' }
          })
        })
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      releaseCreate()
      await waitFor(() => mock.messages.get(ack)?.text === '⏹️ Stopped before the run started.')
      await waitFor(async () => (await thread(state))?.proactiveEligible === false)
      expect(mock.executions).toHaveLength(0)

      // Unmentioned follow-up: not even classified.
      await app.request('/api/chat/events', roomMessage('M2', 'still there?', { eventTime: new Date(t0 + 2000).toISOString() }))
      await waitFor(() => renderMetrics().includes('googlechatbot_proactive_decisions_total{outcome="skip_not_eligible"} 1'))
      expect(inputs).toHaveLength(0)
      expect(mock.executions).toHaveLength(0)

      // A genuinely newer mention re-enables and runs.
      mock.beforeSessionCreate = undefined
      await app.request('/api/chat/events', roomMessage('M3', 'back again', { mention: true, eventTime: new Date(t0 + 3000).toISOString() }))
      await waitFor(() => mock.executions.length === 1)
      expect((await thread(state))?.proactiveEligible).toBe(true)
      mock.finish('exec-1', 'back')
    }, 20_000)
  }

  for (const kind of ['text', 'card'] as const) {
    test(`a ${kind} stop during a pending start also stops a mention sent before the stop but delivered after it`, async () => {
      const { runtime, inputs } = proactivity(() => ({ respond: true, probability: 0.9 }))
      const { app, state } = bot(runtime)
      let releaseCreate!: () => void
      let createWaiting = false
      mock.beforeSessionCreate = async () => {
        if (createWaiting) return
        createWaiting = true
        await new Promise<void>(resolve => { releaseCreate = resolve })
      }
      const t0 = Date.now()
      await app.request('/api/chat/events', roomMessage('M1', 'start work', { mention: true, eventTime: new Date(t0).toISOString() }))
      await waitFor(() => createWaiting)
      const ack = [...mock.messages.keys()].find(name => name.includes('client-centaur-ack-'))!
      // The stop is requested at t0 + 2000 on Google's clock.
      if (kind === 'text') {
        await app.request('/api/chat/events', roomMessage('S1', 'stop', { mention: true, eventTime: new Date(t0 + 2000).toISOString() }))
        await waitFor(async () => (await thread(state))?.stopRequestedAt === t0 + 2000)
      } else {
        const action = (mock.messages.get(ack)!.cardsV2 as Array<{ card: { sections: Array<{ widgets: Array<{ buttonList: { buttons: Array<{ onClick: { action: { function: string; parameters?: Array<{ key: string; value: string }> } } }> } }> }> } }>)[0]!.card.sections[0]!.widgets[0]!.buttonList.buttons[0]!.onClick.action
        await app.request('/api/chat/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'CARD_CLICKED', eventTime: new Date(t0 + 2000).toISOString(),
            space: { name: 'spaces/ROOM', spaceType: 'SPACE' },
            message: { name: ack, thread: { name: 'spaces/ROOM/threads/T1' }, sender: { name: BOT, type: 'BOT' } },
            user: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' },
            common: {
              invokedFunction: action.function,
              ...(action.parameters ? { parameters: Object.fromEntries(action.parameters.map(p => [p.key, p.value])) } : {})
            }
          })
        })
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      releaseCreate()
      await waitFor(() => mock.messages.get(ack)?.text === '⏹️ Stopped before the run started.')
      await waitFor(async () => (await thread(state))?.proactiveEligible === false)
      expect((await thread(state))?.stopRequestedAt).toBe(t0 + 2000)

      // Sent before the stop (t0 + 1000), delivered after it: must not run or opt in.
      mock.beforeSessionCreate = undefined
      await app.request('/api/chat/events', roomMessage('LATE', 'an earlier queued mention', { mention: true, eventTime: new Date(t0 + 1000).toISOString() }))
      await waitFor(() => [...mock.messages.values()].filter(m => m.text === '⏹️ Stopped before the run started.').length === 2)
      expect(mock.executions).toHaveLength(0)
      expect((await thread(state))?.proactiveEligible).toBe(false)
      expect((await thread(state))?.stopRequestedAt).toBe(t0 + 2000)
      expect(inputs).toHaveLength(0)

      // Sent after the stop: runs and re-enables participation.
      await app.request('/api/chat/events', roomMessage('M3', 'fresh mention', { mention: true, eventTime: new Date(t0 + 3000).toISOString() }))
      await waitFor(() => mock.executions.length === 1)
      expect(mock.executions[0]!.idempotencyKey).toBe('spaces/ROOM/messages/M3')
      expect((await thread(state))?.proactiveEligible).toBe(true)
      mock.finish('exec-1', 'back')
    }, 20_000)
  }

  for (const timing of ['older', 'same-time'] as const) {
  test(`a stale card whose cancelled work is recovered later leaves the newer run and its opt-in untouched (${timing})`, async () => {
    // A real recovery sweep (100 ms interval) finalizes an acknowledged
    // obligation that never executed, after its Stop card was clicked while
    // a newer mentioned run streams. The successor keeps streaming, keeps
    // its participation, and the thread gets no cutoff. With equal event
    // times (legal, and what millisecond truncation produces) ownership of
    // the active execution, not the clock, decides.
    const { runtime } = proactivity(() => ({ respond: true, probability: 0.9 }))
    const { app, state } = bot(runtime, { GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS: '100' })
    const now = Date.now()
    const oldSentAt = timing === 'older' ? now - 10_000 : now
    await app.request('/api/chat/events', roomMessage('NEW', 'do the new thing', { mention: true, eventTime: new Date(now).toISOString() }))
    await waitFor(() => mock.streams.has('exec-1'))
    const before = await thread(state)
    expect(before?.proactiveEligible).toBe(true)

    const oldAck = 'spaces/ROOM/messages/client-centaur-ack-old'
    const old: GoogleChatWorkObligation = {
      workId: crypto.randomUUID(),
      acceptedAt: new Date(oldSentAt).toISOString(),
      dedupeKey: 'old-pending',
      identityVerified: false,
      lastEventId: 0,
      failures: 0,
      stage: 'thinking',
      eventType: 'MESSAGE',
      ackMessageName: oldAck,
      event: {
        thread_key: THREAD, message_id: 'spaces/ROOM/messages/OLD', space_name: 'spaces/ROOM', space_type: 'SPACE',
        user_id: 'users/U1', user_name: 'Alice', is_mention: true, parts: [{ type: 'text', text: 'do the old thing' }],
        chat: { event_time: new Date(oldSentAt).toISOString(), thread_name: 'spaces/ROOM/threads/T1', thread_reply: true }
      }
    }
    await state.set(workKey(old.workId), old)
    await persistStopControl(state, oldAck, { workId: old.workId, threadKey: THREAD, spaceName: 'spaces/ROOM' })
    mock.messages.set(oldAck, { name: oldAck, text: 'old acknowledgement' })
    await app.request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'CARD_CLICKED', eventTime: new Date().toISOString(),
        space: { name: 'spaces/ROOM', spaceType: 'SPACE' },
        message: { name: oldAck, thread: { name: 'spaces/ROOM/threads/T1' }, sender: { name: BOT, type: 'BOT' } },
        user: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' },
        common: { invokedFunction: 'centaur_stop' }
      })
    })
    await waitFor(() => renderMetrics().includes('googlechatbot_stop_commands_total{outcome="stale",source="card"} 1'))

    // Now the old obligation is accepted again and the sweep recovers it.
    await acceptWork(state, old)
    await waitFor(async () => (await state.get(workKey(old.workId))) === null, 15_000)
    expect(mock.messages.get(oldAck)?.text).toBe('⏹️ Stopped before the run started.')
    const after = await thread(state)
    expect(mock.streams.get('exec-1')?.closed).toBe(false)
    expect(mock.interrupts).toHaveLength(0)
    expect(after?.proactiveEligible).toBe(true)
    expect(after?.stopRequestedAt).toBeUndefined()
    expect(after?.activeExecutionId).toBe('exec-1')
    expect(mock.executions).toHaveLength(1)
    mock.finish('exec-1', 'new done')
  }, 30_000)
  }

  for (const kind of ['opted-out', 'feature-disabled', 'space-removed'] as const) {
    test(`a recovered positive decision does not execute when the thread is ${kind}`, async () => {
      // A durable work.proactive=true obligation (normalized, no execution)
      // is recovered by the real sweep under the CURRENT policy.
      const state = createMemoryState()
      await state.connect()
      const now = Date.now()
      await state.set(threadStateKey(THREAD), {
        proactiveEligible: kind !== 'opted-out', activeExecution: false, lastExecutedAt: now - 2000,
        ...(kind === 'opted-out' ? { stopRequestedAt: now - 1000 } : {})
      } satisfies GoogleChatThreadState)
      const cached: GoogleChatWorkObligation = {
        workId: crypto.randomUUID(), acceptedAt: new Date(now).toISOString(), dedupeKey: 'cached',
        identityVerified: false, lastEventId: 0, failures: 0, stage: 'accepted', eventType: 'MESSAGE', proactive: true,
        event: {
          thread_key: THREAD, message_id: 'spaces/ROOM/messages/CACHED', space_name: 'spaces/ROOM', space_type: 'SPACE',
          user_id: 'users/U1', user_name: 'Alice', is_mention: false, parts: [{ type: 'text', text: 'an unmentioned follow-up' }],
          chat: { event_time: new Date(now).toISOString(), thread_name: 'spaces/ROOM/threads/T1', thread_reply: true }
        }
      }
      await acceptWork(state, cached)
      await state.disconnect()
      const { runtime, inputs } = proactivity(() => ({ respond: true, probability: 0.99 }), kind === 'space-removed' ? ['spaces/OTHER'] : ['spaces/ROOM'])
      const config = loadConfig({ ...ENV, GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS: '100' })
      const bot = tracked(createGooglechatbot(config, { state, ...(kind === 'feature-disabled' ? {} : { proactivity: runtime }) }))
      await bot.stateConnected
      await waitFor(async () => (await state.get(workKey(cached.workId))) === null, 15_000)
      expect(mock.executions).toHaveLength(0)
      expect(mock.calls.filter(c => c.method === 'POST' && decodeURIComponent(c.url).endsWith(`/api/session/${THREAD}/messages`))).toHaveLength(0)
      expect(inputs).toHaveLength(0)
      expect([...mock.messages.values()].some(m => String(m.text).includes('thinking'))).toBe(false)
      expect(renderMetrics()).toContain('googlechatbot_proactive_decisions_total{outcome="skip_policy"} 1')
    }, 30_000)
  }

  test('a positive decision followed by a stop while session create is held never executes or steers', async () => {
    const { runtime, inputs } = proactivity(() => ({ respond: true, probability: 0.99 }))
    const { app, state } = bot(runtime)
    const t0 = Date.now()
    await app.request('/api/chat/events', roomMessage('M1', 'hello bot', { mention: true, eventTime: new Date(t0).toISOString() }))
    await waitFor(() => mock.streams.has('exec-1'))
    mock.finish('exec-1', 'hi')
    await waitFor(async () => (await thread(state))?.activeExecution === false)
    expect((await thread(state))?.proactiveEligible).toBe(true)

    let releaseCreate!: () => void
    let createWaiting = false
    mock.beforeSessionCreate = async () => {
      if (createWaiting) return
      createWaiting = true
      await new Promise<void>(resolve => { releaseCreate = resolve })
    }
    await app.request('/api/chat/events', roomMessage('M2', 'and the follow-up?', { eventTime: new Date(t0 + 1000).toISOString() }))
    await waitFor(() => createWaiting)
    expect(inputs).toHaveLength(1)
    // The stop lands while the proactive turn's session create is held.
    await app.request('/api/chat/events', roomMessage('S1', 'stop', { mention: true, eventTime: new Date(t0 + 2000).toISOString() }))
    await waitFor(async () => (await thread(state))?.proactiveEligible === false)
    releaseCreate()
    await waitFor(() => renderMetrics().includes('googlechatbot_proactive_decisions_total{outcome="skip_active_execution"} 1'))
    expect(mock.executions).toHaveLength(1)
    expect(mock.calls.filter(c => c.method === 'POST'
      && decodeURIComponent(c.url).endsWith(`/api/session/${THREAD}/messages`)
      && (c.body as { forward_to_active_execution?: boolean }).forward_to_active_execution !== false)).toHaveLength(0)
    // Still silent afterwards, until a fresh mention re-enables.
    mock.beforeSessionCreate = undefined
    await app.request('/api/chat/events', roomMessage('M3', 'anyone?', { eventTime: new Date(t0 + 3000).toISOString() }))
    await waitFor(() => renderMetrics().includes('googlechatbot_proactive_decisions_total{outcome="skip_not_eligible"} 1'))
    expect(mock.executions).toHaveLength(1)
    await app.request('/api/chat/events', roomMessage('M4', 'back', { mention: true, eventTime: new Date(t0 + 4000).toISOString() }))
    await waitFor(() => mock.executions.length === 2)
    expect((await thread(state))?.proactiveEligible).toBe(true)
    mock.finish('exec-2', 'back')
  }, 30_000)

  test('spaces outside the exact list and DMs are never classified', async () => {
    const { runtime, inputs } = proactivity(() => ({ respond: true }), ['spaces/OTHER'])
    const { app, state } = bot(runtime)
    await app.request('/api/chat/events', roomMessage('M1', 'hi', { mention: true }))
    await waitFor(() => mock.streams.has('exec-1'))
    expect((await thread(state))?.proactiveEligible).toBeUndefined()
    mock.finish('exec-1', 'hi')
    await waitFor(async () => (await thread(state))?.activeExecution === false)
    await app.request('/api/chat/events', roomMessage('M2', 'follow up?'))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(inputs).toHaveLength(0)
    expect(mock.executions).toHaveLength(1)
  }, 20_000)

  test('proactivity requires the exact space list and a classifier key at startup', () => {
    expect(() => loadConfig({ ...ENV, GOOGLECHATBOT_PROACTIVITY_ENABLED: 'true', OPENAI_API_KEY: 'k' }))
      .toThrow('GOOGLECHATBOT_PROACTIVITY_SPACES')
    expect(() => loadConfig({ ...ENV, GOOGLECHATBOT_PROACTIVITY_ENABLED: 'true', GOOGLECHATBOT_PROACTIVITY_SPACES: 'AAAA' }))
      .toThrow('OPENAI_API_KEY')
    expect(loadConfig({
      ...ENV, GOOGLECHATBOT_PROACTIVITY_ENABLED: 'true', GOOGLECHATBOT_PROACTIVITY_SPACES: 'AAAA, spaces/BBBB',
      GOOGLECHATBOT_PROACTIVITY_OPENAI_API_KEY: 'k'
    }).GOOGLECHATBOT_PROACTIVITY_SPACES).toEqual(['spaces/AAAA', 'spaces/BBBB'])
    expect(loadConfig(ENV).GOOGLECHATBOT_PROACTIVITY_ENABLED).toBe(false)
  })
})
