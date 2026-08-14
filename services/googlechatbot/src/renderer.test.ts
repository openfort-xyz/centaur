import { test, expect, describe } from 'bun:test'
import {
  consumeRenderStream,
  createRenderState,
  createRendererWriteScheduler,
  finalMessageBodies,
  finalizeRender,
  type RenderTarget,
  type RendererWriteScheduler
} from './renderer'
import type { ChatEdgeClient } from './chat/client'
import type { GoogleChatMessage } from './chat/types'
import type { RustSessionStreamEvent } from '@centaur/harness-events'
import { markdownToChatMessage, messageUtf8Bytes } from './chat/render'
import { chatReplyLimits } from './constants'

const RICH_ANSWER = '# Result\n- first\n- second'

type Capture = {
  body?: Partial<GoogleChatMessage>
  creates?: Array<{
    body: Partial<GoogleChatMessage>
    messageId?: string
    threadName?: string
    spaceType?: string
  }>
  deletes?: string[]
}

function stubClient(capture: Capture): ChatEdgeClient {
  return {
    updateMessage: async (_name: string, body: Partial<GoogleChatMessage>) => {
      capture.body = body
      return {}
    },
    createMessage: async (
      _space: string,
      body: Partial<GoogleChatMessage>,
      opts: { messageId?: string; threadName?: string; spaceType?: string } = {}
    ) => {
      capture.creates ??= []
      capture.creates.push({ body, ...opts })
      return {}
    },
    deleteMessage: async (name: string) => {
      capture.deletes ??= []
      capture.deletes.push(name)
    }
  } as unknown as ChatEdgeClient
}

const immediateWrites: RendererWriteScheduler = { run: async (_space, write) => write() }

function target(overrides: Partial<RenderTarget> = {}): RenderTarget {
  return {
    spaceName: 'spaces/AAAA',
    ackMessageName: 'spaces/AAAA/messages/M1',
    writeScheduler: immediateWrites,
    ...overrides
  }
}

/** State with a settled answer; the mapper is stubbed so flush() can't emit an
 * empty snapshot that would wipe the hand-set answer. */
function settledState(answer: string) {
  const state = createRenderState()
  state.mapper = { process: () => [], flush: () => [] } as unknown as typeof state.mapper
  state.answer = answer
  state.terminal = true
  return state
}

