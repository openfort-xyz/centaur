import { test, expect, describe, mock } from 'bun:test'
import { loadConfig } from './config'
import {
  createFlagMessageOverridesStrategy,
  createOpenAiMessageOverridesStrategy,
  messageOverridesStrategyFromConfig
} from './message-overrides-strategy'

describe('createFlagMessageOverridesStrategy', () => {
  test('parses literal flags, matching extractMessageOverrides', async () => {
    const strategy = createFlagMessageOverridesStrategy()
    const out = await strategy('fix the bug --model gpt-5.2')
    expect(out.model).toBe('gpt-5.2')
    expect(out.cleanedText).toBe('fix the bug')
  })
})

function fakeResponsesApi(outputText: string, ok = true) {
  return mock(async () =>
    new Response(
      JSON.stringify({ output: [{ content: [{ text: outputText }] }] }),
      { status: ok ? 200 : 500 }
    )
  )
}

describe('createOpenAiMessageOverridesStrategy', () => {
  test('applies a validated LLM override and leaves the text unchanged', async () => {
    const fetchFn = fakeResponsesApi(
      JSON.stringify({ harness: null, model: 'gpt-5.6-sol', provider: null, reasoning: 'max' })
    )
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      fetch: fetchFn as unknown as typeof fetch,
      model: 'gpt-5.4-nano'
    })

    const out = await strategy('use max effort and the sol model')

    expect(out.model).toBe('gpt-5.6-sol')
    expect(out.harnessType).toBe('codex')
    expect(out.reasoning).toBe('max')
    expect(out.cleanedText).toBe('use max effort and the sol model')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  test('drops the whole bundle when the model output fails validation', async () => {
    const fetchFn = fakeResponsesApi(
      JSON.stringify({ harness: 'not-a-harness', model: null, provider: null, reasoning: null })
    )
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      fetch: fetchFn as unknown as typeof fetch,
      model: 'gpt-5.4-nano'
    })

    const out = await strategy('some message')

    expect(out.harnessType).toBeUndefined()
    expect(out.model).toBeUndefined()
  })

  test('fails open (no overrides) when the API call errors', async () => {
    const fetchFn = mock(async () => new Response('boom', { status: 500 }))
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      fetch: fetchFn as unknown as typeof fetch,
      model: 'gpt-5.4-nano'
    })

    const out = await strategy('some message')

    expect(out).toEqual({ cleanedText: 'some message' })
  })
})

describe('messageOverridesStrategyFromConfig', () => {
  test('defaults to the flag strategy', async () => {
    const config = loadConfig({})
    const strategy = messageOverridesStrategyFromConfig(config)
    const out = await strategy('go --claude')
    expect(out.harnessType).toBe('claudecode')
    expect(out.cleanedText).toBe('go')
  })

  test('falls back to a no-op strategy when llm mode has no API key', async () => {
    const config = loadConfig({ GOOGLECHATBOT_MESSAGE_OVERRIDES_STRATEGY: 'llm' })
    const strategy = messageOverridesStrategyFromConfig(config)
    const out = await strategy('use max effort')
    expect(out).toEqual({ cleanedText: 'use max effort' })
  })

  test('memoizes the strategy per config instance', () => {
    const config = loadConfig({})
    const first = messageOverridesStrategyFromConfig(config)
    const second = messageOverridesStrategyFromConfig(config)
    expect(first).toBe(second)
  })
})
