// Independent functional-parity proof for googlechatbot. Drives the real Hono
// ingress with RS256-signed Google request tokens and dispatches every outbound
// fetch (Google Chat API, OAuth token exchange, api-rs session API) at the fetch
// boundary, so real client paths, bodies, and credential scopes are exercised.
// Endpoints are mocked: this is not a live Workspace proof.
//
//   GOOGLECHATBOT_TEST_DATABASE_URL=postgres://… bun scripts/verify-functional-parity.ts
//
// With the database URL unset, the dev-only in-memory state adapter is used
// when installed; the production image has no such dependency, so Postgres is
// mandatory there. State lives under a unique key prefix that is removed on
// completion. Output is sanitized counts and assertions only.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import type { StateAdapter } from 'chat'
import { loadConfig, type AppConfig } from '../src/config'
import { createGooglechatbot, type Googlechatbot } from '../src/index'
import { generateRsaKeyPair, signJwt } from '../src/chat/test-jwt'
import { renderMetrics } from '../src/metrics'
import { BUSY_STATUS, STEERING_STATUS, STOP_CARD_FUNCTION } from '../src/renderer'
import { stopControlKey, threadStateKey, type GoogleChatThreadState } from '../src/state'

const DATABASE_URL = process.env.GOOGLECHATBOT_TEST_DATABASE_URL
const KEY_PREFIX = `parity-proof-${randomUUID()}`
const SESSION_API = 'http://session-api.invalid'
const PROJECT_NUMBER = 'parity-local-project'
const ADDON_AUDIENCE = 'https://parity.invalid/api/chat/events'
const ADDON_SIGNER = 'parity-addon@fixture.iam.gserviceaccount.com'
const ADDON_OAUTH_CLIENT_ID = 'parity-fixture-client.apps.googleusercontent.com'
const REACTION_ACTOR = 'reaction-actor@fixture.example'
const REACTION_SCOPE = 'https://www.googleapis.com/auth/chat.messages.reactions'
const SIGNING_KID = 'parity-proof-key'
const BOT_USER = 'users/123456789'
// Spaces served by the Workspace Add-on runtime: Google would never deliver a
// click from a button that does not call back to the Add-on's own endpoint.
const ADDON_SPACES = new Set(['spaces/P6ADDONDM', 'spaces/P4ROOM'])
const DEADLINE_MS = 240_000
const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// fixture keys (generated per run, never persisted)
// ---------------------------------------------------------------------------

