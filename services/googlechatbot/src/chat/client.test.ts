import { afterEach, describe, expect, test } from 'bun:test'
import { createMemoryState } from '@chat-adapter/state-memory'
import { loadConfig } from '../config'
import {
  ChatApiError,
  ChatConfigurationError,
  ChatEdgeClient,
  MAX_DRIVE_EXPORT_BYTES,
  retryBackoffMs
} from './client'
import { generateRsaKeyPair } from './test-jwt'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('ChatEdgeClient bot identity', () => {
  test('resolves members/app once and caches the canonical numeric bot resource', async () => {
    const pair = await generateRsaKeyPair()
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    const privateKey = [
      '-----BEGIN PRIVATE KEY-----',
      Buffer.from(pkcs8).toString('base64'),
      '-----END PRIVATE KEY-----'
    ].join('\n')
    const calls: string[] = []
    let appAssertion: Record<string, unknown> = {}
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        appAssertion = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString())
        return Response.json({ access_token: 'token', expires_in: 3600 })
      }
      return Response.json({ member: { name: 'users/123456789', type: 'BOT' } })
    }) as unknown as typeof fetch

    const client = new ChatEdgeClient(loadConfig({
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'bot@example.iam.gserviceaccount.com',
        private_key: privateKey
      })
    }))

    expect(await client.getBotUserName('spaces/AAAA')).toBe('users/123456789')
    expect(await client.getBotUserName('spaces/BBBB')).toBe('users/123456789')
    expect(calls.filter(url => url.endsWith('/spaces/AAAA/members/app'))).toHaveLength(1)
    expect(calls.some(url => url.includes('/spaces/BBBB/members/app'))).toBe(false)
    expect(appAssertion).not.toHaveProperty('sub')
  })
})

