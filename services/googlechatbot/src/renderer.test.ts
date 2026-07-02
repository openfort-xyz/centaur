import { test, expect, describe } from 'bun:test'
import { createRenderState, finalizeRender, type RenderTarget } from './renderer'
import type { ChatEdgeClient } from './chat/client'
import type { GoogleChatMessage } from './chat/types'

const RICH_ANSWER = '# Result\n- first\n- second'

function stubClient(capture: { body?: Partial<GoogleChatMessage> }): ChatEdgeClient {
  return {
    updateMessage: async (_name: string, body: Partial<GoogleChatMessage>) => {
      capture.body = body
      return {}
    }
  } as unknown as ChatEdgeClient
}

function target(overrides: Partial<RenderTarget> = {}): RenderTarget {
  return { spaceName: 'spaces/AAAA', ackMessageName: 'spaces/AAAA/messages/M1', ...overrides }
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
  test('rich markdown goes to the card surface', async () => {
    const capture: { body?: Partial<GoogleChatMessage> } = {}
    const state = settledState(RICH_ANSWER)

    await finalizeRender(stubClient(capture), target(), state)

    expect(capture.body?.text).toBeUndefined()
    expect(capture.body?.cardsV2?.length).toBeGreaterThan(0)
  })

  test('a plain-text-only request forces the text surface for rich markdown', async () => {
    const capture: { body?: Partial<GoogleChatMessage> } = {}
    const state = settledState(RICH_ANSWER)

    await finalizeRender(stubClient(capture), target({ plainTextOnly: true }), state)

    expect(capture.body?.text).toContain('first')
    expect(capture.body?.cardsV2).toEqual([])
  })
})
