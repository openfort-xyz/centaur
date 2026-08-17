import { test, expect, describe } from 'bun:test'
import {
  googleChatCardClickPayload,
  googleChatWorkflowEvent,
  clampPlainText,
  parseChatBody,
  settleBeforeDeadline,
  createGooglechatbot
} from './index'
import { loadConfig } from './config'
import { ChatOwnershipError } from './chat/client'
import { createMemoryState } from '@chat-adapter/state-memory'

describe('durable startup health', () => {
  test('clamps control messages by serialized UTF-8 bytes', () => {
    const text = clampPlainText('🔥"'.repeat(20_000))
    expect(Buffer.byteLength(JSON.stringify({ text }), 'utf8')).toBeLessThanOrEqual(32_000)
    expect(text.endsWith('…')).toBe(true)
  })

  test('returns the timeout result before a stalled ingress operation', async () => {
    const stalled = new Promise<string>(() => undefined)
    expect(await settleBeforeDeadline(stalled, 1, () => 'timeout')).toBe('timeout')
  })

  test('rejects an unauthenticated event before evaluating its oversized body', async () => {
    const bot = createGooglechatbot(loadConfig({
      GOOGLECHATBOT_PROJECT_NUMBER: 'fixture-project'
    }), { state: createMemoryState() })
    const response = await bot.app.request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-length': String(2 * 1024 * 1024) },
      body: '{}'
    })
    expect(response.status).toBe(401)
  })

  test('production construction fails closed without Postgres', () => {
    expect(() => createGooglechatbot(loadConfig({}))).toThrow('DATABASE_URL')
  })

  test('liveness is process-only while readiness waits for state', async () => {
    const state = createMemoryState()
    const connect = state.connect.bind(state)
    let release!: () => void
    state.connect = async () => {
      await new Promise<void>(resolve => {
        release = resolve
      })
      await connect()
    }
    const bot = createGooglechatbot(loadConfig({}), { state })

    expect((await bot.app.request('/health/live')).status).toBe(200)
    expect((await bot.app.request('/health/ready')).status).toBe(503)
    release()
    await bot.stateConnected
    expect((await bot.app.request('/health/ready')).status).toBe(200)
  })
})