const signer = await generateRsaKeyPair()
const forger = await generateRsaKeyPair()
const serviceAccount = await generateRsaKeyPair()
const signerJwk = { ...(await crypto.subtle.exportKey('jwk', signer.publicKey)), kid: SIGNING_KID, alg: 'RS256', use: 'sig' }
const serviceAccountPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(
  await crypto.subtle.exportKey('pkcs8', serviceAccount.privateKey)
).toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`

async function googleToken(claims: Record<string, unknown>, key: CryptoKey = signer.privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({ privateKey: key, kid: SIGNING_KID, claims: { iat: now, exp: now + 300, ...claims } })
}
const projectToken = () => googleToken({ iss: 'chat@system.gserviceaccount.com', aud: PROJECT_NUMBER })
const addonSystemToken = () => googleToken({
  iss: 'https://accounts.google.com', aud: ADDON_AUDIENCE, email: ADDON_SIGNER, email_verified: true
})
const addonUserToken = (userId: string, email: string) => googleToken({
  iss: 'https://accounts.google.com', aud: ADDON_OAUTH_CLIENT_ID, sub: userId.replace(/^users\//, ''),
  email, email_verified: true
})

// ---------------------------------------------------------------------------
// mock world at the fetch boundary
// ---------------------------------------------------------------------------

type Gate = { arrived: Promise<void>; release: () => void }
type StoredMessage = { name: string; text?: string; cardsV2?: unknown[]; thread?: unknown }
type Patch = {
  name: string; updateMask: string | null; text?: string; stopCard: boolean
  bodyTextPresent: boolean; bodyCardCount: number; textPreserved: boolean
}
type Stream = { controller?: ReadableStreamDefaultController<Uint8Array>; open: boolean; closed: boolean }

const world = {
  calls: 0,
  grants: new Map<string, { scope: string; sub?: string }>(),
  messages: new Map<string, StoredMessage>(),
  patches: [] as Patch[],
  reactions: [] as Array<{ messageName: string; scope: string; sub?: string; emoji: string; name: string; deleted: boolean }>,
  reactionRefusals: new Set<string>(),
  creates: [] as string[],
  appends: [] as Array<{ threadKey: string; messageIds: string[]; forward: unknown }>,
  executions: [] as Array<{ threadKey: string; executionId: string; stopRequestedBefore: boolean }>,
  active: new Map<string, string>(),
  cancelled: new Set<string>(),
  streams: new Map<string, Stream>(),
  interrupts: [] as Array<{ threadKey: string; executionId?: string; streamOpen: boolean }>,
  gates: new Map<string, { resolve: () => void; released: Promise<void> }>(),
  stopIntentBeforeExecute: new Map<string, () => Promise<boolean>>()
}

function hold(kind: 'create' | 'execute', threadKey: string): Gate {
  let arrive!: () => void
  let release!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  world.gates.set(`${kind}:${threadKey}`, { resolve: arrive, released })
  return { arrived, release }
}

async function passGate(kind: 'create' | 'execute', threadKey: string): Promise<void> {
  const gate = world.gates.get(`${kind}:${threadKey}`)
  if (!gate) return
  world.gates.delete(`${kind}:${threadKey}`)
  gate.resolve()
  await gate.released
}

// Either callback shape: a Chat API app's bare function name, or an Add-on
// button whose function is the endpoint URL and whose actionName parameter
// carries the name.
function hasStopCard(cardsV2: unknown): boolean {
  const serialized = JSON.stringify(cardsV2 ?? [])
  return serialized.includes(`"function":"${STOP_CARD_FUNCTION}"`)
    || serialized.includes(`"value":"${STOP_CARD_FUNCTION}"`)
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function endStream(executionId: string, event: string, data: unknown): void {
  const stream = world.streams.get(executionId)
  if (!stream?.controller || stream.closed) return
  stream.controller.enqueue(encoder.encode(`event: ${event}\nid: 9\ndata: ${JSON.stringify(data)}\n\n`))
  stream.controller.close()
  stream.closed = true
  stream.open = false
}

async function tokenExchange(init: RequestInit | undefined): Promise<Response> {
  const assertion = new URLSearchParams(String(init?.body ?? '')).get('assertion') ?? ''
  const [header, payload, signature] = assertion.split('.')
  const valid = header && payload && signature
    && await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      serviceAccount.publicKey,
      Buffer.from(signature, 'base64url'),
      encoder.encode(`${header}.${payload}`)
    )
  if (!valid) return Response.json({ error: 'invalid_grant' }, { status: 401 })
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { scope: string; sub?: string }
  const token = `fixture-${createHash('sha256').update(`${claims.scope}|${claims.sub ?? ''}`).digest('hex').slice(0, 24)}`
  world.grants.set(token, { scope: claims.scope, sub: claims.sub })
  return Response.json({ access_token: token, expires_in: 3600 })
}

function grantFor(init: RequestInit | undefined): { scope: string; sub?: string } | undefined {
  const authorization = new Headers(init?.headers).get('authorization') ?? ''
  return world.grants.get(authorization.replace(/^Bearer\s+/i, ''))
}

async function chatApi(url: URL, method: string, init: RequestInit | undefined): Promise<Response> {
  const path = url.pathname.replace(/^\/v1\//, '')
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
  const grant = grantFor(init)
  if (!grant) return Response.json({ error: 'unauthenticated' }, { status: 401 })
  if (path.endsWith('/members/app')) return Response.json({ member: { name: BOT_USER, type: 'BOT' } })
  const reactionCreate = /^(spaces\/[^/]+\/messages\/[^/]+)\/reactions$/.exec(path)
  if (method === 'POST' && reactionCreate) {
    const messageName = reactionCreate[1]!
    if (world.reactionRefusals.has(messageName.split('/messages/')[0]!)) {
      return Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 })
    }
    const name = `${messageName}/reactions/R${world.reactions.length + 1}`
    world.reactions.push({
      messageName, scope: grant.scope, sub: grant.sub,
      emoji: String((body.emoji as { unicode?: string } | undefined)?.unicode ?? ''), name, deleted: false
    })
    return Response.json({ name, emoji: body.emoji })
  }
  if (method === 'DELETE' && /\/reactions\/R\d+$/.test(path)) {
    const reaction = world.reactions.find(entry => entry.name === path)
    if (!reaction) return Response.json({}, { status: 404 })
    if (grant.scope !== reaction.scope || grant.sub !== reaction.sub) return Response.json({}, { status: 403 })
    reaction.deleted = true
    return new Response(null, { status: 204 })
  }
  const spaceGet = /^spaces\/([^/]+)$/.exec(path)
  if (method === 'GET' && spaceGet) {
    const dm = spaceGet[1]!.endsWith('DM')
    return Response.json({
      name: `spaces/${spaceGet[1]}`, spaceType: dm ? 'DIRECT_MESSAGE' : 'SPACE',
      ...(dm ? { membershipCount: { joinedDirectHumanUserCount: 1 } } : {})
    })
  }
  if (method === 'GET' && /^spaces\/[^/]+\/messages$/.test(path)) return Response.json({ messages: [] })
  const create = /^spaces\/([^/]+)\/messages$/.exec(path)
  if ((method === 'POST' || method === 'PATCH') && ADDON_SPACES.has(`spaces/${path.split('/')[1]}`)) {
    const actions = JSON.stringify(body.cardsV2 ?? []).match(/"function":"([^"]*)"/g) ?? []
    if (actions.some(entry => entry !== `"function":"${ADDON_AUDIENCE}"`)) {
      return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Add-on card action must call back to the endpoint' } }, { status: 400 })
    }
  }
  if (method === 'POST' && create) {
    const id = url.searchParams.get('messageId') ?? `server-${world.messages.size + 1}`
    const name = `spaces/${create[1]}/messages/${id}`
    if (world.messages.has(name)) return Response.json({ error: 'exists' }, { status: 409 })
    const stored: StoredMessage = { name, text: body.text as string | undefined, cardsV2: body.cardsV2 as unknown[] | undefined, thread: body.thread }
    world.messages.set(name, stored)
    world.creates.push(name)
    return Response.json(stored)
  }
  const stored = world.messages.get(path)
  if (method === 'PATCH') {
    if (!stored) return Response.json({ error: 'not found' }, { status: 404 })
    const mask = url.searchParams.get('updateMask')
    const fields = (mask ?? '').split(',')
    // Observed live: Google answers 400 for a body it considers empty (no text
    // and no cards, e.g. `{cardsV2: []}` alone) even under a cards-only mask,
    // and applies ONLY the masked fields, leaving the message text untouched
    // when the mask excludes it.
    const bodyText = typeof body.text === 'string' ? body.text : ''
    const bodyCards = Array.isArray(body.cardsV2) ? body.cardsV2 : []
    if (!bodyText && bodyCards.length === 0) {
      return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Message body is empty' } }, { status: 400 })
    }
    const textBefore = stored.text
    if (fields.includes('text')) stored.text = body.text as string | undefined
    if (fields.includes('cardsV2')) stored.cardsV2 = body.cardsV2 as unknown[] | undefined
    world.patches.push({
      name: path, updateMask: mask, text: stored.text, stopCard: hasStopCard(body.cardsV2),
      bodyTextPresent: bodyText.length > 0, bodyCardCount: bodyCards.length, textPreserved: stored.text === textBefore
    })
    return Response.json(stored)
  }
  if (method === 'DELETE') {
    world.messages.delete(path)
    return new Response(null, { status: 204 })
  }
  throw new Error(`unmocked Chat API call: ${method} ${path}`)
}

async function sessionApi(url: URL, method: string, init: RequestInit | undefined): Promise<Response> {
  const match = /^\/api\/session\/([^/]+)(?:\/(messages|execute|events|interrupt))?$/.exec(url.pathname)
  if (!match) {
    if (url.pathname === '/api/workflows/events') return Response.json({})
    throw new Error(`unmocked session API call: ${method} ${url.pathname}`)
  }
  const threadKey = decodeURIComponent(match[1]!)
  const op = match[2]
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
  if (!op && method === 'POST') {
    await passGate('create', threadKey)
    return Response.json({ status: world.active.has(threadKey) ? 'executing' : 'idle', harness_type: 'codex' })
  }
  if (op === 'messages') {
    const messages = body.messages as Array<{ client_message_id?: string }>
    world.appends.push({ threadKey, messageIds: messages.map(message => message.client_message_id ?? ''), forward: body.forward_to_active_execution })
    return Response.json({ ok: true })
  }
  if (op === 'execute') {
    await passGate('execute', threadKey)
    const executionId = `exec-${world.executions.length + 1}`
    const probe = world.stopIntentBeforeExecute.get(threadKey)
    world.executions.push({ threadKey, executionId, stopRequestedBefore: probe ? await probe() : false })
    world.active.set(threadKey, executionId)
    return Response.json({ execution_id: executionId, status: 'queued' })
  }
  if (op === 'events') {
    const executionId = url.searchParams.get('execution_id') ?? ''
    const stream: Stream = { open: false, closed: false }
    world.streams.set(executionId, stream)
    return sseResponse(new ReadableStream<Uint8Array>({
      start(controller) {
        stream.controller = controller
        stream.open = true
        if (world.cancelled.has(executionId)) endStream(executionId, 'session.execution_cancelled', { error: 'Execution cancelled' })
      }
    }))
  }
  if (op === 'interrupt') {
    const executionId = world.active.get(threadKey)
    const stream = executionId ? world.streams.get(executionId) : undefined
    world.interrupts.push({ threadKey, executionId, streamOpen: Boolean(stream?.open && !stream.closed) })
    if (executionId) {
      world.cancelled.add(executionId)
      endStream(executionId, 'session.execution_cancelled', { error: 'Execution cancelled' })
      world.active.delete(threadKey)
    }
    return Response.json({ interrupted: Boolean(executionId) })
  }
  throw new Error(`unmocked session API call: ${method} ${url.pathname}`)
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = (init?.method ?? 'GET').toUpperCase()
  world.calls += 1
  if (url.pathname.includes('/service_accounts/v1/jwk/') || url.pathname === '/oauth2/v3/certs') {
    return Response.json({ keys: [signerJwk] }, { headers: { 'cache-control': 'max-age=3600' } })
  }
  if (url.hostname === 'oauth2.googleapis.com') return tokenExchange(init)
  if (url.hostname === 'chat.googleapis.com') return chatApi(url, method, init)
  if (url.origin === SESSION_API) return sessionApi(url, method, init)
  throw new Error(`proof refused outbound traffic to ${url.origin}`)
}) as typeof fetch

// ---------------------------------------------------------------------------
// runtime construction
// ---------------------------------------------------------------------------

const BASE_ENV: NodeJS.ProcessEnv = {
  CENTAUR_API_URL: SESSION_API,
  GOOGLECHATBOT_API_KEY: 'local-proof-only',
  GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'true',
  GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
  GOOGLECHATBOT_STATE_KEY_PREFIX: KEY_PREFIX,
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: 'parity-proof@fixture.iam.gserviceaccount.com', private_key: serviceAccountPem
  }),
  ...(DATABASE_URL ? { GOOGLECHATBOT_DATABASE_URL: DATABASE_URL } : {})
}
const runtimes: Googlechatbot[] = []

async function startRuntime(env: NodeJS.ProcessEnv): Promise<Googlechatbot> {
  const config: AppConfig = loadConfig({ ...BASE_ENV, ...env })
  let runtime: Googlechatbot
  if (DATABASE_URL) runtime = createGooglechatbot(config)
  else {
    const memory = await import('@chat-adapter/state-memory').catch(() => {
      throw new Error('GOOGLECHATBOT_TEST_DATABASE_URL is required: the in-memory state adapter is not installed')
    })
    runtime = createGooglechatbot(config, { state: memory.createMemoryState() })
  }
  await runtime.stateConnected
  runtimes.push(runtime)
  return runtime
}

// ---------------------------------------------------------------------------
// envelope helpers
// ---------------------------------------------------------------------------

type Sender = { id: string; name: string; email?: string }
const ADA: Sender = { id: 'users/1001', name: 'Ada', email: 'ada@fixture.example' }
const JOAN: Sender = { id: 'users/1002', name: 'Joan', email: 'joan@fixture.example' }

function threadKeyOf(space: string): string {
  return `chat:${space.replace('/', ':')}:${space.replace('/', ':')}:threads:T1`
}

function v1Message(space: string, id: string, text: string, opts: { sender?: Sender; mention?: boolean; threadReply?: boolean } = {}) {
  const dm = space.endsWith('DM')
  const sender = opts.sender ?? ADA
  return {
    type: 'MESSAGE', eventTime: new Date().toISOString(),
    space: { name: space, type: dm ? 'DIRECT_MESSAGE' : 'SPACE', ...(dm ? { singleUserBotDm: true } : {}) },
    message: {
      name: `${space}/messages/${id}`, text: opts.mention ? `<${BOT_USER}> ${text}` : text,
      sender: { name: sender.id, displayName: sender.name, type: 'HUMAN' },
      thread: { name: `${space}/threads/T1` }, threadReply: opts.threadReply ?? false,
      ...(opts.mention ? { annotations: [{ type: 'USER_MENTION', userMention: { user: { name: BOT_USER, type: 'BOT' }, type: 'MENTION' } }] } : {})
    },
    user: { name: sender.id, displayName: sender.name, type: 'HUMAN' }
  }
}

function v1CardClick(space: string, messageName: string, sender: Sender = ADA) {
  const dm = space.endsWith('DM')
  return {
    type: 'CARD_CLICKED', eventTime: new Date().toISOString(),
    space: { name: space, type: dm ? 'DIRECT_MESSAGE' : 'SPACE', ...(dm ? { singleUserBotDm: true } : {}) },
    message: { name: messageName, thread: { name: `${space}/threads/T1` } },
    user: { name: sender.id, displayName: sender.name, type: 'HUMAN' },
    common: { invokedFunction: STOP_CARD_FUNCTION }
  }
}

async function post(runtime: Googlechatbot, token: string, body: unknown): Promise<Response> {
  return runtime.app.request('/api/chat/events', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function accepted(response: Response, label: string): Promise<void> {
  assert.equal(response.status, 200, `${label}: webhook status`)
  assert.deepEqual(await response.json(), {}, `${label}: webhook acknowledgement body`)
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, milliseconds = 20_000): Promise<void> {
  const until = Date.now() + milliseconds
  while (!(await predicate())) {
    if (Date.now() >= until) throw new Error(`timed out waiting for: ${label}`)
    await Bun.sleep(10)
  }
}

function metric(name: string, labels: Record<string, string>): number {
  const key = `${name}{${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v}"`).join(',')}}`
  const line = renderMetrics().split('\n').find(entry => entry.startsWith(`${key} `))
  return line ? Number(line.slice(key.length + 1)) : 0
}

