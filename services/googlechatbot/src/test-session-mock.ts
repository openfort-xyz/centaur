/**
 * Test-only fetch double for the two upstreams the ingress talks to: the
 * api-rs session API and the Google Chat REST API. Unlike the simpler mock in
 * index.e2e.test.ts it keeps every event stream OPEN until the test closes it,
 * so stop, steering, and card behaviour can be asserted while a render is
 * genuinely in flight.
 */

export type MockCall = { url: string; method: string; body: unknown }

type OpenStream = {
  controller: ReadableStreamDefaultController<Uint8Array>
  closed: boolean
  executionId: string
}

export type SessionMock = {
  calls: MockCall[]
  /** Google messages by resource name, as last written. */
  messages: Map<string, Record<string, unknown>>
  /** Open SSE streams keyed by execution id. */
  streams: Map<string, OpenStream>
  /** Interrupts observed, with whether that thread's stream was still open. */
  interrupts: Array<{ threadKey: string; reason: string; whileOpen: boolean; executionId?: string }>
  /** Executions started per thread key, in order. */
  executions: Array<{ threadKey: string; executionId: string; idempotencyKey: string }>
  /** Thread keys api-rs reports as executing on session create. Maintained
   * automatically: set on execute, cleared on interrupt/finish. */
  active: Set<string>
  /** Reactions created, by name. */
  reactions: Map<string, { messageName: string; unicode: string }>
  /** Messages returned by spaces.messages.list. */
  listed: unknown[]
  /** Optional gate awaited before session create responds. */
  beforeSessionCreate?: () => Promise<void>
  /** Optional gate awaited before execute responds. */
  beforeExecute?: () => Promise<void>
  /** Whether an interrupt should also cancel and close the stream (default true). */
  interruptClosesStream: boolean
  /** When set, any card button whose action does not call back to exactly
   * this endpoint is rejected (400), as Google would never deliver its click
   * to a Workspace Add-on. */
  requireAddonCallback?: string
  /** Finish an execution with a completed answer and close its stream. */
  finish: (executionId: string, answer: string) => void
  /** Emit a status event on the open stream (drives a status PATCH). */
  status: (executionId: string, text: string) => void
  restore: () => void
}

const encoder = new TextEncoder()

