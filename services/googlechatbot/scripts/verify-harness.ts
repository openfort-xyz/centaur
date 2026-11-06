// Bun preload for the verify-googlechatbot skill:
//   bun --preload ./scripts/verify-harness.ts src/server.ts
// The real server runs unchanged in workspace_addon ingress mode (the mode the
// deployment uses). Every outbound fetch it makes (Google APIs, api-rs, OpenAI)
// lands on the test-session-mock fakes plus the few Google endpoints added
// below; nothing reaches the network. A control API on
// 127.0.0.1:$VERIFY_CONTROL_PORT signs Chat events, posts them to the bot's real
// webhook, finishes executions, and reports what the bot wrote to "Google Chat".
import { STOP_CARD_FUNCTION } from '../src/constants'
import { generateRsaKeyPair, signJwt } from '../src/chat/test-jwt'
import { installSessionMock } from '../src/test-session-mock'

const BOT_USER = 'users/123456789'
const DEFAULT_USER = 'users/1001'
const KID = 'verify-harness'

const controlPort = Number(process.env.VERIFY_CONTROL_PORT)
const botPort = Number(process.env.PORT)
const audience = process.env.GOOGLECHATBOT_WEBHOOK_AUDIENCE
const signer = process.env.GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL
if (!controlPort || !botPort || !audience || !signer) {
  throw new Error(
    'verify-harness needs VERIFY_CONTROL_PORT, PORT, GOOGLECHATBOT_WEBHOOK_AUDIENCE and '
    + 'GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL'
  )
}

const realFetch = globalThis.fetch
const mock = installSessionMock()
const mockFetch = globalThis.fetch
const keys = await generateRsaKeyPair()
const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
const jwk = { ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }
const decision = { respond: false }

const json = (value: unknown, status = 200) => Response.json(value, { status })

/** Directory email for a numeric Chat user id: users/1001 -> user1001@example.test. */
const emailOf = (userId: string) => `user${userId}@example.test`

function fakeGoogle(url: URL, method: string): Response | undefined {
  const host = url.hostname
  const path = url.pathname
  const jwks = path === '/oauth2/v3/certs' || path.startsWith('/service_accounts/v1/jwk/')
  if (host === 'www.googleapis.com' && jwks) return json({ keys: [jwk] })
  if (host === 'oauth2.googleapis.com' && path === '/token') {
    return json({ access_token: 'verify-harness-token', expires_in: 3600, token_type: 'Bearer' })
  }
  if (host === 'admin.googleapis.com' && path.startsWith('/admin/directory/v1/users/')) {
    return json({ primaryEmail: emailOf(path.split('/').at(-1) ?? '') })
  }
  if (host === 'chat.googleapis.com' && method === 'GET' && /^\/v1\/spaces\/DM[^/]*$/.test(path)) {
    return json({
      name: path.replace(/^\/v1\//, ''),
      spaceType: 'DIRECT_MESSAGE',
      membershipCount: { joinedDirectHumanUserCount: 1 }
    })
  }
  if (path.endsWith('/decisions')) {
    return json({ answers: [{ name: 'respond', probability: decision.respond ? 0.9 : 0.1 }] })
  }
  return undefined
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = init?.method ?? 'GET'
  const faked = fakeGoogle(url, method)
  if (!faked) return mockFetch(input, init)
  mock.calls.push({ url: url.toString(), method, body: undefined })
  return faked
}) as typeof fetch

type EventRequest = {
  kind: 'dm' | 'mention' | 'message' | 'added' | 'stop-click'
  space?: string
  thread?: string
  id?: string
  text?: string
  user?: string
  ack?: string
  /** Reuse an earlier event's time to replay a Google redelivery; defaults to now. */
  eventTime?: string
}

type CardAction = { function: string; parameters?: Array<{ key: string; value: string }> }

