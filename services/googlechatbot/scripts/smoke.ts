import assert from 'node:assert/strict'
import { createMemoryState } from '@chat-adapter/state-memory'
import { loadConfig } from '../src/config'
import { createGooglechatbot } from '../src/index'
import { generateRsaKeyPair, signJwt } from '../src/chat/test-jwt'
import {
  WORK_INDEX_KEY,
  persistWork,
  workKey,
  type GoogleChatWorkObligation
} from '../src/state'

type FixtureCase = {
  name: string
  expect: 'session' | 'attachment-session' | 'interrupt' | 'workflow' | 'denied'
  eventName?: string
  repeat?: number
  status?: number
  userEmail?: string
  body: Record<string, unknown>
}

type FixtureFile = {
  family: 'legacy' | 'workspace-addons'
  authentication: {
    algorithm: 'RS256'
    issuer: string
    audience: string
    email?: string
    email_verified?: boolean
  }
  cases: FixtureCase[]
}

type FetchCall = { url: string; method: string; body: unknown }

const AUDIENCE = 'fixture-project'
const ADDON_USER_AUDIENCE = 'fixture-addon-client.apps.googleusercontent.com'
const INTERNAL_KEY = 'fixture-internal-key'
const FIXTURE_BYTES = new TextEncoder().encode('fixture-file')

const BASE_ENV = {
  CHAT_EVENTS_PATH: '/api/chat/events',
  GOOGLECHATBOT_ALLOWED_DOMAIN: '',
  GOOGLECHATBOT_FOLLOW_UP_THREADS: 'true',
  GOOGLECHATBOT_INTERNAL_API_KEY: INTERNAL_KEY,
  GOOGLECHATBOT_UPLOAD_USER: 'fixture@example.com',
  GOOGLECHATBOT_REACTION_READ_USER: 'fixture@example.com',
  GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: 'fixture@example.iam.gserviceaccount.com',
    private_key: 'fixture-only-key'
  })
}
const config = loadConfig({ ...BASE_ENV, GOOGLECHATBOT_PROJECT_NUMBER: AUDIENCE })

function jsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return undefined
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function installMockFetch(jwk: JsonWebKey & { kid: string }): {
  calls: FetchCall[]
  restore: () => void
} {
  const realFetch = globalThis.fetch
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: jsonBody(init?.body) })

    if (url.includes('/service_accounts/v1/jwk/') || url.includes('/oauth2/v3/certs')) {
      return Response.json({ keys: [jwk] }, {
        headers: { 'cache-control': 'max-age=3600' }
      })
    }
    if (url.endsWith('/interrupt')) return Response.json({ interrupted: true })
    if (url.endsWith('/execute')) {
      return Response.json({
        ok: true,
        execution_id: `exec-${calls.length}`,
        thread_key: 'fixture-thread',
        status: 'queued'
      })
    }
    if (url.includes('/events?')) {
      return new Response('event: session.execution_completed\ndata: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    }
    if (url.endsWith('/api/workflows/events')) return Response.json({})
    if (method === 'POST' && /\/api\/session\/[^/]+$/.test(url)) {
      return Response.json({ status: 'idle' })
    }
    return Response.json({ messages: [] })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = realFetch } }
}

function count(calls: FetchCall[], expected: FixtureCase['expect']): number {
  if (expected === 'workflow') return calls.filter(call => call.url.endsWith('/api/workflows/events')).length
  if (expected === 'interrupt') return calls.filter(call => call.url.endsWith('/interrupt')).length
  if (expected === 'denied') {
    return calls.filter(call => /\/api\/(session|workflows)\//.test(call.url)).length
  }
  return calls.filter(call => call.method === 'POST' && /\/api\/session\/[^/]+$/.test(call.url)).length
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('smoke condition timed out')
    await Bun.sleep(5)
  }
}

async function waitForAcceptedWork(runtime: ReturnType<typeof createGooglechatbot>): Promise<void> {
  await waitFor(async () => {
    const ids = await runtime.state.getList<string>(WORK_INDEX_KEY)
    return (await Promise.all(ids.map(id => runtime.state.get(workKey(id))))).every(work => !work)
  }, 5_000)
}

