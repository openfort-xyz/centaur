import { test, expect, describe, mock } from 'bun:test'
import { loadConfig } from './config'
import {
  DECISION_QUESTIONS,
  MODEL_CHOICES,
  createFlagMessageOverridesStrategy,
  createOpenAiMessageOverridesStrategy,
  messageOverridesStrategyFromConfig
} from './message-overrides-strategy'
import { STRATEGY_MODEL_HARNESSES } from './overrides'

type DecisionsFields = {
  harness?: string
  model?: string
  provider?: string
  reasoning?: string
  selection: number
}

// Builds a /v1/decisions response. A field set to 'refusal' returns a refusal
// answer; an omitted field returns the unspecified choice.
function decisionsResponse({ selection, ...fields }: DecisionsFields): Response {
  return Response.json({
    answers: [
      { name: 'selection_request', probability: selection, type: 'predicate' },
      ...(['harness', 'model', 'provider', 'reasoning'] as const).map(name =>
        fields[name] === 'refusal'
          ? { name, type: 'refusal' }
          : { choice: fields[name] ?? 'unspecified', confidence: 0.9, name, type: 'choice' }
      )
    ],
    model: 'gpt-6-luna'
  })
}

function fakeDecisionsApi(fields: DecisionsFields) {
  return mock(async () => decisionsResponse(fields))
}

function userText(init: RequestInit | undefined): unknown {
  const body = JSON.parse(String(init?.body)) as { input: { content: unknown; role: string }[] }
  return body.input.find(item => item.role === 'user')?.content
}

describe('createFlagMessageOverridesStrategy', () => {
  test('parses literal flags, matching extractMessageOverrides', async () => {
    const strategy = createFlagMessageOverridesStrategy()
    const out = await strategy('fix the bug --model gpt-5.2')
    expect(out.model).toBe('gpt-5.2')
    expect(out.cleanedText).toBe('fix the bug')
  })
})

describe('createOpenAiMessageOverridesStrategy', () => {
  test('asks the Decisions API and applies a validated override, text unchanged', async () => {
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    const fetchFn = mock(async (url: string, init?: RequestInit) => {
      requestUrl = url
      requestInit = init
      return decisionsResponse({ selection: 0.98, model: 'gpt-6-sol', reasoning: 'max' })
    })
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1///',
      fetch: fetchFn as unknown as typeof fetch,
      model: 'gpt-6-luna'
    })

    const out = await strategy('use max effort and the sol model')

    expect(out).toEqual({
      cleanedText: 'use max effort and the sol model',
      harnessType: 'codex',
      model: 'gpt-6-sol',
      provider: undefined,
      reasoning: 'max'
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(requestUrl).toBe('https://example.test/v1/decisions')
    expect(userText(requestInit)).toBe('use max effort and the sol model')
    const body = JSON.parse(String(requestInit?.body)) as { model: string; questions: unknown }
    expect(body.model).toBe('gpt-6-luna')
    expect(body.questions).toEqual(DECISION_QUESTIONS)
    expect(requestInit?.headers).toMatchObject({ authorization: 'Bearer test-key' })
  })

  test('offers only models validation accepts, including the current aliases', () => {
    for (const choice of MODEL_CHOICES) {
      expect(STRATEGY_MODEL_HARNESSES[choice.value]).toBeDefined()
    }
    const values = MODEL_CHOICES.map(choice => choice.value)
    for (const model of [
      'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra',
      'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
      'claude-opus-5-5', 'claude-opus-5', 'claude-opus-5-fast'
    ]) expect(values).toContain(model)
  })

  test('selects each current generation and implies its harness', async () => {
    for (const [model, harnessType] of [
      ['gpt-6.1-terra', 'codex'],
      ['gpt-6.1-sol', 'codex'],
      ['gpt-5.6-sol', 'codex'],
      ['claude-fable-5-1', 'claudecode'],
      ['claude-sonnet-5-5', 'claudecode'],
      ['claude-haiku-5-5', 'claudecode'],
      ['claude-opus-4-7', 'claudecode'],
      ['claude-opus-5-fast', 'claudecode']
    ] as const) {
      const strategy = createOpenAiMessageOverridesStrategy({
        apiKey: 'test-key',
        fetch: fakeDecisionsApi({ selection: 0.9, model }) as unknown as typeof fetch,
        model: 'gpt-6-luna'
      })
      expect(await strategy(`use ${model}`)).toMatchObject({ model, harnessType })
    }
  })

  test('ignores field answers when the message is not a selection request', async () => {
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      fetch: fakeDecisionsApi({ selection: 0.2, model: 'claude-opus-4-7' }) as unknown as typeof fetch,
      model: 'gpt-6-luna'
    })
    expect(await strategy('our eval shows opus 4.7 hallucinating more, can you dig in'))
      .toEqual({ cleanedText: 'our eval shows opus 4.7 hallucinating more, can you dig in' })
  })

  test('treats refusals and unspecified choices as no selection', async () => {
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      fetch: fakeDecisionsApi({
        selection: 0.97, harness: 'nanocodex', provider: 'refusal', reasoning: 'high'
      }) as unknown as typeof fetch,
      model: 'gpt-6-luna'
    })
    expect(await strategy('use nanocodex with high effort')).toEqual({
      cleanedText: 'use nanocodex with high effort',
      harnessType: 'nanocodex',
      model: undefined,
      provider: undefined,
      reasoning: 'high'
    })
  })

  test('drops the whole bundle when an answer fails validation', async () => {
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      fetch: fakeDecisionsApi({ selection: 0.9, harness: 'not-a-harness' }) as unknown as typeof fetch,
      model: 'gpt-6-luna'
    })
    expect(await strategy('use the not-a-harness model')).toEqual({
      cleanedText: 'use the not-a-harness model'
    })
  })

  test('fails open with a logged warning on HTTP errors, malformed bodies, and timeouts', async () => {
    const warnings: string[] = []
    const logger = { info: () => undefined, warn: (event: string) => { warnings.push(event) } }
    for (const fetchFn of [
      mock(async () => new Response('boom', { status: 500 })),
      mock(async () => Response.json({ answers: 'nope' })),
      mock(async (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }))
    ]) {
      const strategy = createOpenAiMessageOverridesStrategy({
        apiKey: 'test-key',
        fetch: fetchFn as unknown as typeof fetch,
        logger,
        model: 'gpt-6-luna',
        timeoutMs: 5
      })
      expect(await strategy('use the sol model')).toEqual({ cleanedText: 'use the sol model' })
    }
    expect(warnings).toEqual([
      'googlechatbot_message_overrides_strategy_request_failed',
      'googlechatbot_message_overrides_strategy_request_failed'
    ])
  })

  test('handles explicit flags deterministically before the Decisions API', async () => {
    const fetchFn = mock(async () => {
      throw new Error('the explicit flag must not call the strategy model')
    })
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      fetch: fetchFn as unknown as typeof fetch,
      model: 'gpt-6-luna'
    })
    expect(await strategy('--nanocodex review this')).toMatchObject({
      harnessType: 'nanocodex',
      cleanedText: 'review this'
    })
    expect(await strategy('--fable review this')).toMatchObject({
      harnessType: 'claudecode',
      model: 'claude-fable-5-1'
    })
    expect(fetchFn).toHaveBeenCalledTimes(0)
  })

  test('only calls the Decisions API for messages with a selector term', async () => {
    const requested: unknown[] = []
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      fetch: (async (_url: string, init?: RequestInit) => {
        requested.push(userText(init))
        return decisionsResponse({ selection: 0.01 })
      }) as unknown as typeof fetch,
      model: 'gpt-6-luna'
    })
    for (const text of ['please solve the terraform example', 'can you summarize this thread?']) {
      expect(await strategy(text)).toEqual({ cleanedText: text })
    }
    for (const text of ['use Opus-4.7 for this', 'try gpt5', 'use hermes for this']) {
      await strategy(text)
    }
    expect(requested).toEqual(['use Opus-4.7 for this', 'try gpt5', 'use hermes for this'])
  })

  test('allows the Decisions API to select hermes from natural language', async () => {
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      fetch: fakeDecisionsApi({ selection: 0.9, harness: 'hermes' }) as unknown as typeof fetch,
      model: 'gpt-6-luna'
    })
    expect((await strategy('use hermes for this')).harnessType).toBe('hermes')
  })
})