describe('ChatEdgeClient owned message mutation', () => {
  async function configuredClient(
    fetchImpl: typeof fetch,
    env: Record<string, string> = {},
    timing: ConstructorParameters<typeof ChatEdgeClient>[1] = {}
  ): Promise<ChatEdgeClient> {
    const pair = await generateRsaKeyPair()
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    globalThis.fetch = fetchImpl
    return new ChatEdgeClient(loadConfig({
      GOOGLECHATBOT_UPLOAD_USER: 'uploader@example.com',
      ...env,
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'bot@example.iam.gserviceaccount.com',
        private_key: [
          '-----BEGIN PRIVATE KEY-----',
          Buffer.from(pkcs8).toString('base64'),
          '-----END PRIVATE KEY-----'
        ].join('\n')
      })
    }), timing)
  }

  test('updates only the app-authored message with the app token', async () => {
    const mutations: string[] = []
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'bot-token', expires_in: 3600 })
      }
      if (url.endsWith('/members/app')) {
        return Response.json({ member: { name: 'users/123', type: 'BOT' } })
      }
      if (init?.method === 'GET') {
        return Response.json({ sender: { name: 'users/123', type: 'BOT' } })
      }
      mutations.push(String(new Headers(init?.headers).get('authorization')))
      return Response.json({ name: 'spaces/A/messages/M1', text: 'changed' })
    }) as typeof fetch)

    await client.updateOwnedMessage('spaces/A', 'spaces/A/messages/M1', { text: 'changed' })
    expect(mutations).toEqual(['Bearer bot-token'])
  })

  test('uses a trusted delegated reader when app auth does not resolve members/app', async () => {
    const mutations: string[] = []
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        const payload = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString())
        return Response.json({
          access_token: payload.sub ? 'reader-token' : 'bot-token',
          expires_in: 3600
        })
      }
      if (url.endsWith('/members/app')) {
        return new Headers(init?.headers).get('authorization') === 'Bearer reader-token'
          ? Response.json({ member: { name: 'users/123', type: 'BOT' } })
          : Response.json({ error: 'membership unavailable' }, { status: 403 })
      }
      if (init?.method === 'GET') {
        return Response.json({ sender: { name: 'users/123', type: 'BOT' } })
      }
      mutations.push(String(new Headers(init?.headers).get('authorization')))
      return Response.json({ name: 'spaces/A/messages/M1', text: 'changed' })
    }) as typeof fetch)

    await client.updateOwnedMessage('spaces/A', 'spaces/A/messages/M1', { text: 'changed' })
    expect(mutations).toEqual(['Bearer bot-token'])
  })

  test('uses a trusted DM reader only to prove bot ownership before app mutation', async () => {
    const mutations: string[] = []
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const authorization = String(new Headers(init?.headers).get('authorization'))
      if (url.includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        const payload = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString())
        return Response.json({
          access_token: payload.sub === 'reader@example.com' ? 'reader-token' : 'bot-token',
          expires_in: 3600
        })
      }
      if (url.endsWith('/members/app')) {
        return authorization === 'Bearer reader-token'
          ? Response.json({ member: { name: 'users/123', type: 'BOT' } })
          : Response.json({ error: 'membership unavailable' }, { status: 403 })
      }
      if (init?.method === 'GET') {
        return authorization === 'Bearer reader-token'
          ? Response.json({ sender: { name: 'users/123', type: 'BOT' } })
          : Response.json({ error: 'DMs are not supported' }, { status: 400 })
      }
      mutations.push(authorization)
      return Response.json({ name: 'spaces/DM/messages/M1', text: 'changed' })
    }) as typeof fetch)

    await client.updateOwnedMessage(
      'spaces/DM',
      'spaces/DM/messages/M1',
      { text: 'changed' },
      'reader@example.com'
    )
    expect(mutations).toEqual(['Bearer bot-token'])
  })

  test('trusted DM reader cannot authorize mutation of a human message', async () => {
    let mutated = false
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        const payload = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString())
        return Response.json({ access_token: payload.sub ? 'delegated-token' : 'bot-token', expires_in: 3600 })
      }
      if (url.endsWith('/members/app')) {
        return Response.json({ member: { name: 'users/123', type: 'BOT' } })
      }
      if (url.endsWith('/spaces/DM/members/reader%40example.com')) {
        return Response.json({ member: { name: 'users/U1', type: 'HUMAN' } })
      }
      if (init?.method === 'GET') {
        return new Headers(init.headers).get('authorization') === 'Bearer bot-token'
          ? Response.json({ error: 'DMs are not supported' }, { status: 400 })
          : Response.json({ sender: { name: 'users/U1', type: 'HUMAN' } })
      }
      mutated = true
      return Response.json({})
    }) as typeof fetch)

    await expect(client.deleteOwnedMessage(
      'spaces/DM',
      'spaces/DM/messages/M1',
      'reader@example.com'
    )).rejects.toThrow('not owned')
    expect(mutated).toBe(false)
  })

  test('uses the delegated token only for a message authored by that user and accepts empty DELETE', async () => {
    let tokenExchanges = 0
    const mutations: string[] = []
    let delegatedAssertion: Record<string, string> = {}
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        tokenExchanges += 1
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        const payload = JSON.parse(
          Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()
        ) as Record<string, string>
        if (payload.scope === [
          'https://www.googleapis.com/auth/chat.messages',
          'https://www.googleapis.com/auth/chat.memberships.readonly'
        ].join(' ')) {
          delegatedAssertion = payload
        }
        return Response.json({
          access_token: tokenExchanges === 1 ? 'bot-token' : 'delegated-token',
          expires_in: 3600
        })
      }
      if (url.endsWith('/members/app')) {
        return Response.json({ member: { name: 'users/123', type: 'BOT' } })
      }
      if (url.endsWith('/spaces/A/members/arnau%40example.com')) {
        return Response.json({ member: { name: 'users/U1', type: 'HUMAN' } })
      }
      if (init?.method === 'GET') {
        const token = new Headers(init.headers).get('authorization')
        return token === 'Bearer delegated-token'
          ? Response.json({
              sender: { name: 'users/U1', type: 'HUMAN' },
              clientAssignedMessageId: 'client-centaur-upload-1'
            })
          : Response.json({ error: 'app cannot read this message' }, { status: 403 })
      }
      mutations.push(String(new Headers(init?.headers).get('authorization')))
      return new Response(null, { status: 204 })
    }) as typeof fetch)

    expect(await client.deleteOwnedMessage(
      'spaces/A',
      'spaces/A/messages/M1',
      'arnau@example.com'
    )).toEqual({})
    expect(mutations).toEqual(['Bearer delegated-token'])
    expect(delegatedAssertion).toMatchObject({
      sub: 'arnau@example.com',
      scope: [
        'https://www.googleapis.com/auth/chat.messages',
        'https://www.googleapis.com/auth/chat.memberships.readonly'
      ].join(' ')
    })
  })

  test('uses only text in the delegated update mask', async () => {
    const calls: string[] = []
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        const payload = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString())
        return Response.json({
          access_token: payload.sub ? 'delegated-token' : 'bot-token',
          expires_in: 3600
        })
      }
      if (url.endsWith('/members/app')) {
        return Response.json({ member: { name: 'users/123', type: 'BOT' } })
      }
      if (url.endsWith('/spaces/A/members/uploader%40example.com')) {
        return Response.json({ member: { name: 'users/U1', type: 'HUMAN' } })
      }
      if (init?.method === 'GET') {
        return new Headers(init.headers).get('authorization') === 'Bearer delegated-token'
          ? Response.json({
              sender: { name: 'users/U1', type: 'HUMAN' },
              clientAssignedMessageId: 'client-centaur-upload-2'
            })
          : Response.json({}, { status: 403 })
      }
      return Response.json({ name: 'spaces/A/messages/M1', text: 'changed' })
    }) as typeof fetch)

    await client.updateOwnedMessage('spaces/A', 'spaces/A/messages/M1', { text: 'changed' })
    expect(calls.at(-1)).toEndWith('/spaces/A/messages/M1?updateMask=text')
  })

  test('rejects a message authored by another user before mutation', async () => {
    let mutated = false
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'token', expires_in: 3600 })
      }
      if (url.endsWith('/members/app')) {
        return Response.json({ member: { name: 'users/123', type: 'BOT' } })
      }
      if (url.endsWith('/spaces/A/members/uploader%40example.com')) {
        return Response.json({ member: { name: 'users/U1', type: 'HUMAN' } })
      }
      if (init?.method === 'GET') {
        return Response.json({ sender: { name: 'users/U2' } })
      }
      mutated = true
      return Response.json({})
    }) as typeof fetch)

    await expect(client.deleteOwnedMessage('spaces/A', 'spaces/A/messages/M1')).rejects.toThrow(
      'not owned'
    )
    expect(mutated).toBe(false)
  })

  test('uses only chat.spaces.create for delegated DM setup', async () => {
    let assertionPayload: Record<string, string> = {}
    let authorization = ''
    let requestBody: Record<string, unknown> = {}
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        assertionPayload = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString())
        return Response.json({ access_token: 'dm-token', expires_in: 3600 })
      }
      authorization = String(new Headers(init?.headers).get('authorization'))
      requestBody = JSON.parse(String(init?.body))
      return Response.json({ name: 'spaces/DM' })
    }) as typeof fetch)

    await client.setupDm('person@example.com')
    expect(assertionPayload.scope).toBe('https://www.googleapis.com/auth/chat.spaces.create')
    expect(assertionPayload.sub).toBe('person@example.com')
    expect(authorization).toBe('Bearer dm-token')
    expect(requestBody).toEqual({
      space: { spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
      requestId: expect.any(String),
      memberships: []
    })
  })

  test('rejects a non-email DM target before exchanging a token', async () => {
    let called = false
    const client = await configuredClient((async () => {
      called = true
      return Response.json({})
    }) as unknown as typeof fetch)

    await expect(client.setupDm('users/123456')).rejects.toThrow('must be an email address')
    expect(called).toBe(false)
  })

  test('retries a rate-limited multipart upload', async () => {
    let uploadCalls = 0
    const client = await configuredClient((async (input: RequestInfo | URL) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'upload-token', expires_in: 3600 })
      }
      uploadCalls += 1
      if (uploadCalls === 1) {
        return new Response('retry', { status: 429, headers: { 'retry-after': '0' } })
      }
      return Response.json({ attachmentDataRef: { resourceName: 'media/F1' } })
    }) as typeof fetch)

    expect(await client.uploadAttachment(
      'spaces/A',
      'report.txt',
      'text/plain',
      new TextEncoder().encode('hello')
    )).toEqual({ attachmentDataRef: { resourceName: 'media/F1' } })
    expect(uploadCalls).toBe(2)
  })

  test('does not retry an ambiguous multipart upload transport failure', async () => {
    let uploadCalls = 0
    const client = await configuredClient((async (input: RequestInfo | URL) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'upload-token', expires_in: 3600 })
      }
      uploadCalls += 1
      throw new TypeError('connection reset after upload')
    }) as typeof fetch)

    await expect(client.uploadAttachment(
      'spaces/A',
      'report.txt',
      'text/plain',
      new TextEncoder().encode('hello')
    )).rejects.toThrow('connection reset')
    expect(uploadCalls).toBe(1)
  })

  test('paces attachment upload and its message create through one write gate', async () => {
    let now = 0
    const starts: number[] = []
    const client = await configuredClient((async (input: RequestInfo | URL) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'upload-token', expires_in: 3600 })
      }
      starts.push(now)
      return starts.length === 1
        ? Response.json({ attachmentDataRef: { resourceName: 'media/F1' } })
        : Response.json({ name: 'spaces/A/messages/M1' })
    }) as typeof fetch, {}, {
      now: () => now,
      sleep: async milliseconds => { now += milliseconds }
    })

    const attachment = await client.uploadAttachment(
      'spaces/A',
      'report.txt',
      'text/plain',
      new TextEncoder().encode('hello')
    )
    await client.createAttachmentMessage('spaces/A', attachment)

    expect(starts).toEqual([0, 1_000])
  })

  test('uses and caches the exact mapped subject for upload and attachment create', async () => {
    const assertions: Array<Record<string, string>> = []
    const authorizations: string[] = []
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        assertions.push(JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()))
        return Response.json({ access_token: 'arnau-upload-token', expires_in: 3600 })
      }
      authorizations.push(String(new Headers(init?.headers).get('authorization')))
      return authorizations.length === 1
        ? Response.json({ attachmentDataRef: { resourceName: 'media/F1' } })
        : Response.json({ name: 'spaces/DM/messages/server-generated' })
    }) as typeof fetch)

    const attachment = await client.uploadAttachment(
      'spaces/DM',
      'report.txt',
      'text/plain',
      new TextEncoder().encode('hello'),
      'arnau@example.com'
    )
    await client.createAttachmentMessage('spaces/DM', attachment, {
      subject: 'arnau@example.com'
    })

    expect(assertions).toEqual([expect.objectContaining({
      sub: 'arnau@example.com',
      scope: 'https://www.googleapis.com/auth/chat.messages.create'
    })])
    expect(authorizations).toEqual(['Bearer arnau-upload-token', 'Bearer arnau-upload-token'])
  })

  test('resolves and downloads a user-authored attachment with one delegated read credential', async () => {
    const assertions: Array<Record<string, string>> = []
    const requests: Array<{ url: string; authorization: string }> = []
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        assertions.push(JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()))
        return Response.json({ access_token: 'reader-token', expires_in: 3600 })
      }
      requests.push({
        url,
        authorization: String(new Headers(init?.headers).get('authorization'))
      })
      if (url.endsWith('/spaces/A/messages/M1')) {
        return Response.json({
          name: 'spaces/A/messages/M1',
          attachment: [{
            name: 'spaces/A/messages/M1/attachments/F1',
            contentName: 'report.txt',
            contentType: 'text/plain',
            source: 'UPLOADED_CONTENT',
            attachmentDataRef: { resourceName: 'media/F1' }
          }]
        })
      }
      return new Response('hello', { headers: { 'content-type': 'text/plain' } })
    }) as typeof fetch)

    const resolved = await client.resolveAttachment(
      'spaces/A/messages/M1',
      'F1',
      'reader@example.com'
    )
    expect(await client.downloadAttachmentResource(
      resolved.attachment,
      resolved.credential
    )).toMatchObject({ name: 'report.txt', mimeType: 'text/plain', size: 5 })

    expect(assertions).toEqual([expect.objectContaining({
      sub: 'reader@example.com',
      scope: 'https://www.googleapis.com/auth/chat.messages.readonly'
    })])
    expect(requests.map(request => request.url)).toEqual([
      'https://chat.googleapis.com/v1/spaces/A/messages/M1',
      'https://chat.googleapis.com/v1/media/media/F1?alt=media'
    ])
    expect(requests.map(request => request.authorization)).toEqual([
      'Bearer reader-token',
      'Bearer reader-token'
    ])
  })

  test('uses the configured uploader when app auth cannot read its attachment', async () => {
    const assertions: Array<Record<string, string>> = []
    const requests: Array<{ url: string; authorization: string }> = []
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        const payload = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString())
        assertions.push(payload)
        return Response.json({
          access_token: payload.sub ? 'uploader-reader-token' : 'app-token',
          expires_in: 3600
        })
      }
      requests.push({
        url,
        authorization: String(new Headers(init?.headers).get('authorization'))
      })
      if (url.includes('/attachments/')) {
        return Response.json({ error: 'forbidden' }, { status: 403 })
      }
      if (url.endsWith('/spaces/A/messages/M1')) {
        return Response.json({
          name: 'spaces/A/messages/M1',
          attachment: [{
            name: 'spaces/A/messages/M1/attachments/F1',
            contentName: 'report.txt',
            contentType: 'text/plain',
            source: 'UPLOADED_CONTENT',
            attachmentDataRef: { resourceName: 'media/F1' }
          }]
        })
      }
      return new Response('hello', { headers: { 'content-type': 'text/plain' } })
    }) as typeof fetch)

    const resolved = await client.resolveAttachment('spaces/A/messages/M1', 'F1')
    expect(await client.downloadAttachmentResource(
      resolved.attachment,
      resolved.credential
    )).toMatchObject({ name: 'report.txt', mimeType: 'text/plain', size: 5 })

    expect(assertions).toEqual([
      expect.not.objectContaining({ sub: expect.anything() }),
      expect.objectContaining({
        sub: 'uploader@example.com',
        scope: 'https://www.googleapis.com/auth/chat.messages.readonly'
      })
    ])
    expect(requests).toEqual([
      {
        url: 'https://chat.googleapis.com/v1/spaces/A/messages/M1/attachments/F1',
        authorization: 'Bearer app-token'
      },
      {
        url: 'https://chat.googleapis.com/v1/spaces/A/messages/M1',
        authorization: 'Bearer uploader-reader-token'
      },
      {
        url: 'https://chat.googleapis.com/v1/media/media/F1?alt=media',
        authorization: 'Bearer uploader-reader-token'
      }
    ])
  })

  test.each([
    ['parent message', {
      name: 'spaces/OTHER/messages/M1',
      attachment: [{ name: 'spaces/A/messages/M1/attachments/F1' }]
    }, 'parent message'],
    ['attachment resource', {
      name: 'spaces/A/messages/M1',
      attachment: [{ name: 'spaces/OTHER/messages/M1/attachments/F1' }]
    }, 'attachment resource']
  ] as const)('rejects a mismatched delegated %s', async (_case, message, expected) => {
    const client = await configuredClient((async (input: RequestInfo | URL) =>
      String(input).includes('oauth2.googleapis.com/token')
        ? Response.json({ access_token: 'reader-token', expires_in: 3600 })
        : Response.json(message)
    ) as typeof fetch)

    await expect(client.resolveAttachment(
      'spaces/A/messages/M1',
      'F1',
      'reader@example.com'
    )).rejects.toThrow(expected)
  })

  test('does not fall back to app auth when delegated attachment access is denied', async () => {
    const assertions: Array<Record<string, string>> = []
    const urls: string[] = []
    const client = await configuredClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        assertions.push(JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()))
        return Response.json({ access_token: 'reader-token', expires_in: 3600 })
      }
      urls.push(url)
      return Response.json({ error: 'denied' }, { status: 403 })
    }) as typeof fetch)

    await expect(client.resolveAttachment(
      'spaces/A/messages/M1',
      'F1',
      'reader@example.com'
    )).rejects.toBeInstanceOf(ChatApiError)
    expect(assertions).toEqual([expect.objectContaining({
      sub: 'reader@example.com',
      scope: 'https://www.googleapis.com/auth/chat.messages.readonly'
    })])
    expect(urls).toEqual(['https://chat.googleapis.com/v1/spaces/A/messages/M1'])
  })

})