async function loadFixtures(name: string): Promise<FixtureFile> {
  const fixture = await Bun.file(new URL(`../testdata/${name}`, import.meta.url)).json() as FixtureFile
  assert.ok(fixture.cases.length > 0, `${name} has cases`)
  return fixture
}

async function signedToken(privateKey: CryptoKey, fixture: FixtureFile): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    privateKey,
    kid: 'fixture-key',
    claims: {
      iss: fixture.authentication.issuer,
      aud: fixture.authentication.audience,
      iat: now,
      exp: now + 300,
      ...(fixture.authentication.email
        ? {
            email: fixture.authentication.email,
            email_verified: fixture.authentication.email_verified
          }
        : {})
    }
  })
}

async function signedUserToken(
  privateKey: CryptoKey,
  userId: string,
  email: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    privateKey,
    kid: 'fixture-key',
    claims: {
      iss: 'https://accounts.google.com',
      aud: ADDON_USER_AUDIENCE,
      sub: userId.replace(/^users\//, ''),
      email,
      email_verified: true,
      iat: now,
      exp: now + 300
    }
  })
}

async function runWebhookFixtures(
  privateKey: CryptoKey,
  calls: FetchCall[]
): Promise<ReturnType<typeof createGooglechatbot>> {
  let primaryRuntime: ReturnType<typeof createGooglechatbot> | undefined
  for (const fileName of ['legacy-webhooks.json', 'workspace-addons-webhooks.json']) {
    const fixture = await loadFixtures(fileName)
    const fixtureConfig = loadConfig({
      ...BASE_ENV,
      GOOGLECHATBOT_INGRESS_MODE:
        fixture.family === 'legacy' ? 'chat_api_project' : 'workspace_addon',
      ...(fixture.family === 'legacy'
        ? { GOOGLECHATBOT_PROJECT_NUMBER: fixture.authentication.audience }
        : {
            GOOGLECHATBOT_WEBHOOK_AUDIENCE: fixture.authentication.audience,
            GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL: fixture.authentication.email ?? '',
            GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID: ADDON_USER_AUDIENCE,
            GOOGLECHATBOT_ALLOWED_DOMAIN: 'example.com'
          })
    })
    const state = createMemoryState()
    const runtime = createGooglechatbot(fixtureConfig, { state })
    if (!primaryRuntime) primaryRuntime = runtime
  runtime.client.getBotUserName = async () => 'users/123456789'
  runtime.client.getSpace = async spaceName => ({
    name: spaceName,
    spaceType: spaceName.includes('/DM') || spaceName.includes('/STOP') || spaceName.includes('/DUPLICATE')
      || spaceName.includes('/ADDONS') ? 'DIRECT_MESSAGE' : 'SPACE',
    membershipCount: { joinedDirectHumanUserCount: 1 }
  })
  runtime.client.createMessage = async spaceName => ({ name: `${spaceName}/messages/fixture-ack` })
  runtime.client.updateMessage = async () => ({})
  runtime.client.deleteMessage = async () => ({})
  runtime.client.deleteOwnedMessage = async () => ({})
  runtime.client.listMessages = async () => ({ messages: [] })
  runtime.client.downloadAttachment = async () => FIXTURE_BYTES.buffer
  await runtime.stateConnected

  const unsigned = await runtime.app.request('/api/chat/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'REMOVED_FROM_SPACE', space: { name: 'spaces/UNSIGNED', type: 'SPACE' } })
  })
  assert.equal(unsigned.status, 401, 'signed requests are mandatory in smoke fixtures')

    assert.equal(
      fixture.family,
      fileName.startsWith('legacy') ? 'legacy' : 'workspace-addons',
      `${fileName} declares its wire family`
    )
    assert.equal(fixture.authentication.algorithm, 'RS256')
    const token = await signedToken(privateKey, fixture)
    for (const fixtureCase of fixture.cases) {
      const before = count(calls, fixtureCase.expect)
      const body = structuredClone(fixtureCase.body)
      const now = new Date().toISOString()
      if (fixture.family === 'workspace-addons') {
        (body.chat as Record<string, unknown>).eventTime = now
        const user = (body.chat as { user?: { name?: string } }).user
        body.authorizationEventObject = {
          userIdToken: await signedUserToken(
            privateKey,
            user?.name ?? '',
            fixtureCase.userEmail ?? 'fixture@example.com'
          )
        }
      } else {
        body.eventTime = now
      }
      for (let delivery = 0; delivery < (fixtureCase.repeat ?? 1); delivery += 1) {
        const response = await runtime.app.request('/api/chat/events', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(body)
        })
        assert.equal(response.status, fixtureCase.status ?? 200, fixtureCase.name)
        assert.deepEqual(await response.json(), {}, `${fixtureCase.name} acknowledgement`)
      }
      if (fixtureCase.expect === 'denied') {
        assert.equal(count(calls, fixtureCase.expect), before, `${fixtureCase.name} made no control-plane call`)
        continue
      }
      await waitFor(() => count(calls, fixtureCase.expect) === before + 1)
      await Bun.sleep(20)
      assert.equal(count(calls, fixtureCase.expect), before + 1, `${fixtureCase.name} dispatched once`)
      if (fixtureCase.eventName) {
        const dispatch = calls.filter(call => call.url.endsWith('/api/workflows/events')).at(-1)
        assert.equal(
          (dispatch?.body as { event_name?: string } | undefined)?.event_name,
          fixtureCase.eventName,
          `${fixtureCase.name} event name`
        )
      }
    }
    await waitForAcceptedWork(runtime)
    if (runtime !== primaryRuntime) await runtime.state.disconnect()
  }

  const attachmentExecute = calls.find(call =>
    call.url.endsWith('/execute')
    && JSON.stringify(call.body).includes('fixture.txt')
    && JSON.stringify(call.body).includes('dataBase64')
  )
  assert.ok(attachmentExecute, 'follow-up attachment reaches the staged session input')
  assert.ok(primaryRuntime)
  return primaryRuntime
}