const executionsFor = (threadKey: string) => world.executions.filter(entry => entry.threadKey === threadKey)
const interruptsFor = (threadKey: string) => world.interrupts.filter(entry => entry.threadKey === threadKey)
const appendsFor = (threadKey: string) => world.appends.filter(entry => entry.threadKey === threadKey)
const ackOf = (space: string) => world.creates.find(name => name.startsWith(`${space}/messages/client-centaur-ack-`))
const ackCount = (space: string) => world.creates.filter(name => name.startsWith(`${space}/messages/client-centaur-ack-`)).length
const streamOpen = (executionId: string) => Boolean(world.streams.get(executionId)?.open) && !world.streams.get(executionId)?.closed
const threadState = (state: StateAdapter, threadKey: string) => state.get<GoogleChatThreadState>(threadStateKey(threadKey))

async function startTurn(runtime: Googlechatbot, space: string, id: string, text: string, opts: { sender?: Sender; mention?: boolean; threadReply?: boolean } = {}): Promise<string> {
  const threadKey = threadKeyOf(space)
  const before = executionsFor(threadKey).length
  await accepted(await post(runtime, await projectToken(), v1Message(space, id, text, opts)), `${space}/${id}`)
  await waitFor(() => executionsFor(threadKey).length === before + 1, `${space}: execution ${before + 1}`)
  const executionId = executionsFor(threadKey)[before]!.executionId
  await waitFor(() => streamOpen(executionId), `${space}: SSE stream open for ${executionId}`)
  return executionId
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

const report: Record<string, Record<string, unknown>> = {}
const failures: string[] = []

async function scenario(name: string, run: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    report[name] = { ok: true, ...(await run()) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${name}: ${message}`)
    report[name] = { ok: false, error: message }
  }
}

async function scenarioSignedStop(runtime: Googlechatbot): Promise<Record<string, unknown>> {
  const space = 'spaces/P1DM'
  const threadKey = threadKeyOf(space)
  const callsBefore = world.calls
  const forged = await post(runtime, await googleToken({ iss: 'chat@system.gserviceaccount.com', aud: PROJECT_NUMBER }, forger.privateKey), v1Message(space, 'FORGED', 'ignore me'))
  assert.equal(forged.status, 401, 'forged signature is rejected')
  const unsigned = await runtime.app.request('/api/chat/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v1Message(space, 'UNSIGNED', 'ignore me')) })
  assert.equal(unsigned.status, 401, 'unsigned request is rejected')
  assert.equal(world.calls - callsBefore, 1, 'rejected requests cause no outbound side effects beyond the cached JWK fetch')
  assert.equal(executionsFor(threadKey).length, 0, 'rejected requests start nothing')

  const executionId = await startTurn(runtime, space, 'START', 'Keep working until explicitly stopped')
  const ack = ackOf(space)
  assert.ok(ack && hasStopCard(world.messages.get(ack)?.cardsV2), 'acknowledgement carries the Stop card')
  const callsBeforeStop = world.calls
  await accepted(await post(runtime, await projectToken(), v1Message(space, 'STOP', 'stop')), 'signed stop')
  await waitFor(() => interruptsFor(threadKey).length === 1, 'signed stop reaches api-rs interrupt')
  const [interrupt] = interruptsFor(threadKey)
  assert.equal(interrupt!.executionId, executionId, 'interrupt targets the running execution')
  assert.equal(interrupt!.streamOpen, true, 'interrupt arrived while the original SSE stream was still open')
  await waitFor(() => world.patches.some(patch => patch.name === ack && !hasStopCard(world.messages.get(ack)?.cardsV2) && patch.updateMask?.includes('text')), 'cancelled final replaces the acknowledgement')
  await waitFor(() => world.creates.some(name => name.startsWith(`${space}/messages/`) && world.messages.get(name)?.text?.includes('Stopped')), 'stop confirmation posted')
  await Bun.sleep(300)
  assert.equal(executionsFor(threadKey).length, 1, 'Stop never creates another execution')
  assert.equal(hasStopCard(world.messages.get(ack!)?.cardsV2), false, 'final clears the Stop card')
  return {
    forgedSignatureStatus: forged.status, unsignedStatus: unsigned.status, executions: 1,
    interruptWhileStreamOpen: true, outboundCallsDuringStop: world.calls - callsBeforeStop
  }
}

async function scenarioStopDuringDelayedCreate(runtime: Googlechatbot): Promise<Record<string, unknown>> {
  const space = 'spaces/P2DM'
  const threadKey = threadKeyOf(space)
  const gate = hold('create', threadKey)
  await accepted(await post(runtime, await projectToken(), v1Message(space, 'START', 'Start something slow')), 'delayed create start')
  await gate.arrived
  await accepted(await post(runtime, await projectToken(), v1Message(space, 'STOP', 'stop')), 'stop during pending create')
  await waitFor(async () => Boolean((await threadState(runtime.state, threadKey))?.stopRequestedAt), 'stop intent durable while session create is still pending', 5_000)
    .catch(() => { throw new Error('FAIL: signed stop intent was not persisted while session creation was still pending') })
  assert.equal(executionsFor(threadKey).length, 0, 'nothing executed while create was pending')
  gate.release()
  const ack = ackOf(space)
  await waitFor(() => Boolean(ack && world.messages.get(ack)?.text?.includes('Stopped before the run started')), 'acknowledgement reports stopped-before-start')
  // The stop handler takes the thread handoff lock only after the stopped
  // turn releases it; on Postgres that is not instantaneous, so wait for it.
  await waitFor(() => interruptsFor(threadKey).length === 1, 'the stop still asks api-rs to interrupt once the handoff releases (nothing running)')
  await Bun.sleep(300)
  assert.equal(executionsFor(threadKey).length, 0, 'a turn stopped before execute must not start an execution')
  assert.equal(hasStopCard(world.messages.get(ack!)?.cardsV2), false, 'stopped acknowledgement has no Stop card')
  return { stopPersistedBeforeCreateReleased: true, executions: 0 }
}

async function scenarioStopDuringDelayedExecute(runtime: Googlechatbot): Promise<Record<string, unknown>> {
  const space = 'spaces/P2EXECDM'
  const threadKey = threadKeyOf(space)
  const gate = hold('execute', threadKey)
  world.stopIntentBeforeExecute.set(threadKey, async () => Boolean((await threadState(runtime.state, threadKey))?.stopRequestedAt))
  await accepted(await post(runtime, await projectToken(), v1Message(space, 'START', 'Start something slow')), 'delayed execute start')
  await gate.arrived
  await accepted(await post(runtime, await projectToken(), v1Message(space, 'STOP', 'stop')), 'stop during pending execute')
  await waitFor(async () => Boolean((await threadState(runtime.state, threadKey))?.stopRequestedAt), 'stop intent durable while execute is pending', 5_000)
  gate.release()
  await waitFor(() => interruptsFor(threadKey).length === 1, 'stop interrupts the execution that the delayed execute returned')
  const execution = executionsFor(threadKey)[0]!
  assert.equal(interruptsFor(threadKey)[0]!.executionId, execution.executionId, 'interrupt bound to that execution')
  assert.equal(execution.stopRequestedBefore, true, 'stop intent was durable before execute completed')
  const ack = ackOf(space)
  await waitFor(() => Boolean(ack && world.patches.some(patch => patch.name === ack && patch.updateMask?.includes('text') && !patch.stopCard)), 'cancelled turn finalizes the acknowledgement')
  await Bun.sleep(300)
  assert.equal(executionsFor(threadKey).length, 1, 'no second execution after the stop')
  return { stopPersistedBeforeExecuteReturned: true, executions: 1, interrupts: 1 }
}

async function scenarioStopCard(runtime: Googlechatbot): Promise<Record<string, unknown>> {
  const space = 'spaces/P3DM'
  const threadKey = threadKeyOf(space)
  const executionId = await startTurn(runtime, space, 'START', 'Work until the button is pressed')
  const ack = ackOf(space)!
  const cards = world.messages.get(ack)?.cardsV2 as Array<{ cardId?: string; card?: { sections?: Array<{ widgets?: Array<{ buttonList?: { buttons?: Array<{ text?: string; onClick?: { action?: { function?: string } } }> } }> }> } }> | undefined
  const button = cards?.[0]?.card?.sections?.[0]?.widgets?.[0]?.buttonList?.buttons?.[0]
  assert.equal(cards?.[0]?.cardId, 'centaur-stop', 'Stop card id')
  assert.equal(button?.onClick?.action?.function, STOP_CARD_FUNCTION, 'Stop button uses the Google onClick.action shape')
  assert.ok(await runtime.state.get(stopControlKey(ack)), 'Stop control binding is durable')

  const patchesBefore = world.patches.length
  world.streams.get(executionId)!.controller!.enqueue(encoder.encode('event: session.activity_summary\nid: 2\ndata: {"summary":"Reading files"}\n\n'))
  await waitFor(() => world.patches.slice(patchesBefore).some(patch => patch.name === ack && patch.text?.includes('Reading files')), 'status edit on the acknowledgement')
  const statusEdit = world.patches.slice(patchesBefore).find(patch => patch.name === ack && patch.text?.includes('Reading files'))!
  assert.equal(statusEdit.stopCard, true, 'status edit re-sends the Stop card')
  assert.equal(hasStopCard(world.messages.get(ack)?.cardsV2), true, 'Stop card survives the status edit')

  await accepted(await post(runtime, await projectToken(), v1CardClick(space, ack)), 'stop card click')
  await waitFor(() => interruptsFor(threadKey).length === 1, 'card click reaches interrupt')
  assert.equal(interruptsFor(threadKey)[0]!.executionId, executionId, 'card click interrupts its own execution')
  assert.equal(interruptsFor(threadKey)[0]!.streamOpen, true, 'card click interrupted while the stream was open')
  // The click never waits on a cosmetic Google edit: the interrupt above is
  // the cancellation, the binding is cleared, and the terminal render is what
  // removes the Stop control (no cards-only PATCH is required or asserted).
  await waitFor(async () => (await runtime.state.get(stopControlKey(ack))) === null, 'binding cleared')
  await waitFor(() => world.patches.some(patch => patch.name === ack && patch.updateMask?.includes('text') && !patch.stopCard), 'cancelled final rendered')
  const finalAck = world.messages.get(ack)
  assert.equal(hasStopCard(finalAck?.cardsV2), false, 'terminal output clears the Stop card')
  assert.ok(finalAck?.text?.includes('Execution cancelled'), 'cancelled final text is delivered on the acknowledgement')
  assert.equal(world.patches.filter(patch => patch.name === ack).every(patch => patch.bodyTextPresent || patch.bodyCardCount > 0), true, 'no acknowledgement edit sent a body Google would reject as empty')

  await Bun.sleep(50)
  const successor = await startTurn(runtime, space, 'START2', 'Second turn in the same thread')
  const staleBefore = metric('googlechatbot_stop_commands_total', { outcome: 'stale', source: 'card' })
  await accepted(await post(runtime, await projectToken(), v1CardClick(space, ack)), 'stale stop card click')
  await waitFor(() => metric('googlechatbot_stop_commands_total', { outcome: 'stale', source: 'card' }) === staleBefore + 1, 'stale click is recognized')
  assert.equal(interruptsFor(threadKey).length, 1, 'a stale Stop card cannot interrupt the successor')
  assert.equal(streamOpen(successor), true, 'successor stream still open')
  endStream(successor, 'session.execution_completed', { result: 'proof answer' })
  world.active.delete(threadKey)
  const successorAck = world.creates.filter(name => name.startsWith(`${space}/messages/client-centaur-ack-`))[1]!
  await waitFor(() => Boolean(world.messages.get(successorAck)?.text?.includes('proof answer')), 'successor final delivered')
  assert.equal(hasStopCard(world.messages.get(successorAck)?.cardsV2), false, 'successor final clears its Stop card')
  return { cardId: 'centaur-stop', actionFunction: STOP_CARD_FUNCTION, stopCardSurvivedStatusEdit: true, interrupts: 1, staleClicksIgnored: 1 }
}

async function scenarioAddonStopCard(runtime: Googlechatbot): Promise<Record<string, unknown>> {
  const space = 'spaces/P6ADDONDM'
  const threadKey = threadKeyOf(space)
  const v2Message = async (id: string, text: string) => ({
    authorizationEventObject: { userIdToken: await addonUserToken(ADA.id, ADA.email!) },
    commonEventObject: { hostApp: 'CHAT', platform: 'WEB' },
    chat: {
      eventTime: new Date().toISOString(),
      user: { name: ADA.id, displayName: ADA.name, type: 'HUMAN' },
      messagePayload: {
        space: { name: space, spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
        message: {
          name: `${space}/messages/${id}`, text, sender: { name: ADA.id, displayName: ADA.name, type: 'HUMAN' },
          thread: { name: `${space}/threads/T1` }, threadReply: true
        }
      }
    }
  })
  // The documented Add-on click: the endpoint URL is echoed as the invoked
  // function and the button's parameters ride commonEventObject.parameters.
  // The contextual message is the card the APP authored; the interacting
  // human is chat.user. The invoked function and parameters are taken from the
  // rendered button, never hand-written.
  const renderedAction = (messageName: string) => {
    const cards = world.messages.get(messageName)?.cardsV2 as Array<{ card?: { sections?: Array<{ widgets?: Array<{ buttonList?: { buttons?: Array<{ onClick?: { action?: { function?: string; parameters?: Array<{ key: string; value: string }> } } }> } }> }> } }> | undefined
    return cards?.[0]?.card?.sections?.[0]?.widgets?.[0]?.buttonList?.buttons?.[0]?.onClick?.action
  }
  const v2Click = async (
    messageName: string,
    parameters: Record<string, string> | 'rendered' | undefined,
    opts: { actor?: Sender | null; tokenFor?: Sender } = {}
  ) => {
    const action = renderedAction(messageName)
    const resolved = parameters === 'rendered'
      ? Object.fromEntries((action?.parameters ?? []).map(parameter => [parameter.key, parameter.value]))
      : parameters
    const tokenSender = opts.tokenFor ?? ADA
    const actor = opts.actor === undefined ? ADA : opts.actor
    return {
      authorizationEventObject: { userIdToken: await addonUserToken(tokenSender.id, tokenSender.email!) },
      commonEventObject: { hostApp: 'CHAT', platform: 'WEB', invokedFunction: action?.function ?? ADDON_AUDIENCE, ...(resolved ? { parameters: resolved } : {}) },
      chat: {
        eventTime: new Date().toISOString(),
        ...(actor ? { user: { name: actor.id, displayName: actor.name, type: 'HUMAN' } } : {}),
        buttonClickedPayload: {
          space: { name: space, spaceType: 'DIRECT_MESSAGE' },
          message: {
            name: messageName, thread: { name: `${space}/threads/T1` },
            sender: { name: BOT_USER, displayName: 'Centaur', type: 'BOT' },
            cardsV2: world.messages.get(messageName)?.cardsV2 ?? []
          }
        }
      }
    }
  }
  await accepted(await post(runtime, await addonSystemToken(), await v2Message('START', 'Work until the Add-on button is pressed')), 'add-on start')
  await waitFor(() => executionsFor(threadKey).length === 1, 'add-on execution')
  const executionId = executionsFor(threadKey)[0]!.executionId
  await waitFor(() => streamOpen(executionId), 'add-on stream open')
  const ack = ackOf(space)!
  const cards = world.messages.get(ack)?.cardsV2 as Array<{ cardId?: string; card?: { sections?: Array<{ widgets?: Array<{ buttonList?: { buttons?: Array<{ onClick?: { action?: { function?: string; parameters?: Array<{ key: string; value: string }> } } }> } }> }> } }> | undefined
  const action = cards?.[0]?.card?.sections?.[0]?.widgets?.[0]?.buttonList?.buttons?.[0]?.onClick?.action
  assert.equal(cards?.[0]?.cardId, 'centaur-stop', 'Add-on Stop card id')
  assert.equal(action?.function, ADDON_AUDIENCE, 'Add-on Stop button calls back to the exact configured https endpoint')
  assert.deepEqual(action?.parameters, [{ key: 'actionName', value: STOP_CARD_FUNCTION }], 'Add-on Stop button carries actionName')
  world.streams.get(executionId)!.controller!.enqueue(encoder.encode('event: session.activity_summary\nid: 2\ndata: {"summary":"Reading files"}\n\n'))
  await waitFor(() => world.patches.some(patch => patch.name === ack && patch.text?.includes('Reading files')), 'add-on status edit')
  assert.equal(hasStopCard(world.messages.get(ack)?.cardsV2), true, 'status edit keeps the Add-on Stop card')

  // A click that only echoes the endpoint, or that forges parameters, names no action.
  await accepted(await post(runtime, await addonSystemToken(), await v2Click(ack, undefined)), 'url-only click')
  await accepted(await post(runtime, await addonSystemToken(), await v2Click(ack, { work_id: 'forged', execution_id: executionId })), 'forged-parameter click')
  const unsigned = await runtime.app.request('/api/chat/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await v2Click(ack, 'rendered')) })
  assert.equal(unsigned.status, 401, 'unsigned Add-on click is rejected')
  const wrongHuman = await post(runtime, await addonSystemToken(), await v2Click(ack, 'rendered', { tokenFor: JOAN }))
  assert.equal(wrongHuman.status, 401, 'a verified token for another person than the interacting user is rejected')
  const noActor = await post(runtime, await addonSystemToken(), await v2Click(ack, 'rendered', { actor: null }))
  assert.equal(noActor.status, 401, 'a click naming no interacting human is rejected')
  await Bun.sleep(300)
  assert.equal(interruptsFor(threadKey).length, 0, 'malformed, unsigned, and mis-bound clicks never interrupt')
  assert.equal(streamOpen(executionId), true, 'stream still open after rejected clicks')
  assert.equal((await threadState(runtime.state, threadKey))?.stopRequestedAt, undefined, 'rejected clicks leave no stop intent')

  await accepted(await post(runtime, await addonSystemToken(), await v2Click(ack, 'rendered')), 'add-on stop click')
  await waitFor(() => interruptsFor(threadKey).length === 1, 'add-on click reaches interrupt')
  assert.equal(interruptsFor(threadKey)[0]!.executionId, executionId, 'add-on click interrupts its own execution')
  assert.equal(interruptsFor(threadKey)[0]!.streamOpen, true, 'add-on click interrupted while the stream was open')
  await waitFor(() => world.patches.some(patch => patch.name === ack && patch.updateMask?.includes('text') && !patch.stopCard), 'cancelled final rendered')
  assert.equal(hasStopCard(world.messages.get(ack)?.cardsV2), false, 'terminal output clears the Add-on Stop card')
  await Bun.sleep(300)
  assert.equal(executionsFor(threadKey).length, 1, 'no second execution')

  // Startup race through the Add-on shape: the click lands while session create is pending.
  const gate = hold('create', threadKey)
  await accepted(await post(runtime, await addonSystemToken(), await v2Message('START2', 'Slow second turn')), 'add-on delayed start')
  await gate.arrived
  const ack2 = world.creates.filter(name => name.startsWith(`${space}/messages/client-centaur-ack-`))[1]!
  await accepted(await post(runtime, await addonSystemToken(), await v2Click(ack2, 'rendered')), 'add-on click during pending create')
  await Bun.sleep(200)
  gate.release()
  await waitFor(() => Boolean(world.messages.get(ack2)?.text?.includes('Stopped before the run started')), 'add-on turn stopped before start')
  await Bun.sleep(300)
  assert.equal(executionsFor(threadKey).length, 1, 'the stopped Add-on turn never executed')
  assert.equal(hasStopCard(world.messages.get(ack2)?.cardsV2), false, 'stopped acknowledgement has no Stop card')
  return {
    callbackFunction: ADDON_AUDIENCE, actionName: STOP_CARD_FUNCTION, cardAuthor: 'BOT', actor: 'chat.user',
    interrupts: 1, executions: 1, malformedClicksIgnored: 2, unsignedStatus: 401, wrongHumanStatus: 401,
    missingActorStatus: 401, stoppedBeforeStart: true
  }
}

async function scenarioFollowUpIdentity(runtime: Googlechatbot): Promise<Record<string, unknown>> {
  const space = 'spaces/P4ROOM'
  const threadKey = threadKeyOf(space)
  const v2 = async (sender: Sender, id: string, text: string, threadReply = false) => ({
    authorizationEventObject: { userIdToken: await addonUserToken(sender.id, sender.email!) },
    commonEventObject: { hostApp: 'CHAT', platform: 'WEB' },
    chat: {
      eventTime: new Date().toISOString(),
      user: { name: sender.id, displayName: sender.name, type: 'HUMAN' },
      messagePayload: {
        space: { name: space, spaceType: 'SPACE' },
        message: {
          name: `${space}/messages/${id}`, text: `<${BOT_USER}> ${text}`,
          sender: { name: sender.id, displayName: sender.name, type: 'HUMAN' },
          thread: { name: `${space}/threads/T1` }, threadReply,
          annotations: [{ type: 'USER_MENTION', userMention: { user: { name: BOT_USER, type: 'BOT' }, type: 'MENTION' } }]
        }
      }
    }
  })
  await accepted(await post(runtime, await addonSystemToken(), await v2(ADA, 'START', 'Investigate the outage')), 'room start')
  await waitFor(() => executionsFor(threadKey).length === 1, 'room execution')
  const executionId = executionsFor(threadKey)[0]!.executionId
  await waitFor(() => streamOpen(executionId), 'room stream open')
  assert.equal((await threadState(runtime.state, threadKey))?.activeRequesterEmail, ADA.email, 'verified requester recorded on the running turn')

  await accepted(await post(runtime, await addonSystemToken(), await v2(ADA, 'FOLLOW', 'Also check the logs', true)), 'same requester follow-up')
  await waitFor(() => appendsFor(threadKey).some(append => append.messageIds.includes(`${space}/messages/FOLLOW`)), 'same-requester follow-up appended to the live execution')
  await waitFor(() => world.patches.some(patch => patch.text === STEERING_STATUS), 'steering notice shown')
  assert.equal(streamOpen(executionId), true, 'original SSE stream still open while the follow-up was appended')

  const appendsBefore = appendsFor(threadKey).length
  await accepted(await post(runtime, await addonSystemToken(), await v2(JOAN, 'OTHER', 'Do my task instead', true)), 'other sender follow-up')
  await waitFor(() => world.patches.some(patch => patch.text === BUSY_STATUS), 'other sender gets the busy notice')
  await Bun.sleep(300)
  assert.equal(appendsFor(threadKey).length, appendsBefore, 'another sender cannot steer the shared-space turn')
  assert.equal(executionsFor(threadKey).length, 1, 'no new execution for either follow-up')
  assert.equal((await threadState(runtime.state, threadKey))?.activeRequesterEmail, ADA.email, 'requester binding unchanged')
  endStream(executionId, 'session.execution_completed', { result: 'room answer' })
  world.active.delete(threadKey)
  await waitFor(async () => (await threadState(runtime.state, threadKey))?.activeExecution === false, 'room turn finished')
  return {
    identitySource: 'MOCKED: fixture-signed Add-on userIdToken verified against a mocked Google JWK set',
    sameRequesterAppended: true, otherSenderRefused: true, executions: 1
  }
}

async function scenarioReactions(withActor: Googlechatbot, withoutActor: Googlechatbot): Promise<Record<string, unknown>> {
  const startMessage = 'spaces/P1DM/messages/START'
  const created = world.reactions.filter(reaction => reaction.messageName === startMessage)
  assert.equal(created.length, 1, 'one reaction placed on the original message that started the turn')
  assert.equal(created[0]!.scope, REACTION_SCOPE, 'reaction used the read-write reactions scope')
  assert.equal(created[0]!.sub, REACTION_ACTOR, 'reaction authored by the configured delegated actor')
  assert.equal(created[0]!.emoji, '👀', 'default acknowledgement emoji')
  await waitFor(() => created[0]!.deleted, 'reaction removed after the stopped turn finished')
  const cardTurn = world.reactions.find(reaction => reaction.messageName === 'spaces/P3DM/messages/START')
  assert.ok(cardTurn, 'reaction placed for the Stop-card turn too')
  await waitFor(() => cardTurn!.deleted, 'reaction removed after the card-stopped turn')
  const scopesUsed = new Set([...world.grants.values()].filter(grant => grant.sub === REACTION_ACTOR).map(grant => grant.scope))
  assert.deepEqual([...scopesUsed], [REACTION_SCOPE], 'the delegated actor is only ever asked for the reactions scope')

  // Missing actor: the Add-on runtime has no GOOGLECHATBOT_REACTION_ACTOR_USER.
  const roomReactions = world.reactions.filter(reaction => reaction.messageName.startsWith('spaces/P4ROOM/'))
  assert.equal(roomReactions.length, 0, 'no reaction attempted without a configured actor')
  assert.equal(executionsFor(threadKeyOf('spaces/P4ROOM')).length, 1, 'turn still executed without an actor')
  void withoutActor

  // API refusal: Google returns 403 for this space; the turn must still run.
  const space = 'spaces/P5DM'
  const threadKey = threadKeyOf(space)
  world.reactionRefusals.add(space)
  const executionId = await startTurn(withActor, space, 'START', 'React to me if you can')
  assert.equal(world.reactions.filter(reaction => reaction.messageName.startsWith(`${space}/`)).length, 0, 'refused reaction stored nothing')
  endStream(executionId, 'session.execution_completed', { result: 'answer despite refusal' })
  world.active.delete(threadKey)
  await waitFor(() => Boolean(world.messages.get(ackOf(space)!)?.text?.includes('answer despite refusal')), 'turn answered despite the refused reaction')
  const grantsBefore = world.grants.size
  const second = await startTurn(withActor, space, 'START2', 'Second turn after the refusal')
  endStream(second, 'session.execution_completed', { result: 'second answer' })
  world.active.delete(threadKey)
  await waitFor(() => ackCount(space) === 2 && Boolean(world.messages.get(world.creates.filter(name => name.startsWith(`${space}/messages/client-centaur-ack-`))[1]!)?.text?.includes('second answer')), 'second turn answered')
  assert.equal(world.grants.size, grantsBefore, 'after a 403 the process stops asking for the reaction credential')
  return {
    actorScope: REACTION_SCOPE, reactionsCreated: world.reactions.length,
    reactionsDeleted: world.reactions.filter(reaction => reaction.deleted).length,
    refusedReactionFailedTurn: false, missingActorFailedTurn: false
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const deadline = setTimeout(() => {
  console.error(JSON.stringify({ result: 'FAIL', error: 'proof deadline expired', report, failures }))
  process.exit(2)
}, DEADLINE_MS)

async function cleanup(): Promise<void> {
  for (const [, stream] of world.streams) {
    if (stream.controller && !stream.closed) {
      stream.controller.enqueue(encoder.encode('event: session.execution_completed\nid: 99\ndata: {"result":"proof cleanup"}\n\n'))
      stream.controller.close()
      stream.closed = true
    }
  }
  await Bun.sleep(1_500)
  for (const runtime of runtimes) await runtime.shutdown(5_000).catch(() => undefined)
  // The bot hands the SDK adapter a pool it owns, so adapter.disconnect() does
  // not end it; end every distinct runtime pool ourselves or the process never exits.
  const pools = new Set<pg.Pool>()
  for (const runtime of runtimes) {
    const pool = (runtime.state as { getClient?: () => pg.Pool }).getClient?.()
    if (pool) pools.add(pool)
    await runtime.state.disconnect().catch(() => undefined)
  }
  for (const pool of pools) {
    if (!(pool as { ended?: boolean }).ended) await pool.end().catch(() => undefined)
  }
  globalThis.fetch = realFetch
  if (!DATABASE_URL) return
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    for (const table of ['chat_state_cache', 'chat_state_locks', 'chat_state_subscriptions']) {
      await client.query(`DELETE FROM ${table} WHERE key_prefix = $1`, [KEY_PREFIX])
        .catch((error: Error) => { if (!/does not exist/.test(error.message)) throw error })
    }
  } finally {
    await client.end()
  }
}

try {
  const projectRuntime = await startRuntime({
    GOOGLECHATBOT_INGRESS_MODE: 'chat_api_project',
    GOOGLECHATBOT_PROJECT_NUMBER: PROJECT_NUMBER,
    GOOGLECHATBOT_REACTION_ACTOR_USER: REACTION_ACTOR
  })
  const addonRuntime = await startRuntime({
    GOOGLECHATBOT_INGRESS_MODE: 'workspace_addon',
    GOOGLECHATBOT_WEBHOOK_AUDIENCE: ADDON_AUDIENCE,
    GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL: ADDON_SIGNER,
    GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID: ADDON_OAUTH_CLIENT_ID
  })
  await scenario('1_signed_ingress_stop_while_stream_open', () => scenarioSignedStop(projectRuntime))
  await scenario('2a_stop_during_delayed_session_create', () => scenarioStopDuringDelayedCreate(projectRuntime))
  await scenario('2b_stop_during_delayed_execute', () => scenarioStopDuringDelayedExecute(projectRuntime))
  await scenario('3_stop_card_lifecycle', () => scenarioStopCard(projectRuntime))
  await scenario('4_follow_up_requester_identity', () => scenarioFollowUpIdentity(addonRuntime))
  await scenario('5_delegated_reactions', () => scenarioReactions(projectRuntime, addonRuntime))
  await scenario('6_addon_stop_card_callback', () => scenarioAddonStopCard(addonRuntime))
} finally {
  await cleanup()
  clearTimeout(deadline)
}

console.log(JSON.stringify({
  result: failures.length ? 'FAIL' : 'PASS',
  state: DATABASE_URL ? 'postgres' : 'memory',
  keyPrefix: KEY_PREFIX,
  platformEndpoints: 'mocked',
  liveWorkspace: false,
  scenarios: report,
  failures
}, null, 2))
if (failures.length) process.exit(1)