/** The Stop button's action exactly as the bot last rendered it on the acknowledgement. */
function renderedStopAction(ack: string): CardAction {
  const cards = JSON.stringify(mock.messages.get(ack)?.cardsV2 ?? [])
  const match = /"action":(\{"function":"[^"]*"(?:,"parameters":\[[^\]]*\])?\})/.exec(cards)
  if (!match?.[1] || !cards.includes(STOP_CARD_FUNCTION)) {
    throw new Error(`${ack} carries no Stop button`)
  }
  return JSON.parse(match[1]) as CardAction
}

function stopClick(request: EventRequest, chat: object, space: object, thread: object): object {
  if (!request.ack) throw new Error('stop-click needs "ack": the acknowledgement message name')
  const action = renderedStopAction(request.ack)
  const parameters = Object.fromEntries((action.parameters ?? []).map(entry => [entry.key, entry.value]))
  return {
    commonEventObject: { hostApp: 'CHAT', platform: 'WEB', invokedFunction: action.function, parameters },
    chat: {
      ...chat,
      buttonClickedPayload: {
        space,
        message: { name: request.ack, thread, sender: { name: BOT_USER, type: 'BOT' } }
      }
    }
  }
}

/** A Workspace Add-on envelope, as Google delivers it to an HTTP Chat app. */
function chatEvent(request: EventRequest): object {
  // A Stop click arrives from the space its acknowledgement was posted in.
  const ackSpace = request.ack?.split('/messages/')[0]?.replace(/^spaces\//, '')
  const name = `spaces/${request.space ?? ackSpace ?? (request.kind === 'dm' ? 'DM' : 'ROOM')}`
  const dm = name.startsWith('spaces/DM')
  const space = dm
    ? { name, spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true }
    : { name, spaceType: 'SPACE' }
  const thread = { name: `${name}/threads/${request.thread ?? 'T1'}` }
  const userName = request.user ?? DEFAULT_USER
  const user = { name: userName, displayName: userName, type: 'HUMAN' }
  const chat = { eventTime: request.eventTime ?? new Date().toISOString(), user }
  const common = { hostApp: 'CHAT', platform: 'WEB' }
  if (request.kind === 'stop-click') return stopClick(request, chat, space, thread)
  if (request.kind === 'added') {
    return { commonEventObject: common, chat: { ...chat, addedToSpacePayload: { space } } }
  }
  if (!request.id || request.text === undefined) {
    throw new Error(`${request.kind} needs "id" and "text"`)
  }
  const botMention = { user: { name: BOT_USER, type: 'BOT' }, type: 'MENTION' }
  const message = {
    name: `${name}/messages/${request.id}`,
    text: request.text,
    thread,
    threadReply: true,
    sender: user,
    ...(request.kind === 'mention'
      ? { annotations: [{ type: 'USER_MENTION', userMention: botMention }] }
      : {})
  }
  return { commonEventObject: common, chat: { ...chat, messagePayload: { space, message } } }
}

async function deliver(request: EventRequest): Promise<Response> {
  const event = chatEvent(request)
  const now = Math.floor(Date.now() / 1000)
  const token = await signJwt({
    privateKey: keys.privateKey,
    kid: KID,
    claims: {
      iss: 'https://accounts.google.com',
      aud: audience,
      email: signer,
      email_verified: true,
      iat: now,
      exp: now + 300
    }
  })
  const response = await realFetch(`http://127.0.0.1:${botPort}/api/chat/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(event)
  })
  return json({ status: response.status, body: await response.text(), event })
}

/** A message only spaces.messages.list knows about: Google pushes no unmentioned messages. */
function listedMessage(request: EventRequest): object {
  if (!request.id || !request.text) throw new Error('listed message needs "id" and "text"')
  const space = `spaces/${request.space ?? 'PROACTIVE'}`
  const user = request.user ?? DEFAULT_USER
  const message = {
    name: `${space}/messages/${request.id}`,
    text: request.text,
    createTime: new Date().toISOString(),
    thread: { name: `${space}/threads/${request.thread ?? 'T1'}` },
    threadReply: true,
    sender: { name: user, displayName: user, type: 'HUMAN' }
  }
  mock.listed.unshift(message)
  return message
}

function snapshot(): object {
  return {
    messages: Object.fromEntries(mock.messages),
    executions: mock.executions,
    active: [...mock.active],
    interrupts: mock.interrupts,
    reactions: Object.fromEntries(mock.reactions),
    open_streams: [...mock.streams.values()]
      .filter(stream => !stream.closed)
      .map(stream => stream.executionId),
    calls: mock.calls
  }
}

async function control(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url)
  const body = request.method === 'POST' ? await request.json() as Record<string, unknown> : {}
  if (pathname === '/health') return json({ ok: true, pid: process.pid, bot_port: botPort })
  if (pathname === '/state') return json(snapshot())
  if (pathname === '/event') return deliver(body as EventRequest)
  if (pathname === '/listed') return json(listedMessage(body as EventRequest))
  if (pathname === '/decision') {
    decision.respond = body.respond === true
    return json(decision)
  }
  if (pathname === '/finish' || pathname === '/status') {
    const execution = String(body.execution ?? '')
    const stream = mock.streams.get(execution)
    if (!stream || stream.closed) return json({ error: `no open stream for ${execution}` }, 404)
    if (pathname === '/finish') mock.finish(execution, String(body.text ?? ''))
    else mock.status(execution, String(body.text ?? ''))
    return json({ ok: true })
  }
  return json({ error: `unknown control route ${request.method} ${pathname}` }, 404)
}

Bun.serve({
  hostname: '127.0.0.1',
  port: controlPort,
  fetch: request => control(request).catch((error: unknown) =>
    json({ error: error instanceof Error ? error.message : String(error) }, 400))
})