describe('finalizeRender surface selection', () => {
  test('markdown answers go to the text surface (cards fragment inline spans)', async () => {
    const capture: Capture = {}
    const state = settledState(RICH_ANSWER)

    await finalizeRender(stubClient(capture), target(), state)

    // Heading becomes a Chat-markup bold line; list items ride along verbatim.
    expect(capture.body?.text).toContain('*Result*')
    expect(capture.body?.text).toContain('- first')
    expect(capture.body?.cardsV2).toEqual([])
  })

  test('mid-sentence bold stays inline on the text surface', async () => {
    const capture: { body?: Partial<GoogleChatMessage> } = {}
    const state = settledState("The spike was Farao's **coordinated public launch**, not drift.")

    await finalizeRender(stubClient(capture), target(), state)

    expect(capture.body?.text).toContain("Farao's *coordinated public launch*, not drift.")
    expect(capture.body?.cardsV2).toEqual([])
  })

  test('standalone image embeds go to the card surface', async () => {
    const capture: Capture = {}
    const state = settledState('Look:\n![diagram](https://example.com/x.png)')

    await finalizeRender(stubClient(capture), target(), state)

    expect(capture.body).toBeUndefined()
    expect(capture.creates?.[0]?.body.text).toBeUndefined()
    expect(capture.creates?.[0]?.body.cardsV2?.length).toBeGreaterThan(0)
    expect(capture.deletes).toEqual(['spaces/AAAA/messages/M1'])
  })

  test('long plain answers stay on the text surface until the whole-message byte limit', async () => {
    const capture: { body?: Partial<GoogleChatMessage> } = {}
    const state = settledState('word '.repeat(1_500))

    await finalizeRender(stubClient(capture), target(), state)

    expect(capture.body?.text).toBe('word '.repeat(1_500).trim())
    expect(capture.body?.cardsV2).toEqual([])
  })

  test('a plain-text-only request forces the text surface for rich markdown', async () => {
    const capture: { body?: Partial<GoogleChatMessage> } = {}
    const state = settledState(RICH_ANSWER)

    await finalizeRender(stubClient(capture), target({ plainTextOnly: true }), state)

    expect(capture.body?.text).toContain('first')
    expect(capture.body?.cardsV2).toEqual([])
  })

  test('card messages include fallbackText and no empty sections', async () => {
    const capture: Capture = {}
    const state = settledState('# Result\n![diagram](https://example.com/x.png)')

    await finalizeRender(
      stubClient(capture),
      target({
        fallbackMessageId: 'client-centaur-card',
        threadName: 'spaces/AAAA/threads/T1',
        spaceType: 'DIRECT_MESSAGE'
      }),
      state
    )

    const created = capture.creates?.[0]
    const body = created?.body as Partial<GoogleChatMessage> & { fallbackText?: string }
    expect(capture.body).toBeUndefined()
    expect(created?.messageId).toBe('client-centaur-card')
    expect(created?.threadName).toBe('spaces/AAAA/threads/T1')
    expect(created?.spaceType).toBe('DIRECT_MESSAGE')
    expect(body.fallbackText).toBeTruthy()
    expect((body.cardsV2 ?? []).every(card =>
      (card.card.sections ?? []).every(section => (section.widgets?.length ?? 0) > 0)
    )).toBe(true)
    expect(messageUtf8Bytes({ ...body, thread: { name: created?.threadName } }))
      .toBeLessThanOrEqual(chatReplyLimits.message.maxBytes)
    expect(capture.deletes).toEqual(['spaces/AAAA/messages/M1'])
  })

  test('plain answers with a trailer also describe their card fallback', () => {
    const trailer = { buttonList: { buttons: [{ text: 'Open Console' }] } }
    const [body] = finalMessageBodies('plain answer', { trailers: [trailer] })
    expect(body?.text).toBe('plain answer')
    expect(body?.cardsV2).toHaveLength(1)
    expect(body?.fallbackText).toBeTruthy()
    expect(messageUtf8Bytes(body)).toBeLessThanOrEqual(chatReplyLimits.message.maxBytes)
  })

  test('splits at exact 31,999 / 32,000 / 32,001 serialized-byte boundaries', () => {
    const emptyBytes = messageUtf8Bytes({ text: '', cardsV2: [] })
    for (const size of [31_999, 32_000]) {
      const source = 'x'.repeat(size - emptyBytes)
      const bodies = finalMessageBodies(source)
      expect(bodies).toHaveLength(1)
      expect(messageUtf8Bytes(bodies[0])).toBe(size)
      expect(bodies.map(body => body.text ?? '').join('')).toBe(source)
    }

    const source = 'x'.repeat(32_001 - emptyBytes)
    const bodies = finalMessageBodies(source)
    expect(bodies.length).toBe(2)
    expect(bodies.every(body => messageUtf8Bytes(body) <= 32_000)).toBe(true)
    expect(bodies.map(body => body.text ?? '').join('')).toBe(source)
  })

  test('preserves emoji/CJK content across ordered message parts', () => {
    const source = '😀漢字'.repeat(5_000)
    const bodies = finalMessageBodies(source)
    expect(bodies.length).toBeGreaterThan(1)
    expect(bodies.map(body => body.text ?? '').join('')).toBe(source)
    expect(bodies.every(body => messageUtf8Bytes(body) <= 32_000)).toBe(true)
  })

  test('reserves the create-time thread field inside the 32,000-byte envelope', () => {
    const threadName = 'spaces/AAAA/threads/T1'
    const source = 'x'.repeat(70_000)
    const bodies = finalMessageBodies(source, { threadName })
    expect(bodies.map(body => body.text ?? '').join('')).toBe(source)
    expect(bodies.every(body => messageUtf8Bytes({ ...body, thread: { name: threadName } }) <= 32_000))
      .toBe(true)
  })

  test('packs multiple rich cards and a trailer under the complete message limit', () => {
    const source = Array.from(
      { length: 12 },
      (_, index) => `# Image ${index}\n${'漢字😀'.repeat(900)}\n![image ${index}](https://example.com/${index}.png)`
    ).join('\n')
    const trailer = { buttonList: { buttons: [{ text: 'Open Console' }] } }
    const bodies = finalMessageBodies(source, { trailers: [trailer] })

    expect(bodies.length).toBeGreaterThan(1)
    expect(bodies.every(body => messageUtf8Bytes(body) <= 32_000)).toBe(true)
    expect(bodies.every(body => body.fallbackText)).toBe(true)
    expect(bodies.flatMap(body => body.cardsV2 ?? []).some(card => card.cardId === 'actions')).toBe(true)
    expect(bodies.flatMap(body => body.cardsV2 ?? []).filter(card => card.cardId !== 'actions'))
      .toEqual(markdownToChatMessage(source).cardsV2 ?? [])
  })

  test('uses deterministic retry-safe IDs for every created overflow part', async () => {
    const answer = 'x'.repeat(70_000)
    const first: Capture = {}
    const second: Capture = {}
    const renderTarget = target({ fallbackMessageId: 'client-centaur-stable' })

    await finalizeRender(stubClient(first), renderTarget, settledState(answer))
    await finalizeRender(stubClient(second), renderTarget, settledState(answer))

    const firstIds = (first.creates ?? []).map(create => create.messageId)
    const secondIds = (second.creates ?? []).map(create => create.messageId)
    expect(firstIds).toEqual(['client-centaur-stable-part-2', 'client-centaur-stable-part-3'])
    expect(secondIds).toEqual(firstIds)
  })

  test('treats an existing deterministic card part as a successful replay', async () => {
    const creates: string[] = []
    const deletes: string[] = []
    const client = {
      createMessage: async (
        _space: string,
        _body: Partial<GoogleChatMessage>,
        opts: { messageId?: string } = {}
      ) => {
        creates.push(opts.messageId ?? '')
        throw new Error('409 ALREADY_EXISTS')
      },
      deleteMessage: async (name: string) => { deletes.push(name) }
    } as unknown as ChatEdgeClient

    await expect(finalizeRender(
      client,
      target({ fallbackMessageId: 'client-centaur-replay' }),
      settledState('![diagram](https://example.com/x.png)')
    )).resolves.toBe('created')

    expect(creates).toEqual(['client-centaur-replay'])
    expect(deletes).toEqual(['spaces/AAAA/messages/M1'])
  })
})

