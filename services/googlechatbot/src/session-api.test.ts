import { test, expect, describe, afterEach, beforeEach } from 'bun:test'
import {
  turnMessagesFromEvent,
  createSession,
  executeSession,
  openSessionEventStream
} from './session-api'
import { parseChatBody } from './index'
import { loadConfig } from './config'
import { renderMetrics, resetMetrics } from './metrics'
import type { NormalizedChatEvent } from './chat/types'

const baseEvent: NormalizedChatEvent = {
  thread_key: 'chat:spaces:AAAA:spaces:AAAA:messages:M2',
  message_id: 'spaces/AAAA/messages/M2',
  space_name: 'spaces/AAAA',
  space_type: 'SPACE',
  user_id: 'users/U1',
  user_name: 'Alice',
  is_mention: true,
  parts: [{ type: 'text', text: 'deploy the thing' }],
  chat: { event_time: '2026-06-22T00:00:00Z', message_name: 'spaces/AAAA/messages/M2' }
}

describe('turnMessagesFromEvent', () => {
  test('builds an execute turn from the current message', () => {
    const { execute, history } = turnMessagesFromEvent(baseEvent)
    expect(execute.id).toBe('spaces/AAAA/messages/M2')
    expect(execute.role).toBe('user')
    expect(execute.text).toBe('deploy the thing')
    expect(execute.isMention).toBe(true)
    expect(execute.userName).toBe('Alice')
    expect(history).toEqual([])
  })

  test('maps prior thread history into user/assistant turns', () => {
    const { history } = turnMessagesFromEvent({
      ...baseEvent,
      history_messages: [
        {
          message_id: 'spaces/AAAA/messages/M1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'earlier answer' }],
          user_id: 'users/bot',
          metadata: { user_name: 'Centaur' }
        }
      ]
    })
    expect(history).toHaveLength(1)
    expect(history[0]?.role).toBe('assistant')
    expect(history[0]?.text).toBe('earlier answer')
    expect(history[0]?.userName).toBe('Centaur')
  })
})

describe('createSession', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const stubFetch = (body: unknown): void => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch
  }

  test('reports an active execution when api-rs says the session is executing', async () => {
    stubFetch({ session: { status: 'executing' }, harness_switched: false })
    const result = await createSession(loadConfig({}), 'chat:spaces:AAAA:threads:T1')
    expect(result.status).toBe('executing')
    expect(result.activeExecution).toBe(true)
  })

  test('reports no active execution when the session is idle', async () => {
    stubFetch({ session: { status: 'idle' }, harness_switched: false })
    const result = await createSession(loadConfig({}), 'chat:spaces:AAAA:threads:T1')
    expect(result.activeExecution).toBe(false)
  })

  test('tolerates a response without a session status', async () => {
    stubFetch({})
    const result = await createSession(loadConfig({}), 'chat:spaces:AAAA:threads:T1')
    expect(result.status).toBe('')
    expect(result.activeExecution).toBe(false)
  })
})

describe('executeSession', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    resetMetrics()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('prepends the requester context and counts the operation', async () => {
    let captured: string | undefined
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured = String(init?.body ?? '')
      return new Response(
        JSON.stringify({ execution_id: 'e1', ok: true, status: 'executing', thread_key: 't' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const { execute } = turnMessagesFromEvent(baseEvent)
    await executeSession(loadConfig({}), baseEvent.thread_key, execute)

    const body = JSON.parse(captured ?? '{}') as { input_lines: string[] }
    const line = JSON.parse(body.input_lines[0]!) as {
      message: { content: Array<{ type: string; text?: string }> }
    }
    expect(line.message.content[0]?.text).toStartWith('# Google Chat Session Context')
    expect(line.message.content[0]?.text).toContain('spaces/AAAA')
    expect(line.message.content[0]?.text).toContain(`thread_key: ${baseEvent.thread_key}`)
    expect(line.message.content[1]?.text).toStartWith('# Requester Context')
    expect(line.message.content[1]?.text).toContain('Prompted by: Alice')
    expect(line.message.content[2]?.text).toBe('deploy the thing')
    expect(renderMetrics()).toContain(
      'googlechatbot_session_api_operations_total{operation="execute_session",outcome="success"} 1'
    )
  })
})

describe('openSessionEventStream', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('passes activity summaries through as renderable events', async () => {
    const sse = [
      'event: session.activity_summary',
      'data: {"summary":"Running tests"}',
      '',
      'event: session.execution_completed',
      'data: {}',
      '',
      ''
    ].join('\n')
    globalThis.fetch = (async () =>
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })) as unknown as typeof fetch

    const stream = await openSessionEventStream(loadConfig({}), 'chat:spaces:AAAA:threads:T1', 0, 'e1', () => {})
    const events = []
    for await (const event of stream) events.push(event)

    expect(events[0]?.eventKind).toBe('session.activity_summary')
    expect((events[0]?.data as { summary?: string }).summary).toBe('Running tests')
    expect(events[1]?.eventKind).toBe('session.execution_completed')
  })
})

describe('parseChatBody', () => {
  test('passes through a v1 (legacy Chat API) envelope', () => {
    const envelope = parseChatBody(
      JSON.stringify({
        type: 'MESSAGE',
        eventTime: '2026-06-22T00:00:00Z',
        space: { name: 'spaces/AAAA', type: 'SPACE' },
        message: { name: 'spaces/AAAA/messages/M1', text: 'hi' }
      })
    )
    expect(envelope?.type).toBe('MESSAGE')
    expect(envelope?.space?.name).toBe('spaces/AAAA')
  })

  test('unwraps a v2 (Workspace Add-ons) message envelope', () => {
    const envelope = parseChatBody(
      JSON.stringify({
        chat: {
          eventTime: '2026-06-22T00:00:00Z',
          user: { name: 'users/U1', email: 'alice@example.com' },
          messagePayload: {
            space: { name: 'spaces/AAAA', type: 'ROOM' },
            message: { name: 'spaces/AAAA/messages/M1', text: 'hi' }
          }
        }
      })
    )
    expect(envelope?.type).toBe('MESSAGE')
    expect(envelope?.space?.name).toBe('spaces/AAAA')
    expect(envelope?.message?.name).toBe('spaces/AAAA/messages/M1')
  })

  test('unwraps a v2 added-to-space envelope', () => {
    const envelope = parseChatBody(
      JSON.stringify({
        chat: { addedToSpacePayload: { space: { name: 'spaces/AAAA', type: 'ROOM' } } }
      })
    )
    expect(envelope?.type).toBe('ADDED_TO_SPACE')
  })

  test('returns null for invalid JSON', () => {
    expect(parseChatBody('not json')).toBeNull()
  })
})