describe('ChatEdgeClient conversation resources', () => {
  test('builds typed pagination, memberships, and reaction requests', async () => {
    const calls: Array<{ url: string; signal?: AbortSignal }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, signal: init?.signal as AbortSignal | undefined })
      if (url.includes('/messages/M1/reactions')) {
        return Response.json({ reactions: [{ name: 'reactions/R1' }], nextPageToken: 'more' })
      }
      return Response.json({})
    }) as typeof fetch
    const client = new ChatEdgeClient(loadConfig({}))

    await client.listSpaces({ pageSize: 7, pageToken: 'a/b', credential: 'app' })
    await client.listMessages('spaces/A', {
      pageSize: 13,
      pageToken: 'message next',
      filter: 'createTime > "2026-08-13T00:00:00Z"',
      orderBy: 'createTime DESC'
    })
    await client.listMemberships('spaces/A', { pageToken: 'members next', credential: 'app' })
    await client.listMessageReactions('spaces/A/messages/M1', { pageSize: 999 })

    expect(calls[0]?.url).toEndWith('/spaces?pageSize=7&pageToken=a%2Fb')
    expect(calls[1]?.url).toEndWith(
      '/spaces/A/messages?pageSize=13&pageToken=message+next&filter=createTime+%3E+%222026-08-13T00%3A00%3A00Z%22&orderBy=createTime+DESC'
    )
    expect(calls[2]?.url).toEndWith('/spaces/A/members?pageToken=members+next')
    expect(calls[3]?.url).toEndWith('/spaces/A/messages/M1/reactions?pageSize=200')
    expect(calls.every(call => call.signal instanceof AbortSignal)).toBe(true)
  })

  test('preserves text and cardsV2 on create and update', async () => {
    const bodies: unknown[] = []
    const urls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input))
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ name: 'spaces/A/messages/M1' })
    }) as typeof fetch
    const client = new ChatEdgeClient(loadConfig({}))
    const message = {
      text: 'Summary',
      cardsV2: [{ cardId: 'result', card: { header: { title: 'Result' } } }]
    }

    await client.createMessage('spaces/A', message)
    await client.updateMessage('spaces/A/messages/M1', message)

    expect(bodies).toEqual([message, message])
    expect(urls[1]).toContain('updateMask=text%2CcardsV2')
  })

  test('reuses one generated message ID across an ambiguous create retry', async () => {
    const urls: string[] = []
    globalThis.fetch = (async input => {
      urls.push(String(input))
      if (urls.length === 1) {
        return new Response('retry', { status: 503, headers: { 'retry-after': '0' } })
      }
      return Response.json({ name: 'spaces/A/messages/M1' })
    }) as typeof fetch

    await new ChatEdgeClient(loadConfig({})).createMessage('spaces/A', { text: 'hello' })
    expect(urls).toHaveLength(2)
    expect(urls[0]).toBe(urls[1])
    expect(new URL(urls[0]!).searchParams.get('messageId')).toMatch(/^client-centaur-[a-z0-9-]+$/)
    expect(new URL(urls[0]!).searchParams.get('requestId')).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('serializes every same-space write one quota window apart', async () => {
    let now = 0
    const starts: number[] = []
    globalThis.fetch = (async () => {
      starts.push(now)
      return Response.json({ name: 'spaces/A/messages/M1' })
    }) as unknown as typeof fetch
    const client = new ChatEdgeClient(loadConfig({}), {
      now: () => now,
      sleep: async milliseconds => { now += milliseconds }
    })

    await Promise.all([
      client.createMessage('spaces/A', { text: 'first' }),
      client.updateMessage('spaces/A/messages/M1', { text: 'second' })
    ])

    expect(starts).toEqual([0, 1_000])
  })

  test('shares the write quota reservation across client instances', async () => {
    let now = 0
    const starts: number[] = []
    const state = createMemoryState()
    await state.connect()
    globalThis.fetch = (async () => {
      starts.push(now)
      return Response.json({ name: 'spaces/A/messages/M1' })
    }) as unknown as typeof fetch
    const timing = {
      now: () => now,
      sleep: async (milliseconds: number) => { now += milliseconds },
      quotaState: state
    }

    try {
      await new ChatEdgeClient(loadConfig({}), timing).createMessage('spaces/A', { text: 'first' })
      await new ChatEdgeClient(loadConfig({}), timing).createMessage('spaces/A', { text: 'second' })
      expect(starts).toEqual([0, 1_000])
    } finally {
      await state.disconnect()
    }
  })

  test('requests deleted tombstones only when explicitly enabled', async () => {
    let url = ''
    globalThis.fetch = (async input => {
      url = String(input)
      return Response.json({ messages: [] })
    }) as typeof fetch
    await new ChatEdgeClient(loadConfig({})).listMessages('spaces/A', {
      showDeleted: true
    })
    expect(url).toEndWith('/spaces/A/messages?showDeleted=true')
  })

  test('threads a reply in a direct message', async () => {
    let url = ''
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (input, init) => {
      url = String(input)
      body = JSON.parse(String(init?.body))
      return Response.json({ name: 'spaces/DM/messages/M1' })
    }) as typeof fetch
    await new ChatEdgeClient(loadConfig({})).createMessage(
      'spaces/DM',
      { text: 'hello' },
      { threadName: 'spaces/DM/threads/T1' }
    )
    // Probed live against a real 1:1 bot DM on 2026-08-19: spaces.get reports
    // spaceThreadingState=THREADED_MESSAGES, and this exact create landed in the
    // requested thread with threadReply=true. The messages.create reference
    // still calls messageReplyOption named-spaces-only; that line is stale.
    expect(new URL(url).pathname).toEndWith('/spaces/DM/messages')
    expect(new URL(url).searchParams.get('messageReplyOption'))
      .toBe('REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD')
    expect(body).toEqual({ text: 'hello', thread: { name: 'spaces/DM/threads/T1' } })
  })

  test('paces direct reaction reads used by ETL and CLI at the shared boundary', async () => {
    let now = 0
    const starts: number[] = []
    globalThis.fetch = (async () => {
      starts.push(now)
      return Response.json({ reactions: [] })
    }) as unknown as typeof fetch
    const client = new ChatEdgeClient(loadConfig({}), {
      now: () => now,
      sleep: async milliseconds => { now += milliseconds }
    })

    await Promise.all([
      client.listMessageReactions('spaces/A/messages/M1'),
      client.listMessageReactions('spaces/A/messages/M2')
    ])

    expect(starts).toEqual([0, 67])
  })

  test('shares reaction-read quota reservations across client instances', async () => {
    let now = 0
    const starts: number[] = []
    const state = createMemoryState()
    await state.connect()
    globalThis.fetch = (async () => {
      starts.push(now)
      return Response.json({ reactions: [] })
    }) as unknown as typeof fetch
    const timing = {
      now: () => now,
      sleep: async (milliseconds: number) => { now += milliseconds },
      quotaState: state
    }

    try {
      await new ChatEdgeClient(loadConfig({}), timing)
        .listMessageReactions('spaces/A/messages/M1')
      await new ChatEdgeClient(loadConfig({}), timing)
        .listMessageReactions('spaces/A/messages/M2')
      expect(starts).toEqual([0, 67])
    } finally {
      await state.disconnect()
    }
  })

  test('uses message-qualified reaction and attachment resources', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      return Response.json(url.includes('/attachments/ATT.1')
        ? { name: 'spaces/A/messages/M.1/attachments/ATT.1' }
        : {})
    }) as typeof fetch
    const client = new ChatEdgeClient(loadConfig({}))

    await client.listMessageReactions('spaces/A/messages/M.1', { pageToken: 'next' })
    await client.getAttachment('spaces/A/messages/M.1', 'ATT.1')

    expect(calls[0]).toEndWith('/spaces/A/messages/M.1/reactions?pageToken=next')
    expect(calls[1]).toEndWith('/spaces/A/messages/M.1/attachments/ATT.1')
  })

  test('rejects HTML and size-mismatched uploaded attachment bodies', async () => {
    const client = new ChatEdgeClient(loadConfig({}))
    globalThis.fetch = (async () => new Response('<html>error</html>', {
      headers: { 'content-type': 'text/html' }
    })) as unknown as typeof fetch
    await expect(client.downloadAttachment('media/F1', 'application/pdf', 18)).rejects.toThrow(
      'MIME type mismatch'
    )

    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]).buffer, {
      headers: { 'content-type': 'application/pdf', 'content-length': '3' }
    })) as unknown as typeof fetch
    await expect(client.downloadAttachment('media/F1', 'application/pdf', 4)).rejects.toThrow(
      'size mismatch'
    )

    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]).buffer, {
      headers: { 'content-type': 'image/png', 'content-length': '3' }
    })) as unknown as typeof fetch
    await expect(client.downloadAttachment('media/F1', 'application/pdf', 3)).rejects.toThrow(
      'MIME type mismatch'
    )
  })

  test('retries transient Chat media download failures', async () => {
    let calls = 0
    let url = ''
    const opaqueResource = `${'A'.repeat(127)}=`
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      url = String(input)
      calls += 1
      if (calls === 1) {
        return new Response('retry', { status: 503, headers: { 'retry-after': '0' } })
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'application/octet-stream', 'content-length': '3' }
      })
    }) as unknown as typeof fetch

    const data = await new ChatEdgeClient(loadConfig({})).downloadAttachment(
      opaqueResource,
      'application/pdf',
      3
    )
    expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3]))
    expect(calls).toBe(2)
    expect(url).toEndWith(`/v1/media/${opaqueResource}?alt=media`)
  })

  test('rejects uploaded attachment resource path injection before fetch', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response()
    }) as unknown as typeof fetch
    const client = new ChatEdgeClient(loadConfig({}))

    for (const resource of ['opaque?alt=media', 'opaque#fragment', '../attachment']) {
      await expect(client.downloadAttachment(resource)).rejects.toThrow(
        'invalid Google Chat attachment resource ID'
      )
    }
    expect(calls).toBe(0)
  })

  test('uses only the reaction-read scope and subject for reaction reads', async () => {
    const pair = await generateRsaKeyPair()
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    let assertionPayload: Record<string, string> = {}
    let authorization = ''
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        assertionPayload = JSON.parse(
          Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()
        )
        return Response.json({ access_token: 'reaction-token', expires_in: 3600 })
      }
      authorization = String(new Headers(init?.headers).get('authorization'))
      return Response.json({ reactions: [] })
    }) as typeof fetch
    const client = new ChatEdgeClient(loadConfig({
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'bot@example.iam.gserviceaccount.com',
        private_key: Buffer.from(pkcs8).toString('base64')
      }),
      GOOGLECHATBOT_REACTION_READ_USER: 'reaction-reader@example.com'
    }))

    await client.listMessageReactions('spaces/A/messages/M1', { credential: 'reaction-reader' })

    expect(assertionPayload.scope).toBe(
      'https://www.googleapis.com/auth/chat.messages.reactions.readonly'
    )
    expect(assertionPayload.sub).toBe('reaction-reader@example.com')
    expect(authorization).toBe('Bearer reaction-token')
  })

  test('keeps live and ETL delegated read scopes separate without leaking tokens', async () => {
    const pair = await generateRsaKeyPair()
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    const assertionPayloads: Array<Record<string, string>> = []
    const authorizations: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        assertionPayloads.push(JSON.parse(
          Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()
        ))
        return Response.json({
          access_token: `reader-token-${assertionPayloads.length}`,
          expires_in: 3600
        })
      }
      authorizations.push(String(new Headers(init?.headers).get('authorization')))
      return Response.json({ messages: [] })
    }) as typeof fetch
    const client = new ChatEdgeClient(loadConfig({
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'bot@example.iam.gserviceaccount.com',
        private_key: [
          '-----BEGIN PRIVATE KEY-----',
          Buffer.from(pkcs8).toString('base64'),
          '-----END PRIVATE KEY-----'
        ].join('\n')
      })
    }))

    await client.listMessages('spaces/A', {
      credential: { kind: 'delegated-reader', subject: 'reader@example.com' }
    })
    await client.listSpaces({
      credential: { kind: 'delegated-etl-reader', subject: 'reader@example.com' }
    })

    expect(assertionPayloads.map(payload => payload.scope)).toEqual([
      'https://www.googleapis.com/auth/chat.messages.readonly',
      [
        'https://www.googleapis.com/auth/chat.messages.readonly',
        'https://www.googleapis.com/auth/chat.spaces.readonly',
        'https://www.googleapis.com/auth/chat.memberships.readonly',
        'https://www.googleapis.com/auth/chat.messages.reactions.readonly'
      ].join(' ')
    ])
    expect(assertionPayloads.map(payload => payload.sub)).toEqual([
      'reader@example.com',
      'reader@example.com'
    ])
    expect(authorizations).toEqual(['Bearer reader-token-1', 'Bearer reader-token-2'])
  })

  test('retries DM history as the requesting user when app auth is refused', async () => {
    const pair = await generateRsaKeyPair()
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    const assertionPayloads: Array<Record<string, string>> = []
    const authorizations: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
        assertionPayloads.push(JSON.parse(
          Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()
        ))
        return Response.json({
          access_token: assertionPayloads.length === 1 ? 'app-token' : 'requester-token',
          expires_in: 3600
        })
      }
      const authorization = String(new Headers(init?.headers).get('authorization'))
      authorizations.push(authorization)
      return authorization === 'Bearer app-token'
        ? Response.json({
            error: {
              message: 'DMs are not supported for methods requiring app authentication'
            }
          }, { status: 400 })
        : Response.json({ messages: [{ name: 'spaces/A/messages/M1', text: 'prior DM turn' }] })
    }) as typeof fetch
    const client = new ChatEdgeClient(loadConfig({
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'bot@example.iam.gserviceaccount.com',
        private_key: [
          '-----BEGIN PRIVATE KEY-----',
          Buffer.from(pkcs8).toString('base64'),
          '-----END PRIVATE KEY-----'
        ].join('\n')
      })
    }))

    const page = await client.listMessages('spaces/A', {
      impersonateSubject: 'requester@example.com'
    })

    expect(page.messages?.[0]?.text).toBe('prior DM turn')
    expect(assertionPayloads[1]).toMatchObject({
      sub: 'requester@example.com',
      scope: 'https://www.googleapis.com/auth/chat.messages.readonly'
    })
    expect(authorizations).toEqual(['Bearer app-token', 'Bearer requester-token'])
  })

  test('fails closed when DM delegation is absent', async () => {
    const client = new ChatEdgeClient(loadConfig({}))
    await expect(client.setupDm('person@example.com')).rejects.toBeInstanceOf(ChatConfigurationError)
  })

  test.each([
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [503, 'upstream']
  ] as const)('classifies %i without exposing its bearer', async (status, category) => {
    const pair = await generateRsaKeyPair()
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'secret-bearer', expires_in: 3600 })
      }
      return new Response('upstream echoed secret-bearer', {
        status,
        headers: { 'retry-after': '0' }
      })
    }) as typeof fetch
    const client = new ChatEdgeClient(loadConfig({
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'bot@example.iam.gserviceaccount.com',
        private_key: [
          '-----BEGIN PRIVATE KEY-----',
          Buffer.from(pkcs8).toString('base64'),
          '-----END PRIVATE KEY-----'
        ].join('\n')
      })
    }))

    const error = await client.listSpaces({ credential: 'app' }).catch(value => value)
    expect(error).toBeInstanceOf(ChatApiError)
    expect(error.category).toBe(category)
    expect(error.message).not.toContain('secret-bearer')
    expect(error.message).toContain('[redacted]')
  })

  test('accepts an empty successful response', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    expect(await new ChatEdgeClient(loadConfig({})).listSpaces()).toEqual({})
  })

  test('retries rate limits and transient upstream failures using Retry-After', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls < 3) {
        return new Response('retry', {
          status: calls === 1 ? 429 : 503,
          headers: { 'retry-after': '0' }
        })
      }
      return Response.json({ spaces: [{ name: 'spaces/A' }] })
    }) as unknown as typeof fetch

    expect(await new ChatEdgeClient(loadConfig({})).listSpaces()).toEqual({
      spaces: [{ name: 'spaces/A' }]
    })
    expect(calls).toBe(3)
  })

  test('uses at least a full quota window when a 429 omits Retry-After', () => {
    expect(retryBackoffMs(429, 0, () => 0)).toBe(1_000)
    expect(retryBackoffMs(429, 1, () => 0)).toBe(2_000)
  })

  test('retries a thrown transport failure', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) throw new TypeError('network reset')
      return Response.json({ spaces: [] })
    }) as unknown as typeof fetch
    expect(await new ChatEdgeClient(loadConfig({})).listSpaces()).toEqual({ spaces: [] })
    expect(calls).toBe(2)
  })

  test('rejects declared and chunked JSON responses over 16 MiB', async () => {
    globalThis.fetch = (async () => new Response('{}', {
      headers: { 'content-length': String(16 * 1024 * 1024 + 1) }
    })) as unknown as typeof fetch
    const client = new ChatEdgeClient(loadConfig({}))
    await expect(client.listSpaces()).rejects.toThrow('response exceeded the size limit')

    const chunk = new Uint8Array(1024 * 1024)
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        for (let index = 0; index < 17; index += 1) controller.enqueue(chunk)
        controller.close()
      }
    }))) as unknown as typeof fetch
    await expect(client.listSpaces()).rejects.toThrow('response exceeded the size limit')
  })

  test('bounds the OAuth token exchange response before DWD reads', async () => {
    const pair = await generateRsaKeyPair()
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    const chunk = new Uint8Array(1024 * 1024)
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        for (let index = 0; index < 17; index += 1) controller.enqueue(chunk)
        controller.close()
      }
    }))) as unknown as typeof fetch
    const client = new ChatEdgeClient(loadConfig({
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'bot@example.iam.gserviceaccount.com',
        private_key: [
          '-----BEGIN PRIVATE KEY-----',
          Buffer.from(pkcs8).toString('base64'),
          '-----END PRIVATE KEY-----'
        ].join('\n')
      })
    }))

    await expect(client.listSpaces({ credential: 'app' })).rejects.toThrow(
      'response exceeded the size limit'
    )
  })
})