describe('renderer write scheduling', () => {
  test('serializes a status pulse and final write without real sleeps', async () => {
    let now = 10_000
    const starts: Array<{ at: number; text: string | undefined }> = []
    const scheduler = createRendererWriteScheduler({
      now: () => now,
      sleep: async milliseconds => { now += milliseconds }
    })
    const client = {
      updateMessage: async (_name: string, body: Partial<GoogleChatMessage>) => {
        starts.push({ at: now, text: body.text })
        return {}
      }
    } as unknown as ChatEdgeClient
    async function* stream(): AsyncGenerator<RustSessionStreamEvent> {
      yield {
        eventKind: 'session.activity_summary',
        data: { summary: 'Running tests' }
      } as RustSessionStreamEvent
    }
    const state = createRenderState()
    const renderTarget = target({ writeScheduler: scheduler })

    await consumeRenderStream(client, stream(), renderTarget, state)
    await finalizeRender(client, renderTarget, state)

    expect(starts).toHaveLength(2)
    expect(starts[0]).toEqual({ at: 10_000, text: '_Centaur · Running tests…_' })
    expect(starts[1]?.at).toBe(11_000)
  })

  test('serializes same-space writes one quota window apart without real sleeps', async () => {
    let now = 10_000
    const delays: number[] = []
    const starts: number[] = []
    const scheduler = createRendererWriteScheduler({
      now: () => now,
      sleep: async milliseconds => {
        delays.push(milliseconds)
        now += milliseconds
      }
    })

    await Promise.all([
      scheduler.run('spaces/AAAA', async () => { starts.push(now) }),
      scheduler.run('spaces/AAAA', async () => { starts.push(now) }),
      scheduler.run('spaces/AAAA', async () => { starts.push(now) })
    ])

    expect(starts).toEqual([10_000, 11_000, 12_000])
    expect(delays).toEqual([1_000, 1_000])
  })

  test('does not serialize writes to different spaces', async () => {
    let now = 5_000
    const delays: number[] = []
    const scheduler = createRendererWriteScheduler({
      now: () => now,
      sleep: async milliseconds => {
        delays.push(milliseconds)
        now += milliseconds
      }
    })
    await Promise.all([
      scheduler.run('spaces/A', async () => undefined),
      scheduler.run('spaces/B', async () => undefined)
    ])
    expect(delays).toEqual([])
  })
})