export function installSessionMock(): SessionMock {
  const realFetch = globalThis.fetch
  const mock: SessionMock = {
    calls: [],
    messages: new Map(),
    streams: new Map(),
    interrupts: [],
    executions: [],
    active: new Set(),
    reactions: new Map(),
    listed: [],
    interruptClosesStream: true,
    finish: (executionId, answer) => {
      const stream = mock.streams.get(executionId)
      if (!stream || stream.closed) return
      stream.controller.enqueue(encoder.encode(
        `event: session.execution_completed\nid: 9\ndata: ${JSON.stringify({ result: answer })}\n\n`
      ))
      stream.controller.close()
      stream.closed = true
      for (const execution of mock.executions) {
        if (execution.executionId === executionId) mock.active.delete(execution.threadKey)
      }
    },
    status: (executionId, text) => {
      const stream = mock.streams.get(executionId)
      if (!stream || stream.closed) return
      stream.controller.enqueue(encoder.encode(
        `event: session.activity_summary\nid: 5\ndata: ${JSON.stringify({ summary: text })}\n\n`
      ))
    },
    restore: () => {
      globalThis.fetch = realFetch
    }
  }
  let sequence = 0
  let executionSequence = 0

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof URL ? input.toString() : input)
    const method = init?.method ?? 'GET'
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    mock.calls.push({ url, method, body })
    const parsed = new URL(url)
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

    if (parsed.hostname === 'chat.googleapis.com') {
      const name = decodeURIComponent(parsed.pathname.replace(/^\/v1\//, ''))
      if (mock.requireAddonCallback && (method === 'POST' || method === 'PATCH')) {
        const actions = JSON.stringify((body as { cardsV2?: unknown })?.cardsV2 ?? [])
          .match(/"function":"([^"]*)"/g) ?? []
        if (actions.some(entry => entry !== `"function":"${mock.requireAddonCallback}"`)) {
          return json({ error: { code: 400, message: 'Add-on card action must call back to the endpoint' } }, 400)
        }
      }
      if (method === 'POST' && /\/messages$/.test(name)) {
        const clientId = parsed.searchParams.get('messageId')
        sequence += 1
        const space = name.replace(/\/messages$/, '')
        const messageName = `${space}/messages/${clientId ?? `SRV${sequence}`}`
        const message = { ...(body as object), name: messageName }
        mock.messages.set(messageName, message)
        return json(message)
      }
      if (method === 'POST' && /\/reactions$/.test(name)) {
        sequence += 1
        const reactionName = `${name}/R${sequence}`
        const emoji = (body as { emoji?: { unicode?: string } }).emoji?.unicode ?? ''
        mock.reactions.set(reactionName, { messageName: name.replace(/\/reactions$/, ''), unicode: emoji })
        return json({ name: reactionName, emoji: { unicode: emoji } })
      }
      if (method === 'DELETE' && /\/reactions\//.test(name)) {
        mock.reactions.delete(name)
        return new Response(null, { status: 204 })
      }
      if (method === 'PATCH') {
        const mask = parsed.searchParams.get('updateMask') ?? ''
        const current = mock.messages.get(name) ?? { name }
        const update = body as Record<string, unknown>
        // Google rejects a body with neither nonempty text nor cards (400),
        // whatever the mask says; verified live.
        const cards = Array.isArray(update.cardsV2) ? update.cardsV2 : []
        if (!(typeof update.text === 'string' && update.text.length > 0) && cards.length === 0) {
          return json({ error: { code: 400, message: 'Message body is empty' } }, 400)
        }
        const next: Record<string, unknown> = { ...current, name }
        if (mask.includes('text') && 'text' in update) next.text = update.text
        if (mask.includes('cardsV2')) next.cardsV2 = update.cardsV2 ?? []
        mock.messages.set(name, next)
        return json(next)
      }
      if (method === 'DELETE') {
        mock.messages.delete(name)
        return new Response(null, { status: 204 })
      }
      if (method === 'GET' && /\/members\/app$/.test(name)) {
        return json({ member: { name: 'users/123456789', type: 'BOT' } })
      }
      if (method === 'GET' && /\/messages$/.test(name)) return json({ messages: mock.listed })
      if (method === 'GET' && mock.messages.has(name)) return json(mock.messages.get(name))
      if (method === 'GET' && /^spaces\/[^/]+$/.test(name)) {
        return json({ name, spaceType: 'SPACE' })
      }
      return json({})
    }

    const session = /\/api\/session\/([^/]+)(?:\/([a-z_]+))?$/.exec(decodeURIComponent(parsed.pathname))
    if (session) {
      const threadKey = session[1]!
      const action = session[2]
      if (!action && method === 'POST') {
        await mock.beforeSessionCreate?.()
        return json({ status: mock.active.has(threadKey) ? 'executing' : 'idle', harness_type: 'codex' })
      }
      if (action === 'execute') {
        await mock.beforeExecute?.()
        executionSequence += 1
        const executionId = `exec-${executionSequence}`
        mock.executions.push({
          threadKey,
          executionId,
          idempotencyKey: String((body as { idempotency_key?: unknown }).idempotency_key)
        })
        mock.active.add(threadKey)
        return json({ ok: true, execution_id: executionId, status: 'queued' })
      }
      if (action === 'interrupt') {
        const executionId = [...mock.executions].reverse()
          .find(execution => execution.threadKey === threadKey && mock.active.has(threadKey))?.executionId
        const stream = executionId ? mock.streams.get(executionId) : undefined
        const whileOpen = Boolean(stream && !stream.closed)
        mock.interrupts.push({
          threadKey,
          reason: String((body as { reason?: unknown }).reason ?? ''),
          whileOpen,
          ...(executionId ? { executionId } : {})
        })
        if (executionId && mock.interruptClosesStream && stream && !stream.closed) {
          stream.controller.enqueue(encoder.encode(
            'event: session.execution_cancelled\nid: 8\ndata: {"error":"interrupted"}\n\n'
          ))
          stream.controller.close()
          stream.closed = true
        }
        if (executionId) mock.active.delete(threadKey)
        return json({ ok: true, interrupted: Boolean(executionId), execution_id: executionId ?? null })
      }
      if (action === 'events') {
        const executionId = parsed.searchParams.get('execution_id') ?? ''
        const existing = mock.streams.get(executionId)
        if (existing?.closed) return new Response(null, { status: 200 })
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            mock.streams.set(executionId, { controller, closed: false, executionId })
            controller.enqueue(encoder.encode(': connected\n\n'))
          }
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      if (action === 'messages') return json({ ok: true })
      return json({ ok: true })
    }
    if (parsed.pathname.includes('/api/workflows/events')) return json({})
    throw new Error(`unexpected fetch in test: ${method} ${url}`)
  }) as unknown as typeof fetch

  return mock
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

export function threadKeyFor(spaceId: string, threadId: string): string {
  return `chat:spaces:${spaceId}:spaces:${spaceId}:threads:${threadId}`
}
