import { test, expect, describe } from 'bun:test'
import { googleChatCardClickPayload, parseChatBody, createGooglechatbot } from './index'
import { loadConfig } from './config'

describe('outbound /api/chat/messages', () => {
  const appWith = (env: Record<string, string>) =>
    createGooglechatbot(loadConfig({ ...env })).app
  const post = (app: ReturnType<typeof appWith>, headers: Record<string, string>, body: unknown) =>
    app.request('/api/chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })

  test('fails closed (503) when CHATBOT_API_KEY is not configured', async () => {
    const res = await post(appWith({}), {}, { space_name: 'spaces/A', text: 'hi' })
    expect(res.status).toBe(503)
  })

  test('rejects a wrong bearer token (401)', async () => {
    const app = appWith({ CHATBOT_API_KEY: 'secret' })
    const res = await post(app, { Authorization: 'Bearer wrong' }, { space_name: 'spaces/A', text: 'hi' })
    expect(res.status).toBe(401)
  })

  test('requires space_name and text (400) when authed', async () => {
    const app = appWith({ CHATBOT_API_KEY: 'secret' })
    const res = await post(app, { Authorization: 'Bearer secret' }, { space_name: 'spaces/A' })
    expect(res.status).toBe(400)
  })
})

describe('outbound /api/chat/attachments', () => {
  const appWith = (env: Record<string, string>) =>
    createGooglechatbot(loadConfig({ ...env })).app
  const post = (app: ReturnType<typeof appWith>, headers: Record<string, string>, body: unknown) =>
    app.request('/api/chat/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })

  test('fails closed (503) when CHATBOT_API_KEY is not configured', async () => {
    const res = await post(appWith({}), {}, { space_name: 'spaces/A' })
    expect(res.status).toBe(503)
  })

  test('reports uploads unconfigured (503) without GOOGLECHATBOT_UPLOAD_USER', async () => {
    const app = appWith({ CHATBOT_API_KEY: 'secret' })
    const res = await post(
      app,
      { Authorization: 'Bearer secret' },
      { space_name: 'spaces/A', filename: 'a.png', content_base64: 'aGk=' }
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('GOOGLECHATBOT_UPLOAD_USER')
  })

  test('requires space_name, filename and content_base64 (400) when configured', async () => {
    const app = appWith({
      CHATBOT_API_KEY: 'secret',
      GOOGLECHATBOT_UPLOAD_USER: 'files@openfort.xyz',
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'sa@example.iam.gserviceaccount.com',
        private_key: 'key'
      })
    })
    const res = await post(app, { Authorization: 'Bearer secret' }, { space_name: 'spaces/A' })
    expect(res.status).toBe(400)
  })

  test('rejects malformed base64 (400) instead of silently truncating', async () => {
    const app = appWith({
      CHATBOT_API_KEY: 'secret',
      GOOGLECHATBOT_UPLOAD_USER: 'files@openfort.xyz',
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'sa@example.iam.gserviceaccount.com',
        private_key: 'key'
      })
    })
    const res = await post(
      app,
      { Authorization: 'Bearer secret' },
      { space_name: 'spaces/A', filename: 'a.txt', content_base64: 'SGVsbG8h%%%%V29ybGQh' }
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('not valid base64')
  })
})

describe('parseChatBody', () => {
  test('unwraps a v2 messagePayload envelope', () => {
    const body = JSON.stringify({
      chat: {
        eventTime: '2026-01-01T00:00:00Z',
        messagePayload: {
          space: { name: 'spaces/AAAA', type: 'SPACE' },
          message: { name: 'spaces/AAAA/messages/M1', text: 'hi' }
        }
      }
    })
    const env = parseChatBody(body)
    expect(env?.type).toBe('MESSAGE')
    expect(env?.space?.name).toBe('spaces/AAAA')
  })
})

describe('googleChatCardClickPayload', () => {
  test('extracts invoked function, parameters, thread and user context', () => {
    const payload = googleChatCardClickPayload({
      type: 'CARD_CLICKED',
      space: { name: 'spaces/AAAA', type: 'SPACE' },
      message: { name: 'spaces/AAAA/messages/M1', thread: { name: 'spaces/AAAA/threads/T1' } },
      thread: { name: 'spaces/AAAA/threads/T1' },
      user: { name: 'users/U1', displayName: 'Alice', email: 'alice@openfort.xyz' },
      common: { invokedFunction: 'approve', parameters: { request_id: 'r1' } }
    })

    expect(payload).toEqual({
      invoked_function: 'approve',
      message_name: 'spaces/AAAA/messages/M1',
      parameters: { request_id: 'r1' },
      space_name: 'spaces/AAAA',
      thread_name: 'spaces/AAAA/threads/T1',
      user_email: 'alice@openfort.xyz',
      user_id: 'users/U1',
      user_name: 'Alice'
    })
  })

  test('falls back to the top-level thread when the message omits one', () => {
    const payload = googleChatCardClickPayload({
      type: 'CARD_CLICKED',
      space: { name: 'spaces/AAAA', type: 'SPACE' },
      thread: { name: 'spaces/AAAA/threads/T1' },
      common: { invokedFunction: 'reject' }
    })

    expect(payload?.thread_name).toBe('spaces/AAAA/threads/T1')
    expect(payload?.parameters).toBeUndefined()
  })

  test('returns null without a space name', () => {
    const payload = googleChatCardClickPayload({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'approve' }
    })
    expect(payload).toBeNull()
  })

  test('returns null without an invoked function', () => {
    const payload = googleChatCardClickPayload({
      type: 'CARD_CLICKED',
      space: { name: 'spaces/AAAA', type: 'SPACE' }
    })
    expect(payload).toBeNull()
  })
})