describe('ChatEdgeClient delegated Drive downloads', () => {
  async function driveClient(fetchImpl: typeof fetch, configured = true): Promise<ChatEdgeClient> {
    const pair = await generateRsaKeyPair()
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    globalThis.fetch = fetchImpl
    return new ChatEdgeClient(loadConfig({
      ...(configured ? { GOOGLECHATBOT_DRIVE_DOWNLOAD_USER: 'drive-reader@example.com' } : {}),
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'bot@example.iam.gserviceaccount.com',
        private_key: [
          '-----BEGIN PRIVATE KEY-----',
          Buffer.from(pkcs8).toString('base64'),
          '-----END PRIVATE KEY-----'
        ].join('\n')
      })
    }))
  }

  function fakeDrive(
    metadata: Record<string, unknown>,
    data: Uint8Array = new TextEncoder().encode('hello'),
    mediaType = 'text/plain'
  ): { fetch: typeof fetch; assertions: Record<string, string>[] } {
    const assertions: Record<string, string>[] = []
    return {
      assertions,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('oauth2.googleapis.com/token')) {
          const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
          assertions.push(JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()))
          return Response.json({ access_token: 'drive-token', expires_in: 3600 })
        }
        if (url.includes('fields=')) return Response.json({ name: 'attachment', ...metadata })
        return new Response(data.buffer as ArrayBuffer, {
          headers: { 'content-type': mediaType, 'content-length': String(data.byteLength) }
        })
      }) as typeof fetch
    }
  }

  test('returns structured metadata-only reasons for missing grant and invalid IDs', async () => {
    let calls = 0
    const missing = await driveClient((async () => {
      calls++
      return Response.json({})
    }) as unknown as typeof fetch, false)
    expect(await missing.downloadDriveAttachment({
      driveFileId: 'valid_id', expectedMimeType: 'text/plain'
    })).toEqual({ unavailableReason: 'download_not_configured' })

    const configured = await driveClient((async () => {
      calls++
      return Response.json({})
    }) as unknown as typeof fetch)
    expect(await configured.downloadDriveAttachment({
      driveFileId: '../bad', expectedMimeType: 'text/plain'
    })).toEqual({ unavailableReason: 'invalid_resource' })
    expect(calls).toBe(0)
  })

  test('uses only drive.readonly for the dedicated subject and downloads a file', async () => {
    const fake = fakeDrive({
      id: 'drive-file-1', name: 'report.txt', mimeType: 'text/plain', size: '5',
      capabilities: { canDownload: true }
    })
    const client = await driveClient(fake.fetch)
    const result = await client.downloadDriveAttachment({
      driveFileId: 'drive-file-1', expectedMimeType: 'text/plain', declaredSize: 5
    })
    expect(Buffer.from(result.data ?? new ArrayBuffer(0)).toString()).toBe('hello')
    expect(result).toMatchObject({ mimeType: 'text/plain', size: 5 })
    expect(fake.assertions[0]?.scope).toBe('https://www.googleapis.com/auth/drive.readonly')
    expect(fake.assertions[0]?.sub).toBe('drive-reader@example.com')
  })

  test('exports Google-native files with the official MIME type and filename extension', async () => {
    const formats = [
      ['doc', 'application/vnd.google-apps.document', 'text/markdown', '.md'],
      [
        'sheet',
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.xlsx'
      ],
      [
        'slides',
        'application/vnd.google-apps.presentation',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.pptx'
      ],
      ['drawing', 'application/vnd.google-apps.drawing', 'application/pdf', '.pdf'],
      [
        'script',
        'application/vnd.google-apps.script',
        'application/vnd.google-apps.script+json',
        '.json'
      ]
    ] as const
    const urls: string[] = []
    const client = await driveClient((async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'drive-token', expires_in: 3600 })
      }
      if (url.includes('fields=')) {
        const id = url.match(/\/files\/([^?]+)/)?.[1] ?? ''
        const format = formats.find(candidate => candidate[0] === id)
        return Response.json({
          id,
          name: `Quarterly ${id}`,
          mimeType: format?.[1],
          capabilities: { canDownload: true }
        })
      }
      const format = formats.find(candidate => url.includes(`/files/${candidate[0]}/export?`))
      if (!format) throw new Error(`unexpected Drive URL: ${url}`)
      return new Response('exported', { headers: { 'content-type': format[2] } })
    }) as typeof fetch)

    for (const [id, sourceMimeType, exportMimeType, extension] of formats) {
      const result = await client.downloadAttachmentResource({
        contentName: `Quarterly ${id}`,
        contentType: sourceMimeType,
        source: 'DRIVE_FILE',
        driveDataRef: { driveFileId: id }
      })
      expect(Buffer.from(result.data).toString()).toBe('exported')
      expect(result.mimeType).toBe(exportMimeType)
      expect(result.name).toBe(`Quarterly ${id}${extension}`)
      expect(urls.some(url => url.includes(
        `/files/${id}/export?mimeType=${encodeURIComponent(exportMimeType)}`
      ))).toBe(true)
    }
    expect(urls.every(url => !url.includes('alt=media'))).toBe(true)
  })

  test('reports the files.export 10 MB ceiling distinctly', async () => {
    const metadata = {
      id: 'doc',
      name: 'Large doc',
      mimeType: 'application/vnd.google-apps.document',
      capabilities: { canDownload: true }
    }
    const atLimit = fakeDrive(
      metadata,
      new Uint8Array(MAX_DRIVE_EXPORT_BYTES),
      'text/markdown'
    )
    expect(await (await driveClient(atLimit.fetch)).downloadDriveAttachment({
      driveFileId: 'doc', expectedMimeType: 'application/vnd.google-apps.document'
    })).toMatchObject({ mimeType: 'text/markdown', size: MAX_DRIVE_EXPORT_BYTES })

    const declared = fakeDrive(
      metadata,
      new Uint8Array(0),
      'text/markdown'
    )
    const declaredFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await declared.fetch(input, init)
      if (String(input).includes('/export?')) {
        return new Response(null, {
          headers: {
            'content-type': 'text/markdown',
            'content-length': String(MAX_DRIVE_EXPORT_BYTES + 1)
          }
        })
      }
      return response
    }) as typeof fetch
    expect(await (await driveClient(declaredFetch)).downloadDriveAttachment({
      driveFileId: 'doc', expectedMimeType: 'application/vnd.google-apps.document'
    })).toMatchObject({ unavailableReason: 'export_too_large' })

    const chunked = await driveClient((async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'drive-token', expires_in: 3600 })
      }
      if (url.includes('fields=')) return Response.json(metadata)
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_DRIVE_EXPORT_BYTES))
          controller.enqueue(new Uint8Array(1))
          controller.close()
        }
      }), { headers: { 'content-type': 'text/markdown' } })
    }) as typeof fetch)
    expect(await chunked.downloadDriveAttachment({
      driveFileId: 'doc', expectedMimeType: 'application/vnd.google-apps.document'
    })).toMatchObject({
      unavailableReason: 'export_too_large',
      size: MAX_DRIVE_EXPORT_BYTES + 1
    })

    const apiFailure = await driveClient((async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'drive-token', expires_in: 3600 })
      }
      if (url.includes('fields=')) return Response.json(metadata)
      return Response.json({
        error: { errors: [{ reason: 'exportSizeLimitExceeded' }] }
      }, { status: 403 })
    }) as typeof fetch)
    expect(await apiFailure.downloadDriveAttachment({
      driveFileId: 'doc', expectedMimeType: 'application/vnd.google-apps.document'
    })).toMatchObject({ unavailableReason: 'export_too_large' })
  })

  test('does not send Google Vids through unsupported files.export', async () => {
    const urls: string[] = []
    const fake = fakeDrive({
      id: 'vid',
      name: 'Demo',
      mimeType: 'application/vnd.google-apps.vid',
      capabilities: { canDownload: true }
    })
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input))
      return fake.fetch(input, init)
    }) as typeof fetch
    expect(await (await driveClient(fetchImpl)).downloadDriveAttachment({
      driveFileId: 'vid', expectedMimeType: 'application/vnd.google-apps.vid'
    })).toMatchObject({ unavailableReason: 'unsupported_native_file' })
    expect(urls.every(url => !url.includes('/export?') && !url.includes('alt=media'))).toBe(true)
  })

  test('supports image bytes and the exact 100 MiB boundary', async () => {
    const data = new Uint8Array(100 * 1024 * 1024)
    const fake = fakeDrive({
      id: 'drive-image-1', name: 'image.png', mimeType: 'image/png',
      size: String(data.byteLength), capabilities: { canDownload: true }
    }, data, 'image/png')
    const result = await (await driveClient(fake.fetch)).downloadDriveAttachment({
      driveFileId: 'drive-image-1', expectedMimeType: 'image/png', declaredSize: data.byteLength
    })
    expect(result.size).toBe(100 * 1024 * 1024)
    expect(result.mimeType).toBe('image/png')
  }, 30_000)

  test('rejects declared, metadata, and actual content over 100 MiB', async () => {
    const client = await driveClient((async () => Response.json({})) as unknown as typeof fetch)
    expect(await client.downloadDriveAttachment({
      driveFileId: 'drive-file-1', expectedMimeType: 'text/plain', declaredSize: 100 * 1024 * 1024 + 1
    })).toEqual({ unavailableReason: 'declared_too_large' })

    const fake = fakeDrive({
      id: 'drive-file-1', mimeType: 'text/plain', size: String(100 * 1024 * 1024 + 1),
      capabilities: { canDownload: true }
    })
    expect(await (await driveClient(fake.fetch)).downloadDriveAttachment({
      driveFileId: 'drive-file-1', expectedMimeType: 'text/plain'
    })).toMatchObject({ unavailableReason: 'metadata_mismatch' })

    const chunk = new Uint8Array(1024 * 1024)
    let chunks = 0
    const streamed = await driveClient((async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'drive-token', expires_in: 3600 })
      }
      if (url.includes('fields=')) {
        return Response.json({
          id: 'drive-file-1', name: 'attachment', mimeType: 'text/plain',
          size: String(100 * 1024 * 1024),
          capabilities: { canDownload: true }
        })
      }
      return new Response(new ReadableStream({
        pull(controller) {
          if (chunks < 100) controller.enqueue(chunk)
          else if (chunks === 100) controller.enqueue(new Uint8Array(1))
          else controller.close()
          chunks += 1
        }
      }), { headers: { 'content-type': 'text/plain' } })
    }) as typeof fetch)
    expect(await streamed.downloadDriveAttachment({
      driveFileId: 'drive-file-1', expectedMimeType: 'text/plain'
    })).toMatchObject({
      unavailableReason: 'metadata_mismatch',
      size: 100 * 1024 * 1024 + 1
    })
  })

  test('rejects declared/actual size mismatch, MIME mismatch, and HTML bodies', async () => {
    for (const [metadata, data, mediaType] of [
      [
        { id: 'drive-file-1', mimeType: 'text/plain', size: '5', capabilities: { canDownload: true } },
        new TextEncoder().encode('four'), 'text/plain'
      ],
      [
        { id: 'drive-file-1', mimeType: 'image/png', size: '5', capabilities: { canDownload: true } },
        new TextEncoder().encode('hello'), 'image/jpeg'
      ],
      [
        { id: 'drive-file-1', mimeType: 'text/html', size: '5', capabilities: { canDownload: true } },
        new TextEncoder().encode('hello'), 'text/html'
      ]
    ] as const) {
      const fake = fakeDrive(metadata, data, mediaType)
      expect(await (await driveClient(fake.fetch)).downloadDriveAttachment({
        driveFileId: 'drive-file-1', expectedMimeType: String(metadata.mimeType)
      })).toMatchObject({ unavailableReason: 'metadata_mismatch' })
    }
  })

  test('rejects redirects to unapproved hosts', async () => {
    const client = await driveClient((async (input: RequestInfo | URL) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'drive-token', expires_in: 3600 })
      }
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } })
    }) as typeof fetch)
    await expect(client.downloadDriveAttachment({
      driveFileId: 'drive-file-1', expectedMimeType: 'text/plain'
    })).rejects.toThrow('unapproved redirect host')
  })

  test('surfaces 401, 403, and 429 without treating error bodies as files', async () => {
    for (const status of [401, 403, 429]) {
      const client = await driveClient((async (input: RequestInfo | URL) => {
        if (String(input).includes('oauth2.googleapis.com/token')) {
          return Response.json({ access_token: 'drive-token', expires_in: 3600 })
        }
        return new Response('<html>not a file</html>', {
          status,
          headers: { 'content-type': 'text/html', 'retry-after': '0' }
        })
      }) as typeof fetch)
      await expect(client.downloadDriveAttachment({
        driveFileId: 'drive-file-1', expectedMimeType: 'text/plain'
      })).rejects.toMatchObject({ status })
    }
  })
})
