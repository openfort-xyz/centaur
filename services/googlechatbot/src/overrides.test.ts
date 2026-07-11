import { test, expect, describe } from 'bun:test'
import { extractMessageOverrides } from './overrides'

describe('extractMessageOverrides', () => {
  test('extracts --model and strips it from the prompt', () => {
    const out = extractMessageOverrides('fix the bug --model gpt-5.2')
    expect(out.model).toBe('gpt-5.2')
    expect(out.cleanedText).toBe('fix the bug')
  })

  test('expands Claude aliases and implies the harness via shortcut flags', () => {
    const out = extractMessageOverrides('--opus refactor this')
    expect(out.model).toBe('claude-opus-4-8')
    expect(out.harnessType).toBe('claudecode')
    expect(out.cleanedText).toBe('refactor this')
  })

  test('extracts -rsn reasoning effort', () => {
    const out = extractMessageOverrides('think hard -rsn high')
    expect(out.reasoning).toBe('high')
    expect(out.cleanedText).toBe('think hard')
  })

  test('--bedrock selects the provider and implies codex', () => {
    const out = extractMessageOverrides('run it --bedrock')
    expect(out.provider).toBe('amazon-bedrock')
    expect(out.harnessType).toBe('codex')
  })

  test('--meta selects the responses provider and implies codex', () => {
    const out = extractMessageOverrides('run it --meta')
    expect(out.provider).toBe('responses')
    expect(out.harnessType).toBe('codex')
  })

  test('stops the --model value at a trailing newline (prompt on next line)', () => {
    const out = extractMessageOverrides('--model gpt-5.2\nfix the bug')
    expect(out.model).toBe('gpt-5.2')
    expect(out.cleanedText).toBe('fix the bug')
  })

  test('-rsn accepts the GPT-5.6 max effort', () => {
    expect(extractMessageOverrides('-rsn max fix it').reasoning).toBe('max')
  })

  test('stops the -rsn value at a trailing newline', () => {
    const out = extractMessageOverrides('-rsn high\nthink hard about this')
    expect(out.reasoning).toBe('high')
    expect(out.cleanedText).toBe('think hard about this')
  })

  test('leaves text untouched when no flags present', () => {
    const out = extractMessageOverrides('just a normal message')
    expect(out.cleanedText).toBe('just a normal message')
    expect(out.model).toBeUndefined()
  })
})