describe('api-rs-only /api/chat routes', () => {
  const appWith = (env: Record<string, string>) =>
    createGooglechatbot(loadConfig({ ...env }), { state: createMemoryState() })
  const post = (bot: ReturnType<typeof appWith>, headers: Record<string, string>, body: unknown) =>
    bot.app.request('/api/chat/spaces/A/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })

  test('fails closed when the api-rs-only credential is absent', async () => {
    const res = await post(appWith({}), {}, { text: 'hi' })
    expect(res.status).toBe(503)
  })

  test('rejects a wrong token without reflecting either credential', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'internal-secret-value' })
    const res = await post(bot, { Authorization: 'Bearer wrong-secret-value' }, { text: 'hi' })
    expect(res.status).toBe(401)
    const text = await res.text()
    expect(text).not.toContain('internal-secret-value')
    expect(text).not.toContain('wrong-secret-value')
  })

  test('does not leak credential-bearing upstream details in logs or responses', async () => {
    const secret = 'internal-secret-value'
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: secret })
    bot.client.createMessage = (async () => {
      throw new Error(`OAuth failed with Bearer ${secret}`)
    }) as typeof bot.client.createMessage
    const logged: unknown[][] = []
    const realError = console.error
    console.error = (...values: unknown[]) => logged.push(values)
    try {
      const res = await post(bot, { Authorization: `Bearer ${secret}` }, { text: 'hi' })
      expect(res.status).toBe(502)
      expect(await res.text()).not.toContain(secret)
      expect(JSON.stringify(logged)).not.toContain(secret)
    } finally {
      console.error = realError
    }
  })

  test('binds the route space and rejects invalid resource names and bodies', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    const headers = { Authorization: 'Bearer secret' }
    expect((await post(bot, headers, {})).status).toBe(400)
    const invalid = await bot.app.request('/api/chat/spaces/%21bad/messages', { headers })
    expect(invalid.status).toBe(400)
    const oversized = await bot.app.request('/api/chat/spaces/A/messages', {
      method: 'POST',
      headers,
      body: 'x'.repeat(1024 * 1024 + 1)
    })
    expect(oversized.status).toBe(413)
  })

  test('passes the resource-bound space to the Chat client', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    let calledWith = ''
    bot.client.createMessage = (async space => {
      calledWith = space
      return { name: 'spaces/A/messages/M1' }
    }) as typeof bot.client.createMessage
    const res = await post(bot, { Authorization: 'Bearer secret' }, { text: 'hi' })
    expect(res.status).toBe(200)
    expect(calledWith).toBe('spaces/A')
  })

  test('validates thread ownership and resolves the official space type before sending', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    let options: unknown
    bot.client.getSpace = async () => ({ name: 'spaces/A', spaceType: 'GROUP_CHAT' })
    bot.client.createMessage = (async (_space, _message, opts) => {
      options = opts
      return { name: 'spaces/A/messages/M1' }
    }) as typeof bot.client.createMessage
    const headers = { Authorization: 'Bearer secret' }

    expect((await post(bot, headers, {
      text: 'hi', thread_name: 'spaces/A/threads/T1'
    })).status).toBe(200)
    expect(options).toEqual({
      threadName: 'spaces/A/threads/T1',
      spaceType: 'GROUP_CHAT'
    })
    expect((await post(bot, headers, {
      text: 'hi', thread_name: 'spaces/OTHER/threads/T1'
    })).status).toBe(400)
  })

  test('implements every api-rs proxy resource route without a relay 404', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    bot.client.listSpaces = async () => ({ spaces: [] })
    bot.client.getSpace = async () => ({ name: 'spaces/A' })
    bot.client.listMessages = async () => ({ messages: [] })
    bot.client.listMemberships = async () => ({ memberships: [] })
    bot.client.listMessageReactions = async () => ({ reactions: [] })
    bot.client.canReadReactions = () => true
    bot.client.getAttachment = async () => ({
      name: 'spaces/A/messages/M1/attachments/F1'
    })
    bot.client.setupDm = async () => ({ name: 'spaces/DM' })
    bot.client.canSetupDm = () => true
    const headers = { Authorization: 'Bearer secret' }
    const requests: Array<[string, RequestInit?]> = [
      ['/api/chat/spaces'],
      ['/api/chat/spaces/A'],
      ['/api/chat/spaces/A/messages'],
      ['/api/chat/spaces/A/messages?filter=thread.name%20%3D%20spaces%2FA%2Fthreads%2FT1'],
      ['/api/chat/spaces/A/members'],
      ['/api/chat/spaces/A/messages/M1/reactions'],
      ['/api/chat/spaces/A/messages/M1/attachments/F1'],
      ['/api/chat/dms/setup?target_identity=person%40example.com', { method: 'POST', body: '{}' }]
    ]
    for (const [url, init] of requests) {
      const response = await bot.app.request(url, { ...init, headers })
      expect(response.status).toBe(200)
    }
  })

  test('uses the api-rs broker subject for every delegated DM read', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    const credentials: unknown[] = []
    bot.client.listSpaces = async opts => {
      credentials.push(opts?.credential)
      return { spaces: [] }
    }
    let showDeleted = false
    bot.client.listMessages = async (_space, opts) => {
      credentials.push(opts?.credential)
      showDeleted = opts?.showDeleted === true
      return { messages: [] }
    }
    bot.client.listMemberships = async (_space, opts) => {
      credentials.push(opts?.credential)
      return { memberships: [] }
    }
    bot.client.listMessageReactions = async (_message, opts) => {
      credentials.push(opts?.credential)
      return { reactions: [] }
    }
    const headers = {
      Authorization: 'Bearer secret',
      'x-centaur-google-chat-dwd-subject': 'alice@example.com'
    }
    for (const path of [
      '/api/chat/spaces?page_size=100',
      '/api/chat/spaces/A/messages?page_size=100&show_deleted=true',
      '/api/chat/spaces/A/members?page_size=100',
      '/api/chat/spaces/A/messages/M1/reactions?page_size=100'
    ]) {
      expect((await bot.app.request(path, { headers })).status).toBe(200)
    }
    expect(credentials).toEqual(Array(4).fill({
      kind: 'delegated-etl-reader',
      subject: 'alice@example.com'
    }))
    expect(showDeleted).toBe(true)

    const malformed = await bot.app.request('/api/chat/spaces', {
      headers: { ...headers, 'x-centaur-google-chat-dwd-subject': 'Alice@example.com' }
    })
    expect(malformed.status).toBe(400)
    expect(credentials).toHaveLength(4)
  })

  test('forwards show_deleted with app authentication', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    let showDeleted = false
    bot.client.listMessages = async (_space, opts) => {
      showDeleted = opts?.showDeleted === true
      return {}
    }
    const response = await bot.app.request(
      '/api/chat/spaces/A/messages?show_deleted=true',
      { headers: { Authorization: 'Bearer secret' } }
    )
    expect(response.status).toBe(200)
    expect(showDeleted).toBe(true)
  })

  test('forwards message query options unchanged to the Chat client', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    let options: unknown
    bot.client.listMessages = async (_space, opts) => {
      options = opts
      return {}
    }
    const response = await bot.app.request(
      '/api/chat/spaces/A/messages?page_size=1000&page_token=next%2Fpage&filter=createTime%20%3E%20%222026-08-13T00%3A00%3A00Z%22&order_by=createTime%20DESC',
      { headers: { Authorization: 'Bearer secret' } }
    )

    expect(response.status).toBe(200)
    expect(options).toEqual({
      pageSize: 1000,
      pageToken: 'next/page',
      filter: 'createTime > "2026-08-13T00:00:00Z"',
      orderBy: 'createTime DESC'
    })
  })

  test('fails DM setup closed before Google when its delegated subject is absent', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    let called = false
    bot.client.setupDm = async () => {
      called = true
      return {}
    }
    const res = await bot.app.request('/api/chat/dms/setup?target_identity=person%40example.com', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: '{}'
    })
    expect(res.status).toBe(503)
    expect(called).toBe(false)
  })

  test('accepts email DM targets and rejects user resource names before Google', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    let target = ''
    bot.client.canSetupDm = () => true
    bot.client.setupDm = async identity => {
      target = identity
      return { name: 'spaces/DM' }
    }
    const res = await bot.app.request(
      '/api/chat/dms/setup?target_identity=Person%40Example.COM',
      { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: '{}' }
    )
    expect(res.status).toBe(200)
    expect(target).toBe('person@example.com')

    for (const invalidTarget of ['users/123456789', 'users/person@example.com']) {
      const invalid = await bot.app.request(
        `/api/chat/dms/setup?target_identity=${encodeURIComponent(invalidTarget)}`,
        { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: '{}' }
      )
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({
        error: 'Google Chat DM target must be an email address'
      })
    }
    expect(target).toBe('person@example.com')
  })

  test('returns an empty JSON object after an empty upstream DELETE', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    bot.client.deleteOwnedMessage = (async () => ({})) as typeof bot.client.deleteOwnedMessage
    const res = await bot.app.request('/api/chat/spaces/A/messages/M1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer secret' }
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  test('maps ownership rejection to 403', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    bot.client.updateOwnedMessage = (async () => {
      throw new ChatOwnershipError('Google Chat message is not owned by this integration')
    }) as typeof bot.client.updateOwnedMessage
    const res = await bot.app.request('/api/chat/spaces/A/messages/M1', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'changed' })
    })
    expect(res.status).toBe(403)
  })

  test('passes only the trusted internal delegated subject to ownership checks', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    let received: string | undefined
    bot.client.updateOwnedMessage = (async (_space, _message, _update, subject) => {
      received = subject
      return { name: 'spaces/A/messages/M1', text: 'changed' }
    }) as typeof bot.client.updateOwnedMessage
    const res = await bot.app.request('/api/chat/spaces/A/messages/M1', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer secret',
        'content-type': 'application/json',
        'x-centaur-google-chat-dwd-subject': 'reader@example.com'
      },
      body: JSON.stringify({ text: 'changed' })
    })

    expect(res.status).toBe(200)
    expect(received).toBe('reader@example.com')
  })

  test('requires text when authenticated', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    const res = await post(bot, { Authorization: 'Bearer secret' }, {})
    expect(res.status).toBe(400)
  })

  test('streams message-qualified attachment bytes with safe headers', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    bot.client.resolveAttachment = async () => ({
      attachment: {
        name: 'spaces/A/messages/M1/attachments/F1',
        contentName: 'report\r\nunsafe.pdf',
        contentType: 'application/pdf',
        source: 'UPLOADED_CONTENT',
        attachmentDataRef: { resourceName: 'media/F1' }
      },
      credential: 'app'
    })
    bot.client.downloadAttachmentResource = async () => ({
      data: new TextEncoder().encode('%PDF').buffer,
      mimeType: 'application/pdf',
      name: 'report\r\nunsafe.pdf',
      size: 4
    })
    const response = await bot.app.request(
      '/api/chat/spaces/A/messages/M1/attachments/F1/download',
      { headers: { Authorization: 'Bearer secret' } }
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).not.toContain('\r')
    expect(response.headers.get('content-disposition')).not.toContain('\n')
    expect(await response.text()).toBe('%PDF')
  })

  test('uses the trusted delegated subject for attachment metadata and media', async () => {
    const bot = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    const subjects: Array<string | undefined> = []
    let mediaCredential: unknown
    bot.client.getAttachment = (async (_message, _attachment, subject) => {
      subjects.push(subject)
      return { name: 'spaces/A/messages/M1/attachments/F1' }
    }) as typeof bot.client.getAttachment
    bot.client.resolveAttachment = (async (_message, _attachment, subject) => {
      subjects.push(subject)
      return {
        attachment: {
          name: 'spaces/A/messages/M1/attachments/F1',
          contentName: 'report.pdf',
          contentType: 'application/pdf',
          source: 'UPLOADED_CONTENT',
          attachmentDataRef: { resourceName: 'media/F1' }
        },
        credential: { kind: 'delegated-reader', subject: subject! }
      }
    }) as typeof bot.client.resolveAttachment
    bot.client.downloadAttachmentResource = (async (_attachment, credential) => {
      mediaCredential = credential
      return {
        data: new TextEncoder().encode('%PDF').buffer,
        mimeType: 'application/pdf',
        name: 'report.pdf',
        size: 4
      }
    }) as typeof bot.client.downloadAttachmentResource
    const headers = {
      Authorization: 'Bearer secret',
      'x-centaur-google-chat-dwd-subject': 'reader@example.com'
    }

    expect((await bot.app.request(
      '/api/chat/spaces/A/messages/M1/attachments/F1',
      { headers }
    )).status).toBe(200)
    expect((await bot.app.request(
      '/api/chat/spaces/A/messages/M1/attachments/F1/download',
      { headers }
    )).status).toBe(200)
    expect(subjects).toEqual(['reader@example.com', 'reader@example.com'])
    expect(mediaCredential).toEqual({
      kind: 'delegated-reader',
      subject: 'reader@example.com'
    })
  })
})

