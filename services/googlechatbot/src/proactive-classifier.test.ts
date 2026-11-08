import { describe, expect, test } from 'bun:test'
import {
  createOpenAiProactiveClassifier,
  decideWithTimeout,
  type ProactiveClassifierInput
} from './proactive-classifier'

const input: ProactiveClassifierInput = {
  botName: 'Centaur',
  history: [
    { author: 'Test User', fromBot: false, text: '@Centaur why did the deploy fail?' },
    { author: 'Centaur', fromBot: true, text: 'The migration timed out.' }
  ],
  message: { author: 'Test User', fromBot: false, text: 'can you retry it?' }
}

function classifierReturning(response: () => Response, requests: unknown[] = []) {
  return createOpenAiProactiveClassifier({
    apiKey: 'test-key',
    baseUrl: 'https://llm.example.test/v1/',
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)), url: String(url) })
      return response()
    }) as unknown as typeof fetch,
    model: 'gpt-6-luna'
  })
}

describe('OpenAI proactive classifier', () => {
  test('asks a respond predicate over the labelled transcript', async () => {
    const requests: Array<{ body: Record<string, unknown>; url: string }> = []
    const classifier = classifierReturning(
      () => Response.json({ answers: [{ name: 'respond', probability: 0.82, type: 'predicate' }] }),
      requests
    )
    await expect(classifier(input, new AbortController().signal)).resolves.toEqual({
      probability: 0.82,
      respond: true
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://llm.example.test/v1/decisions')
    expect(requests[0]!.body).toMatchObject({
      model: 'gpt-6-luna',
      questions: [{ name: 'respond', type: 'predicate' }]
    })
    const messages = requests[0]!.body.input as Array<{ content: string; role: string }>
    expect(messages.map(message => message.role)).toEqual(['developer', 'user'])
    expect(messages[0]!.content).toContain('Google Chat thread')
    expect(messages[1]!.content).toBe([
      'Latest thread messages, oldest first:',
      '[Test User]: @Centaur why did the deploy fail?',
      '[Centaur (assistant)]: The migration timed out.',
      '',
      'Newest message:',
      '[Test User]: can you retry it?'
    ].join('\n'))
  })

  test('declines below the probability threshold', async () => {
    const classifier = classifierReturning(() =>
      Response.json({ answers: [{ name: 'respond', probability: 0.2, type: 'predicate' }] })
    )
    await expect(classifier(input, new AbortController().signal)).resolves.toEqual({
      probability: 0.2,
      respond: false
    })
  })

  test('rejects failed requests and answers without a probability', async () => {
    const failing = classifierReturning(
      () => new Response('unavailable', { status: 503, statusText: 'Service Unavailable' })
    )
    await expect(failing(input, new AbortController().signal)).rejects.toThrow('HTTP 503')
    const malformed = classifierReturning(() => Response.json({ answers: [] }))
    await expect(malformed(input, new AbortController().signal)).rejects.toThrow('probability')
  })

  test('asks one question per operator rule and answers with the first rule met', async () => {
    const requests: Array<{ body: Record<string, unknown>; url: string }> = []
    let probabilities = [0.3, 0.7, 0.9]
    const classifier = classifierReturning(
      () => Response.json({
        answers: probabilities.map((probability, index) => ({ name: `rule_${index + 1}`, probability, type: 'predicate' }))
      }),
      requests
    )
    const rules = [
      { name: 'deploys', when: 'A failed deploy.' },
      { name: 'alerts', when: 'A firing alert.' },
      { name: 'anything', when: 'Any message.' }
    ]
    const alert = { botName: 'Centaur', history: [], message: { author: 'Alert Bot', fromBot: false, text: 'High error rate' }, rules }
    await expect(classifier(alert, new AbortController().signal)).resolves.toEqual({
      probability: 0.7,
      respond: true,
      rule: 'alerts'
    })
    expect(requests[0]!.body).toMatchObject({
      questions: [{ name: 'rule_1' }, { name: 'rule_2' }, { name: 'rule_3' }]
    })
    const messages = requests[0]!.body.input as Array<{ content: string }>
    expect(messages[0]!.content).toContain('Rule 2 (alerts):\nA firing alert.')

    probabilities = [0.1, 0.4, 0.2]
    await expect(classifier(alert, new AbortController().signal)).resolves.toEqual({
      probability: 0.4,
      respond: false
    })
  })

  test('a decision slower than the deadline is rejected rather than applied late', async () => {
    const slow = createOpenAiProactiveClassifier({
      apiKey: 'k',
      fetch: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
      model: 'gpt-6-luna'
    })
    await expect(decideWithTimeout(slow, input, 20)).rejects.toThrow()
  })
})