describe('messageOverridesStrategyFromConfig', () => {
  test('defaults to the flag strategy', async () => {
    const strategy = messageOverridesStrategyFromConfig(loadConfig({}))
    const out = await strategy('go --claude')
    expect(out.harnessType).toBe('claudecode')
    expect(out.cleanedText).toBe('go')
  })

  test('falls back to a no-op strategy when llm mode has no API key', async () => {
    const strategy = messageOverridesStrategyFromConfig(
      loadConfig({ GOOGLECHATBOT_MESSAGE_OVERRIDES_STRATEGY: 'llm' })
    )
    expect(await strategy('use max effort')).toEqual({ cleanedText: 'use max effort' })
  })

  test('defaults the classifier model to gpt-6-luna', () => {
    expect(loadConfig({}).GOOGLECHATBOT_MESSAGE_OVERRIDES_MODEL).toBe('gpt-6-luna')
  })
})

describe('persona flag with the Decisions strategy', () => {
  test('a lone --persona still lets the classifier read the rest of the message', async () => {
    let requestInit: RequestInit | undefined
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      requestInit = init
      return decisionsResponse({ selection: 0.95, model: 'gpt-6-astra', reasoning: 'ultra' })
    })
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      fetch: fetchFn as unknown as typeof fetch,
      model: 'gpt-6-luna'
    })
    const out = await strategy('--persona eng use astra at ultra effort')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(userText(requestInit)).toBe('use astra at ultra effort')
    expect(out).toEqual({
      cleanedText: 'use astra at ultra effort',
      harnessType: 'codex',
      model: 'gpt-6-astra',
      personaId: 'eng',
      provider: undefined,
      reasoning: 'ultra'
    })
  })

  test('keeps the persona when the strategy request fails', async () => {
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key',
      fetch: mock(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
      logger: { info: () => undefined, warn: () => undefined },
      model: 'gpt-6-luna'
    })
    expect(await strategy('--persona eng use the sol model')).toEqual({
      cleanedText: 'use the sol model',
      personaId: 'eng'
    })
  })

  test('ordinary messages skip the classifier and preserve persona flags', async () => {
    const fetchFn = mock(() => { throw new Error('classifier must not run') })
    const strategy = createOpenAiMessageOverridesStrategy({
      apiKey: 'test-key', model: 'gpt-6-luna', fetch: fetchFn as unknown as typeof fetch
    })
    expect(await strategy('--persona eng deploy the thing'))
      .toEqual({ cleanedText: 'deploy the thing', personaId: 'eng' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