describe('outbound /api/chat/attachments', () => {
  const appWith = (env: Record<string, string>) =>
    createGooglechatbot(loadConfig({ ...env }), { state: createMemoryState() }).app
  const post = (app: ReturnType<typeof appWith>, headers: Record<string, string>, body: unknown) =>
    app.request('/api/chat/spaces/A/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })

  test('fails closed (503) when GOOGLECHATBOT_INTERNAL_API_KEY is not configured', async () => {
    const res = await post(appWith({}), {}, {})
    expect(res.status).toBe(503)
  })

  test('reports uploads unconfigured (503) without GOOGLECHATBOT_UPLOAD_USER', async () => {
    const app = appWith({ GOOGLECHATBOT_INTERNAL_API_KEY: 'secret' })
    const res = await post(
      app,
      { Authorization: 'Bearer secret' },
      { filename: 'a.png', content_base64: 'aGk=' }
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('GOOGLECHATBOT_UPLOAD_USER')
  })

  test('requires space_name, filename and content_base64 (400) when configured', async () => {
    const app = appWith({
      GOOGLECHATBOT_INTERNAL_API_KEY: 'secret',
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
      GOOGLECHATBOT_INTERNAL_API_KEY: 'secret',
      GOOGLECHATBOT_UPLOAD_USER: 'files@openfort.xyz',
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'sa@example.iam.gserviceaccount.com',
        private_key: 'key'
      })
    })
    const res = await post(
      app,
      { Authorization: 'Bearer secret' },
      { filename: 'a.txt', content_base64: 'SGVsbG8h%%%%V29ybGQh' }
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('not valid base64')
  })

  test('resolves the official space type before a threaded attachment create', async () => {
    const bot = createGooglechatbot(loadConfig({
      GOOGLECHATBOT_INTERNAL_API_KEY: 'secret'
    }), { state: createMemoryState() })
    let options: unknown
    let uploadSubject: string | undefined
    bot.client.canUploadAttachments = () => true
    bot.client.getSpace = async () => ({ name: 'spaces/A', spaceType: 'SPACE' })
    bot.client.uploadAttachment = (async (_space, _name, _type, _data, subject) => {
      uploadSubject = subject
      return { attachmentDataRef: { resourceName: 'media/F1' } }
    }) as typeof bot.client.uploadAttachment
    bot.client.createAttachmentMessage = (async (_space, _attachment, opts) => {
      options = opts
      return { name: 'spaces/A/messages/M1' }
    }) as typeof bot.client.createAttachmentMessage

    const response = await bot.app.request('/api/chat/spaces/A/attachments', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'content-type': 'application/json',
        'x-centaur-google-chat-dwd-subject': 'arnau@example.com'
      },
      body: JSON.stringify({
        filename: 'a.txt',
        content_base64: 'aGk=',
        thread_name: 'spaces/A/threads/T1'
      })
    })

    expect(response.status).toBe(200)
    expect(uploadSubject).toBe('arnau@example.com')
    expect(options).toEqual({
      threadName: 'spaces/A/threads/T1',
      spaceType: 'SPACE',
      subject: 'arnau@example.com'
    })
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
  test('supports legacy Card v1 actions and dialog submissions', () => {
    const event = googleChatWorkflowEvent({
      type: 'CARD_CLICKED',
      dialogEventType: 'SUBMIT_DIALOG',
      space: { name: 'spaces/AAAA', spaceType: 'SPACE' },
      action: {
        actionMethodName: 'save',
        parameters: [{ key: 'request_id', value: 'r1' }]
      }
    })
    expect(event?.payload).toMatchObject({
      event_type: 'submit_form',
      invoked_function: 'save',
      parameters: { request_id: 'r1' }
    })
    const parsed = parseChatBody(JSON.stringify({
      type: 'CARD_CLICKED',
      dialogEventType: 'SUBMIT_DIALOG',
      space: { name: 'spaces/AAAA', spaceType: 'SPACE' },
      action: { actionMethodName: 'save' }
    }))
    expect(parsed?.dialogEventType).toBe('SUBMIT_DIALOG')
  })

  test('uses the converted Add-on action method compatibility parameter', () => {
    const payload = googleChatCardClickPayload({
      type: 'CARD_CLICKED',
      space: { name: 'spaces/AAAA', spaceType: 'SPACE' },
      common: { parameters: { __action_method_name__: 'approve', request_id: 'r1' } }
    })
    expect(payload?.invoked_function).toBe('approve')
  })
  test('extracts invoked function, parameters, thread and user context', () => {
    const payload = googleChatCardClickPayload({
      type: 'CARD_CLICKED',
      space: { name: 'spaces/AAAA', type: 'SPACE' },
      message: { name: 'spaces/AAAA/messages/M1', thread: { name: 'spaces/AAAA/threads/T1' } },
      thread: { name: 'spaces/AAAA/threads/T1' },
      user: { name: 'users/U1', displayName: 'Alice' },
      common: { invokedFunction: 'approve', parameters: { request_id: 'r1' } }
    })

    expect(payload).toEqual({
      event_type: 'card_click',
      invoked_function: 'approve',
      message_name: 'spaces/AAAA/messages/M1',
      parameters: { request_id: 'r1' },
      space_name: 'spaces/AAAA',
      thread_name: 'spaces/AAAA/threads/T1',
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

  test('normalizes Workspace Add-ons button, command, and form payloads', () => {
    const fixtures = [
      {
        raw: {
          commonEventObject: { parameters: { actionName: 'approve', request_id: 'r1' } },
          chat: {
            eventTime: '2026-01-01T00:00:00Z',
            user: { name: 'users/U1' },
            buttonClickedPayload: {
              space: { name: 'spaces/AAAA', type: 'SPACE' },
              message: { name: 'spaces/AAAA/messages/M1' }
            }
          }
        },
        type: 'CARD_CLICKED'
      },
      {
        raw: {
          chat: {
            user: { name: 'users/U1' },
            appCommandPayload: {
              space: { name: 'spaces/AAAA', type: 'SPACE' },
              appCommandMetadata: { appCommandId: '42', appCommandType: 'QUICK_COMMAND' }
            }
          }
        },
        type: 'APP_COMMAND'
      },
      {
        raw: {
          commonEventObject: {
            parameters: { actionName: 'save' },
            formInputs: { title: { stringInputs: { value: ['hello'] } } }
          },
          chat: {
            user: { name: 'users/U1' },
            buttonClickedPayload: {
              space: { name: 'spaces/AAAA', type: 'SPACE' },
              message: { name: 'spaces/AAAA/messages/M1' },
              dialogEventType: 'SUBMIT_DIALOG'
            }
          }
        },
        type: 'SUBMIT_FORM'
      }
    ]

    expect(fixtures.map(({ raw }) => parseChatBody(JSON.stringify(raw))?.type))
      .toEqual(fixtures.map(({ type }) => type))
  })
})
