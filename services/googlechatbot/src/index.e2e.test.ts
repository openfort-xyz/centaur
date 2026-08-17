import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createGooglechatbot } from './index'
import { loadConfig } from './config'
import { ChatApiError } from './chat/client'
import { renderMetrics, resetMetrics } from './metrics'
import { createMemoryState } from '@chat-adapter/state-memory'
import { WORK_INDEX_KEY, persistWork, workKey, type GoogleChatWorkObligation } from './state'

const CHATBOT_ENV = {
  CHAT_EVENTS_PATH: '/api/chat/events',
  GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'false'
}
const NOW_ISO = new Date().toISOString()

type MockCall = { url: string; method: string; body: unknown }

/** Dispatches the real webhook route's outbound fetch traffic (Chat API +
 * session-api) so a full inbound event can be driven through the actual Hono
 * app end-to-end, exactly as production traffic would. */
function installMockFetch(): { calls: MockCall[]; restore: () => void } {
  const realFetch = globalThis.fetch
  const calls: MockCall[] = []

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof URL ? input.toString() : input)
    const method = init?.method ?? 'GET'
    const rawBody = init?.body
    let body: unknown = undefined
    if (typeof rawBody === 'string') {
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = rawBody
      }
    }
    calls.push({ url, method, body })

    if (new URL(url).hostname === 'chat.googleapis.com') {
      if (url.endsWith('/members/app')) {
        return new Response(JSON.stringify({ member: { name: 'users/123456789', type: 'BOT' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({ name: 'spaces/AAAA/messages/ACK1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (url.endsWith('/execute')) {
      return new Response(
        JSON.stringify({
          ok: true,
          execution_id: 'exec-1',
          thread_key: 'chat:spaces:AAAA:spaces:AAAA:threads:BBBB',
          status: 'queued'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (url.includes('/events?')) {
      // No body → openSessionEventStream treats this as an already-closed stream.
      return new Response(null, { status: 200 })
    }
    if (url.includes('/api/workflows/events')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (method === 'POST' && /\/api\/session\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ status: 'idle' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    // Thread-history GETs (spaces.messages.list) and anything else default to
    // an empty-but-valid Chat API list response.
    return new Response(JSON.stringify({ messages: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof fetch

  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch
    }
  }
}

/** processChatEvent runs in the background (runInBackground) and is not
 * awaited by the webhook response, so poll briefly for the expected call
 * instead of asserting immediately after the request settles. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('googlechatbot webhook e2e', () => {
  let mock: ReturnType<typeof installMockFetch>

  beforeEach(() => {
    resetMetrics()
    mock = installMockFetch()
  })

  afterEach(() => {
    mock.restore()
  })

  const app = (env: Record<string, string> = {}) =>
    createGooglechatbot(loadConfig({ ...CHATBOT_ENV, ...env }), {
      state: createMemoryState()
    }).app

  test('ADDED_TO_SPACE posts the welcome message', async () => {
    const res = await app().request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'ADDED_TO_SPACE',
        eventTime: NOW_ISO,
        space: { name: 'spaces/AAAA', type: 'SPACE' }
      })
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})

    await waitFor(() => mock.calls.some(c => c.url.includes('spaces/AAAA/messages')))
    const welcome = mock.calls.find(c => c.url.includes('spaces/AAAA/messages'))
    expect((welcome?.body as { text?: string })?.text).toContain('Centaur at your service')
  })

  test('a mention drives a session: creates the session and posts the thinking ack', async () => {
    // A DM message is always treated as addressed to the bot (singleUserBotDm),
    // so this exercises the is_mention path without needing a real service
    // account configured for bot-name text matching.
    const res = await app().request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'MESSAGE',
        eventTime: NOW_ISO,
        space: { name: 'spaces/AAAA', type: 'DIRECT_MESSAGE', singleUserBotDm: true },
        message: {
          name: 'spaces/AAAA/messages/M1',
          text: 'deploy the thing',
          sender: { name: 'users/U1', displayName: 'Alice', email: 'alice@openfort.xyz' }
        },
        user: { name: 'users/U1', displayName: 'Alice', email: 'alice@openfort.xyz' }
      })
    })

    expect(res.status).toBe(200)

    await waitFor(() =>
      mock.calls.some(c => c.method === 'POST' && /\/api\/session\/[^/]+$/.test(c.url))
    )
    await waitFor(() => mock.calls.some(c => c.url.includes('spaces/AAAA/messages')))

    const createSessionCall = mock.calls.find(
      c => c.method === 'POST' && /\/api\/session\/[^/]+$/.test(c.url)
    )
    expect(createSessionCall).toBeTruthy()
    const ackCall = mock.calls.find(c =>
      c.method === 'POST'
      && new URL(c.url).hostname === 'chat.googleapis.com'
      && (c.body as { text?: string })?.text?.includes('thinking')
    )
    expect(new URL(ackCall!.url).searchParams.get('messageId'))
      .toMatch(/^client-centaur-ack-[a-f0-9]{32}$/)
  })

  test('recovers a crash after deterministic thinking creation without duplicating it', async () => {
    const state = createMemoryState()
    await state.connect()
    const work: GoogleChatWorkObligation = {
      acceptedAt: new Date().toISOString(),
      dedupeKey: 'message:ack-create-crash',
      event: {
        thread_key: 'thread-ack-create-crash',
        message_id: 'message-ack-create-crash',
        space_name: 'spaces/AAAA',
        space_type: 'DIRECT_MESSAGE',
        user_id: 'users/U1',
        user_name: 'Alice',
        is_mention: true,
        parts: [{ type: 'text', text: 'recover me' }],
        chat: {}
      },
      failures: 0,
      identityVerified: false,
      lastEventId: 0,
      stage: 'accepted',
      workId: crypto.randomUUID()
    }
    await persistWork(state, work)
    await state.disconnect()

    const realConnect = state.connect.bind(state)
    let release!: () => void
    state.connect = async () => {
      await new Promise<void>(resolve => { release = resolve })
      await realConnect()
    }
    const runtime = createGooglechatbot(loadConfig(CHATBOT_ENV), { state })
    const messageId = `client-centaur-ack-${work.workId.replace(/-/g, '')}`
    let ackCreates = 0
    let finalUpdateName = ''
    runtime.client.createMessage = async (_space, _body, opts) => {
      ackCreates += 1
      expect(opts?.messageId).toBe(messageId)
      throw new ChatApiError('POST', 'spaces/AAAA/messages', 409, 'ALREADY_EXISTS')
    }
    runtime.client.updateMessage = async name => {
      finalUpdateName = name
      return {}
    }
    release()
    await runtime.stateConnected
    await waitFor(async () => (await state.get(workKey(work.workId))) === null)

    expect(ackCreates).toBe(1)
    expect(finalUpdateName).toBe(`spaces/AAAA/messages/${messageId}`)
  })

  test('durably ACKs before hanging media work', async () => {
    const state = createMemoryState()
    const runtime = createGooglechatbot(loadConfig(CHATBOT_ENV), { state })
    runtime.client.downloadAttachment = () => new Promise<ArrayBuffer>(() => undefined)
    const started = performance.now()
    const response = await Promise.race([
      runtime.app.request('/api/chat/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'MESSAGE',
          eventTime: NOW_ISO,
          authorizationEventObject: { userIdToken: 'must-not-be-persisted' },
          space: { name: 'spaces/AAAA', spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
          message: {
            name: 'spaces/AAAA/messages/HANG',
            text: 'persist me',
            sender: { name: 'users/U1', type: 'HUMAN' },
            attachment: [{
              source: 'UPLOADED_CONTENT',
              attachmentDataRef: { resourceName: 'opaque-media-ref' }
            }]
          }
        })
      }),
      Bun.sleep(500).then(() => { throw new Error('webhook waited for upstream work') })
    ])
    expect(response.status).toBe(200)
    expect(performance.now() - started).toBeLessThan(500)
    const [id] = await state.getList<string>(WORK_INDEX_KEY)
    const work = id ? await state.get<GoogleChatWorkObligation>(workKey(id)) : null
    expect(work?.envelope?.message?.name).toContain('/HANG')
    expect(work?.envelope?.authorizationEventObject).toBeUndefined()
    expect(work?.event).toBeUndefined()
  })

  test('only an exact bot annotation or slash command starts a named-space run', async () => {
    const runtime = createGooglechatbot(loadConfig(CHATBOT_ENV), { state: createMemoryState() })
    let identityLookups = 0
    runtime.client.getBotUserName = async () => {
      identityLookups += 1
      throw new Error('members/app requires user authentication')
    }
    const bot = runtime.app
    const send = (message: Record<string, unknown>) =>
      bot.request('/api/chat/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'MESSAGE',
          eventTime: NOW_ISO,
          space: { name: 'spaces/AAAA', type: 'SPACE' },
          message,
          user: { name: 'users/U1', displayName: 'Alice' }
        })
      })
    const sessionCalls = () =>
      mock.calls.filter(c => c.method === 'POST' && /\/api\/session\/[^/]+$/.test(c.url)).length

    await send({
      name: 'spaces/AAAA/messages/plain',
      text: 'please ask @alice',
      sender: { name: 'users/U1', type: 'HUMAN' }
    })
    await send({
      name: 'spaces/AAAA/messages/other-bot',
      text: 'loop',
      sender: { name: 'users/other-bot', type: 'BOT' }
    })
    await send({
      name: 'spaces/AAAA/messages/self',
      text: 'echo',
      sender: { name: 'users/123456789', type: 'BOT' }
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(sessionCalls()).toBe(0)

    await send({
      name: 'spaces/AAAA/messages/exact',
      text: 'please help',
      sender: { name: 'users/U1', type: 'HUMAN' },
      annotations: [{
        type: 'USER_MENTION',
        userMention: { user: { name: 'users/123456789', type: 'BOT' }, type: 'MENTION' }
      }]
    })
    await waitFor(() => sessionCalls() === 1)

    await send({
      name: 'spaces/AAAA/messages/slash',
      text: '/centaur ship it',
      argumentText: 'ship it',
      sender: { name: 'users/U1', type: 'HUMAN' },
      annotations: [{ type: 'SLASH_COMMAND' }]
    })
    await waitFor(() => sessionCalls() === 2)
    expect(sessionCalls()).toBe(2)
    expect(identityLookups).toBe(0)
  })

  // Explicit development opt-out: the event still runs, but cannot source an
  // identity anyone's credentials could be attached to.
  test('an unverified event is processed but creates the session without identity keys', async () => {
    const res = await app({ GOOGLECHATBOT_ALLOWED_DOMAIN: '' }).request(
      '/api/chat/events',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'MESSAGE',
          eventTime: NOW_ISO,
          space: { name: 'spaces/AAAA', type: 'DIRECT_MESSAGE', singleUserBotDm: true },
          message: {
            name: 'spaces/AAAA/messages/M9',
            text: 'deploy the thing',
            sender: { name: 'users/U1', displayName: 'Alice' }
          },
          user: { name: 'users/U1', displayName: 'Alice' }
        })
      }
    )
    expect(res.status).toBe(200)

    await waitFor(() =>
      mock.calls.some(c => c.method === 'POST' && /\/api\/session\/[^/]+$/.test(c.url))
    )
    const create = mock.calls.find(
      c => c.method === 'POST' && /\/api\/session\/[^/]+$/.test(c.url)
    )
    const metadata = ((create?.body as { metadata?: Record<string, unknown> })?.metadata
      ?? {}) as Record<string, unknown>
    expect(metadata.user_id).toBe('users/U1')
    expect('user_email' in metadata).toBe(false)
    expect('single_user_bot_dm' in metadata).toBe(false)
    // api-rs's own gate inputs still ship, reporting the request honestly: the
    // room is observable, and the skipped check reads as false, not as absent.
    expect(metadata.googlechat_space_type).toBe('DIRECT_MESSAGE')
    expect(metadata.googlechat_request_verified).toBe(false)
    expect(renderMetrics()).toContain(
      'googlechatbot_session_identity_total{outcome="suppressed",reason="unverified"} 1'
    )
  })

  test('a legacy Chat event cannot satisfy an email-domain allowlist', async () => {
    const res = await app({ GOOGLECHATBOT_ALLOWED_DOMAIN: 'openfort.xyz' }).request(
      '/api/chat/events',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'MESSAGE',
          eventTime: NOW_ISO,
          space: { name: 'spaces/AAAA', type: 'DIRECT_MESSAGE', singleUserBotDm: true },
          message: {
            name: 'spaces/AAAA/messages/M10',
            text: 'deploy the thing',
            sender: { name: 'users/U2', displayName: 'Mallory' }
          }
        })
      }
    )
    expect(res.status).toBe(403)
    expect(mock.calls.some(c => /\/api\/session\//.test(c.url))).toBe(false)
  })

  test('CARD_CLICKED dispatches a workflow event with the invoked function and space', async () => {
    const res = await app().request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'CARD_CLICKED',
        eventTime: NOW_ISO,
        space: { name: 'spaces/AAAA', type: 'SPACE' },
        message: {
          name: 'spaces/AAAA/messages/M2',
          thread: { name: 'spaces/AAAA/threads/T1' }
        },
        thread: { name: 'spaces/AAAA/threads/T1' },
        user: { name: 'users/U1', displayName: 'Alice' },
        common: { invokedFunction: 'approve', parameters: { request_id: 'r1' } }
      })
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})

    await waitFor(() => mock.calls.some(c => c.url.includes('/api/workflows/events')))
    const dispatch = mock.calls.find(c => c.url.includes('/api/workflows/events'))
    expect(dispatch?.body).toEqual({
      event_name: 'google_chat.card_click.approve',
      payload: {
        event_type: 'card_click',
        invoked_function: 'approve',
        message_name: 'spaces/AAAA/messages/M2',
        parameters: { request_id: 'r1' },
        space_name: 'spaces/AAAA',
        thread_name: 'spaces/AAAA/threads/T1',
        user_id: 'users/U1',
        user_name: 'Alice'
      }
    })
  })

  test('persists an action before 200 and recovers it after background dispatch failure', async () => {
    const state = createMemoryState()
    const successFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/api/workflows/events')) {
        return new Response('{"error":"down"}', { status: 503 })
      }
      return successFetch(input as RequestInfo, init)
    }) as typeof fetch
    const first = createGooglechatbot(loadConfig(CHATBOT_ENV), { state })
    const response = await first.app.request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'CARD_CLICKED',
        eventTime: NOW_ISO,
        space: { name: 'spaces/AAAA', type: 'SPACE' },
        message: { name: 'spaces/AAAA/messages/durable-action' },
        user: { name: 'users/U1' },
        common: { invokedFunction: 'approve' }
      })
    })
    expect(response.status).toBe(200)

    let obligation!: GoogleChatWorkObligation
    await waitFor(async () => {
      const [id] = await state.getList<string>(WORK_INDEX_KEY)
      const value = id ? await state.get<GoogleChatWorkObligation>(workKey(id)) : null
      if (!value?.action || value.failures < 1) return false
      obligation = value
      return true
    })
    // The durable obligation, not a platform retry, owns recovery after ACK.
    expect(await state.get<string>(`googlechatbot:dedupe:${obligation.dedupeKey}`)).toBe('completed')

    globalThis.fetch = successFetch
    createGooglechatbot(loadConfig(CHATBOT_ENV), { state })
    await waitFor(async () => (await state.get(workKey(obligation.workId))) === null)
    expect(await state.get<string>(`googlechatbot:dedupe:${obligation.dedupeKey}`)).toBe('completed')
  })

  test('recovery updates the thinking message, or creates one stable replacement', async () => {
    for (const updateWorks of [true, false]) {
      const state = createMemoryState()
      await state.connect()
      const work: GoogleChatWorkObligation = {
        acceptedAt: new Date().toISOString(),
        ackMessageName: 'spaces/AAAA/messages/ACK1',
        canonicalFinal: { answer: 'durable final answer' },
        dedupeKey: `message:recovery-${updateWorks}`,
        event: {
          thread_key: `thread-recovery-${updateWorks}`,
          message_id: `message-recovery-${updateWorks}`,
          space_name: 'spaces/AAAA',
          space_type: 'SPACE',
          user_id: 'users/U1',
          user_name: 'Alice',
          is_mention: true,
          parts: [{ type: 'text', text: 'run' }],
          chat: { thread_name: 'spaces/AAAA/threads/T1' }
        },
        executionId: 'exec-recovery',
        failures: 0,
        identityVerified: true,
        lastEventId: 9,
        stage: 'rendering',
        workId: crypto.randomUUID()
      }
      await persistWork(state, work)
      await state.disconnect()

      const realConnect = state.connect.bind(state)
      let release!: () => void
      state.connect = async () => {
        await new Promise<void>(resolve => {
          release = resolve
        })
        await realConnect()
      }
      const runtime = createGooglechatbot(loadConfig(CHATBOT_ENV), { state })
      let updates = 0
      const creates: Array<{ messageId?: string }> = []
      runtime.client.updateMessage = async () => {
        updates += 1
        if (!updateWorks) {
          throw new ChatApiError('PATCH', 'spaces/AAAA/messages/ACK1', 404, 'NOT_FOUND')
        }
        return {}
      }
      runtime.client.createMessage = async (_space, _body, opts) => {
        creates.push(opts ?? {})
        return { name: `spaces/AAAA/messages/${opts?.messageId}` }
      }
      release()
      await runtime.stateConnected
      await waitFor(async () => (await state.get(workKey(work.workId))) === null)

      expect(updates).toBe(1)
      expect(creates).toHaveLength(updateWorks ? 0 : 1)
      if (!updateWorks) {
        expect(creates[0]?.messageId).toBe(`client-centaur-${work.workId.replace(/-/g, '')}`)
      }
    }
  })

  test('recovers crash points before ack, after ack, during SSE, and after final PATCH', async () => {
    for (const stage of ['accepted', 'thinking', 'rendering', 'final'] as const) {
      const state = createMemoryState()
      await state.connect()
      const work: GoogleChatWorkObligation = {
        acceptedAt: new Date().toISOString(),
        ...(stage === 'accepted' ? {} : { ackMessageName: `spaces/AAAA/messages/${stage}` }),
        ...(stage === 'rendering' ? { executionId: 'exec-crash' } : {}),
        dedupeKey: `message:crash-${stage}`,
        event: {
          thread_key: `thread-crash-${stage}`,
          message_id: `message-crash-${stage}`,
          space_name: 'spaces/AAAA',
          space_type: 'DIRECT_MESSAGE',
          user_id: 'users/U1',
          user_name: 'Alice',
          is_mention: true,
          parts: [{ type: 'text', text: 'recover me' }],
          chat: {}
        },
        failures: 0,
        identityVerified: false,
        lastEventId: 0,
        stage,
        workId: crypto.randomUUID()
      }
      await persistWork(state, work)
      await state.disconnect()
      const runtime = createGooglechatbot(loadConfig(CHATBOT_ENV), { state })
      let deliveries = 0
      runtime.client.createMessage = async () => {
        deliveries += 1
        return { name: `spaces/AAAA/messages/recovered-${stage}` }
      }
      runtime.client.updateMessage = async () => {
        deliveries += 1
        return {}
      }
      await runtime.stateConnected
      await waitFor(async () => (await state.get(workKey(work.workId))) === null)
      expect(deliveries).toBe(stage === 'accepted' ? 2 : stage === 'final' ? 0 : 1)
    }
  })

  test('two recovery instances lease one action and clean stale/failure-budget work', async () => {
    const state = createMemoryState()
    await state.connect()
    const actionable: GoogleChatWorkObligation = {
      acceptedAt: new Date().toISOString(),
      action: {
        event_name: 'google_chat.card_click.approve',
        payload: {
          event_type: 'card_click', invoked_function: 'approve', space_name: 'spaces/AAAA'
        }
      },
      dedupeKey: 'action:leased',
      event: {
        thread_key: 'thread-action', message_id: 'action-message', space_name: 'spaces/AAAA',
        space_type: 'SPACE', user_id: 'users/U1', user_name: 'Alice', is_mention: true,
        parts: [], chat: {}
      },
      failures: 0,
      identityVerified: true,
      lastEventId: 0,
      stage: 'accepted',
      workId: crypto.randomUUID()
    }
    const stale = { ...actionable, action: undefined, acceptedAt: '2000-01-01T00:00:00Z',
      dedupeKey: 'stale', workId: crypto.randomUUID() }
    const exhausted = { ...actionable, action: undefined, failures: 5,
      dedupeKey: 'exhausted', workId: crypto.randomUUID() }
    await persistWork(state, actionable)
    await persistWork(state, stale)
    await persistWork(state, exhausted)
    await state.disconnect()

    let dispatches = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/api/workflows/events')) {
        dispatches += 1
        await new Promise(resolve => setTimeout(resolve, 20))
        return new Response('{}', { status: 200 })
      }
      return originalFetch(input as RequestInfo, init)
    }) as typeof fetch
    const first = createGooglechatbot(loadConfig(CHATBOT_ENV), { state })
    const second = createGooglechatbot(loadConfig(CHATBOT_ENV), { state })
    await Promise.all([first.stateConnected, second.stateConnected])
    await waitFor(async () => (await state.get(workKey(actionable.workId))) === null)
    await waitFor(async () =>
      (await state.get(workKey(stale.workId))) === null
      && (await state.get(workKey(exhausted.workId))) === null
    )
    expect(dispatches).toBe(1)
    globalThis.fetch = originalFetch
  })

  test('dedupes exact action redelivery but dispatches distinct user/function/parameters', async () => {
    const envelope = {
      type: 'CARD_CLICKED',
      eventTime: NOW_ISO,
      space: { name: 'spaces/AAAA', type: 'SPACE' },
      message: { name: 'spaces/AAAA/messages/M3' },
      user: { name: 'users/U1' },
      common: { invokedFunction: 'reject' }
    }
    const bot = app()
    const post = () =>
      bot.request('/api/chat/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope)
      })

    const first = await post()
    const second = await post()
    await bot.request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...envelope, user: { name: 'users/U2' } })
    })
    await bot.request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...envelope, common: { invokedFunction: 'approve' } })
    })
    await bot.request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...envelope,
        common: { invokedFunction: 'reject', parameters: { reason: 'changed' } }
      })
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    await waitFor(() => mock.calls.filter(c => c.url.includes('/api/workflows/events')).length === 4)
    // Give any (incorrect) exact-redelivery dispatch a moment to land before asserting.
    await new Promise(resolve => setTimeout(resolve, 30))
    const dispatches = mock.calls.filter(c => c.url.includes('/api/workflows/events'))
    expect(dispatches).toHaveLength(4)
  })

  test('Add-ons commands/forms dispatch typed events and malformed actions do not dispatch', async () => {
    const bot = app()
    const post = (body: unknown) => bot.request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

    await post({
      chat: {
        eventTime: NOW_ISO,
        user: { name: 'users/U1' },
        appCommandPayload: {
          space: { name: 'spaces/AAAA', type: 'SPACE' },
          message: { name: 'spaces/AAAA/messages/M4' },
          appCommandMetadata: { appCommandId: '42', appCommandType: 'QUICK_COMMAND' }
        }
      }
    })
    await post({
      commonEventObject: {
        parameters: { actionName: 'save' },
        formInputs: { title: { stringInputs: { value: ['hello'] } } }
      },
      chat: {
        eventTime: NOW_ISO,
        user: { name: 'users/U1' },
        buttonClickedPayload: {
          space: { name: 'spaces/AAAA', type: 'SPACE' },
          message: { name: 'spaces/AAAA/messages/M4' },
          dialogEventType: 'SUBMIT_DIALOG'
        }
      }
    })
    await post({
      chat: {
        eventTime: NOW_ISO,
        user: { name: 'users/U1' },
        buttonClickedPayload: {
          space: { name: 'spaces/AAAA', type: 'SPACE' },
          message: { name: 'spaces/AAAA/messages/M5' }
        }
      }
    })

    await waitFor(() => mock.calls.filter(c => c.url.includes('/api/workflows/events')).length === 2)
    await new Promise(resolve => setTimeout(resolve, 30))
    const dispatches = mock.calls
      .filter(c => c.url.includes('/api/workflows/events'))
      .map(c => c.body as { event_name?: string; payload?: { event_type?: string } })
    expect(dispatches.map(d => d.event_name)).toEqual([
      'google_chat.app_command.42',
      'google_chat.submit_form.save'
    ])
    expect(dispatches.map(d => d.payload?.event_type)).toEqual(['app_command', 'submit_form'])
  })
})

describe('googlechatbot harness resolution precedence (message-overrides-strategy + space-defaults)', () => {
  let mock: ReturnType<typeof installMockFetch>

  beforeEach(() => {
    resetMetrics()
    mock = installMockFetch()
  })

  afterEach(() => {
    mock.restore()
  })

  const dmEnvelope = (text: string) => ({
    type: 'MESSAGE',
    eventTime: NOW_ISO,
    space: { name: 'spaces/AAAA', type: 'DIRECT_MESSAGE', singleUserBotDm: true },
    message: {
      name: 'spaces/AAAA/messages/M1',
      text,
      sender: { name: 'users/U1', displayName: 'Alice', email: 'alice@openfort.xyz' }
    },
    user: { name: 'users/U1', displayName: 'Alice', email: 'alice@openfort.xyz' }
  })

  const post = async (
    env: Record<string, string>,
    text: string
  ): Promise<{ harness_type?: string }> => {
    const app = createGooglechatbot(loadConfig({ ...CHATBOT_ENV, ...env }), {
      state: createMemoryState()
    }).app
    await app.request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dmEnvelope(text))
    })
    await waitFor(() =>
      mock.calls.some(c => c.method === 'POST' && /\/api\/session\/[^/]+$/.test(c.url))
    )
    const createSessionCall = mock.calls.find(
      c => c.method === 'POST' && /\/api\/session\/[^/]+$/.test(c.url)
    )
    return (createSessionCall?.body ?? {}) as { harness_type?: string }
  }

  test('with neither an inline override nor a space default, the deployment default wins', async () => {
    const body = await post({}, 'deploy the thing')
    expect(body.harness_type).toBe('codex')
  })

  test('a space default is applied when no inline override is present', async () => {
    const body = await post(
      { GOOGLECHATBOT_SPACE_DEFAULTS: JSON.stringify({ AAAA: { harness: 'claude' } }) },
      'deploy the thing'
    )
    expect(body.harness_type).toBe('claudecode')
  })

  test('an inline override takes precedence over the space default', async () => {
    const body = await post(
      { GOOGLECHATBOT_SPACE_DEFAULTS: JSON.stringify({ AAAA: { harness: 'claude' } }) },
      '--codex deploy the thing'
    )
    expect(body.harness_type).toBe('codex')
  })
})