async function runRestartRenderSmoke(): Promise<void> {
  const state = createMemoryState()
  await state.connect()
  const work: GoogleChatWorkObligation = {
    acceptedAt: new Date().toISOString(),
    ackMessageName: 'spaces/RESTART/messages/ACK',
    canonicalFinal: { answer: 'fixture recovered answer' },
    dedupeKey: 'fixture-restart',
    event: {
      thread_key: 'fixture-restart-thread',
      message_id: 'spaces/RESTART/messages/M1',
      space_name: 'spaces/RESTART',
      space_type: 'SPACE',
      user_id: 'users/U1',
      user_name: 'Fixture User',
      is_mention: true,
      parts: [{ type: 'text', text: 'recover' }],
      chat: { thread_name: 'spaces/RESTART/threads/T1' }
    },
    executionId: 'fixture-execution',
    failures: 0,
    identityVerified: true,
    lastEventId: 1,
    stage: 'rendering',
    workId: crypto.randomUUID()
  }
  await persistWork(state, work)
  await state.disconnect()

  const connect = state.connect.bind(state)
  let resume!: () => void
  state.connect = async () => {
    await new Promise<void>(resolve => { resume = resolve })
    await connect()
  }
  const restarted = createGooglechatbot(config, { state })
  let updates = 0
  restarted.client.updateMessage = async () => {
    updates += 1
    return {}
  }
  restarted.client.createMessage = async () => {
    throw new Error('restart smoke must update the durable acknowledgement')
  }
  resume()
  await restarted.stateConnected
  await waitFor(async () => (await state.get(workKey(work.workId))) === null)
  assert.equal(updates, 1, 'restart recovers one canonical final render')
  await state.disconnect()
}

