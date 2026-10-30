import { afterEach, describe, expect, test } from 'bun:test'
import { createMemoryState } from '@chat-adapter/state-memory'
import { loadConfig } from './config'
import { isHarnessEnabled, parseEnabledHarnesses, resolveEnabledOverrides } from './harness-routing'
import { extractMessageOverrides, validateStrategyOverrides } from './overrides'
import { defaultModelForHarness, effectiveReasoningForHarness, buildResponseContextWidget, reasoningForModel } from './response-context'
import { createSession } from './session-api'
import { acquireLease } from './state'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('upstream harness parity', () => {
  test('validates and deduplicates the allowlist; omission remains unrestricted', () => {
    expect(parseEnabledHarnesses(undefined)).toBeUndefined()
    expect(isHarnessEnabled('omp')).toBe(true)
    expect(parseEnabledHarnesses('Codex, omp, codex')).toEqual(['codex', 'omp'])
    for (const invalid of ['', 'codex,', 'unknown']) {
      expect(() => parseEnabledHarnesses(invalid)).toThrow()
    }
    expect(() => loadConfig({ GOOGLECHATBOT_ENABLED_HARNESSES: 'omp' })).toThrow()
    expect(loadConfig({ GOOGLECHATBOT_ENABLED_HARNESSES: 'omp', GOOGLECHATBOT_DEFAULT_HARNESS: 'omp' })
      .GOOGLECHATBOT_ENABLED_HARNESSES).toEqual(['omp'])
  })

  test('resets disabled sticky/space/explicit selections and incompatible models together', () => {
    for (const overrides of [
      { harnessType: 'amp', model: 'deep', provider: 'openrouter' },
      { model: 'deep' }
    ]) {
      expect(resolveEnabledOverrides(overrides, 'codex', ['codex'])).toEqual({
        harnessType: 'codex', model: undefined, provider: undefined
      })
    }
    const allowed = { harnessType: 'omp', model: 'claude-opus-5-5' }
    expect(resolveEnabledOverrides(allowed, 'codex')).toBe(allowed)
  })

  test('OMP supports flags, model defaults, canonical strategy models, and Pi reasoning levels', () => {
    expect(extractMessageOverrides('--omp -rsn max hello')).toMatchObject({
      harnessType: 'omp', reasoning: 'max', cleanedText: 'hello'
    })
    expect(validateStrategyOverrides({ harness: 'omp', model: 'gpt-6.1-sol', reasoning: 'high' }))
      .toMatchObject({ harnessType: 'omp', model: 'gpt-6.1-sol', reasoning: 'high' })
    expect(JSON.stringify(buildResponseContextWidget({ harnessType: 'omp', metadataEnabled: true }))).toContain('OMP')
    expect(defaultModelForHarness('omp', { omp: 'claude-opus-5-5' })).toBe('claude-opus-5-5')
    expect(effectiveReasoningForHarness('omp', 'max')).toBe('max')
    expect(reasoningForModel('omp', 'claude-opus-5-5', 'max')).toBe('max')
    expect(reasoningForModel('omp', 'claude-opus-5-5', 'ultra')).toBeUndefined()
    expect(reasoningForModel('codex', 'gpt-6.1-sol', 'ultra')).toBe('ultra')
    expect(reasoningForModel('codex', 'gpt-6-sol', 'ultra')).toBeUndefined()
  })

  test('rejects disabled requested and API-resolved harnesses before execution', async () => {
    const config = loadConfig({ GOOGLECHATBOT_ENABLED_HARNESSES: 'codex' })
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return Response.json({ status: 'idle', harness_type: 'amp' })
    }) as unknown as typeof fetch
    await expect(createSession(config, 'chat:test', undefined, 'amp')).rejects.toThrow('not enabled')
    expect(calls).toBe(0)
    await expect(createSession(config, 'chat:test')).rejects.toThrow('not enabled')
    expect(calls).toBe(1)
  })

  test('a disabled existing harness is restarted on the enabled default, not reused', async () => {
    const requests: Record<string, unknown>[] = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return requests.length === 1
        ? Response.json({ code: 'harness_conflict', existing_harness: 'amp' }, { status: 409 })
        : Response.json({ status: 'idle', harness_type: 'codex' })
    }) as unknown as typeof fetch
    const result = await createSession(loadConfig({ GOOGLECHATBOT_ENABLED_HARNESSES: 'codex' }), 'chat:test')
    expect(requests.map(request => request.harness_type)).toEqual(['codex', 'codex'])
    expect(requests[1]?.on_harness_conflict).toBe('restart')
    expect(result.harnessType).toBe('codex')
  })

  test('the existing Google Chat lease keeps renewing beyond its original TTL', async () => {
    const state = createMemoryState()
    await state.connect()
    const lease = await acquireLease(state, 'test:recovery:lease', 200, 10)
    expect(lease).not.toBeNull()
    try {
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(await acquireLease(state, 'test:recovery:lease', 200, 10)).toBeNull()
      expect(lease?.lost.aborted).toBe(false)
    } finally {
      await lease?.release()
      await state.disconnect()
    }
  })
})
