import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createGooglechatbot } from './index'
import { loadConfig } from './config'
import { resetMetrics } from './metrics'

const CHATBOT_ENV = { CHAT_EVENTS_PATH: '/api/chat/events' }
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

    if (url.includes('chat.googleapis.com')) {
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
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
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
    createGooglechatbot(loadConfig({ ...CHATBOT_ENV, ...env })).app

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
        user: { name: 'users/U1', displayName: 'Alice', email: 'alice@openfort.xyz' },
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
        invoked_function: 'approve',
        message_name: 'spaces/AAAA/messages/M2',
        parameters: { request_id: 'r1' },
        space_name: 'spaces/AAAA',
        thread_name: 'spaces/AAAA/threads/T1',
        user_email: 'alice@openfort.xyz',
        user_id: 'users/U1',
        user_name: 'Alice'
      }
    })
  })

  test('duplicate delivery of the same event is deduped (only dispatched once)', async () => {
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

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    await waitFor(() => mock.calls.some(c => c.url.includes('/api/workflows/events')))
    // Give any (incorrect) second dispatch a moment to land before asserting.
    await new Promise(resolve => setTimeout(resolve, 30))
    const dispatches = mock.calls.filter(c => c.url.includes('/api/workflows/events'))
    expect(dispatches).toHaveLength(1)
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
    const app = createGooglechatbot(loadConfig({ ...CHATBOT_ENV, ...env })).app
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