async function runInternalRouteSmoke(runtime: ReturnType<typeof createGooglechatbot>): Promise<void> {
  const mutations: string[] = []
  runtime.client.createMessage = async spaceName => {
    mutations.push(`send:${spaceName}`)
    return { name: `${spaceName}/messages/SENT` }
  }
  runtime.client.updateOwnedMessage = async (_spaceName, messageName) => {
    mutations.push(`update:${messageName}`)
    return { name: messageName }
  }
  runtime.client.deleteOwnedMessage = async (_spaceName, messageName) => {
    mutations.push(`delete:${messageName}`)
    return {}
  }
  runtime.client.canSetupDm = () => true
  runtime.client.setupDm = async target => {
    mutations.push(`dm:${target}`)
    return { name: 'spaces/DM-SETUP' }
  }
  runtime.client.canReadReactions = () => true
  runtime.client.listMessageReactions = async messageName => {
    mutations.push(`reactions:${messageName}`)
    return { reactions: [{ name: `${messageName}/reactions/R1` }] }
  }
  runtime.client.canUploadAttachments = () => true
  runtime.client.uploadAttachment = async (spaceName, filename) => {
    mutations.push(`upload:${spaceName}:${filename}`)
    return { attachmentDataRef: { resourceName: 'media/uploaded' } }
  }
  runtime.client.createAttachmentMessage = async spaceName => ({ name: `${spaceName}/messages/FILE` })
  runtime.client.resolveAttachment = async (messageName, attachmentId) => ({
    attachment: {
      name: `${messageName}/attachments/${attachmentId}`,
      contentName: 'download.txt',
      contentType: 'text/plain',
      size: '10',
      source: 'UPLOADED_CONTENT',
      attachmentDataRef: { resourceName: 'media/download' }
    },
    credential: 'app'
  })
  runtime.client.downloadAttachmentResource = async () => {
    mutations.push('download')
    const data = new TextEncoder().encode('downloaded')
    return { data: data.buffer, mimeType: 'text/plain', name: 'download.txt', size: data.byteLength }
  }

  const auth = { authorization: `Bearer ${INTERNAL_KEY}`, 'content-type': 'application/json' }
  assert.equal((await runtime.app.request('/api/chat/spaces/S/messages', {
    method: 'POST', headers: auth, body: JSON.stringify({ text: 'send' })
  })).status, 200)
  assert.equal((await runtime.app.request('/api/chat/spaces/S/messages/M1', {
    method: 'PATCH', headers: auth, body: JSON.stringify({ text: 'update' })
  })).status, 200)
  assert.equal((await runtime.app.request('/api/chat/spaces/S/messages/M1', {
    method: 'DELETE', headers: auth
  })).status, 200)
  assert.equal((await runtime.app.request('/api/chat/dms/setup?target_identity=fixture%40example.com', {
    method: 'POST', headers: auth, body: '{}'
  })).status, 200)
  assert.equal((await runtime.app.request('/api/chat/spaces/S/messages/M1/reactions', {
    headers: auth
  })).status, 200)
  assert.equal((await runtime.app.request('/api/chat/spaces/S/attachments', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ filename: 'upload.txt', content_base64: 'dXBsb2FkZWQ=' })
  })).status, 200)
  const download = await runtime.app.request(
    '/api/chat/spaces/S/messages/M1/attachments/A1/download',
    { headers: auth }
  )
  assert.equal(download.status, 200)
  assert.equal(await download.text(), 'downloaded')

  const beforeDenial = mutations.length
  const denied = await runtime.app.request('/api/chat/spaces/S/messages', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'must not send' })
  })
  assert.equal(denied.status, 401)
  assert.equal(mutations.length, beforeDenial, 'permission denial makes no upstream mutation')
  assert.deepEqual(mutations, [
    'send:spaces/S',
    'update:spaces/S/messages/M1',
    'delete:spaces/S/messages/M1',
    'dm:fixture@example.com',
    'reactions:spaces/S/messages/M1',
    'upload:spaces/S:upload.txt',
    'download'
  ])
}

async function main(): Promise<void> {
  const pair = await generateRsaKeyPair()
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const mock = installMockFetch({ ...publicJwk, kid: 'fixture-key', alg: 'RS256', use: 'sig' })
  try {
    const runtime = await runWebhookFixtures(pair.privateKey, mock.calls)
    await runRestartRenderSmoke()
    await runInternalRouteSmoke(runtime)
    await runtime.state.disconnect()
    console.log('googlechatbot fixture smoke: all cases passed')
  } finally {
    mock.restore()
  }
}

await main()
