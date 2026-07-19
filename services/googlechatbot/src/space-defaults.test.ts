import { describe, expect, test } from 'bun:test'
import { loadConfig } from './config'
import {
  parseSpaceDefaults,
  resolveSpaceDefault,
  spaceDefaultsFromConfig,
  spaceIdFromThreadId
} from './space-defaults'

describe('parseSpaceDefaults', () => {
  test('returns an empty map for unset or blank input', () => {
    expect(parseSpaceDefaults(undefined)).toEqual({})
    expect(parseSpaceDefaults('')).toEqual({})
    expect(parseSpaceDefaults('   ')).toEqual({})
  })

  test('normalizes each space object through the shared flag vocabulary', () => {
    const parsed = parseSpaceDefaults(
      JSON.stringify({
        AAAAeng: { harness: 'claude', model: 'opus', reasoning: 'high' },
        AAAAtriage: { harness: 'codex', reasoning: 'low' },
        AAAAbedrock: { provider: 'bedrock', model: 'gpt-5.2' }
      })
    )
    expect(parsed).toEqual({
      AAAAeng: { harnessType: 'claudecode', model: 'claude-opus-4-8', reasoning: 'high' },
      AAAAtriage: { harnessType: 'codex', reasoning: 'low' },
      AAAAbedrock: { harnessType: 'codex', model: 'gpt-5.2', provider: 'amazon-bedrock' }
    })
  })

  test('reports unknown field values and skips an entry that resolves to nothing', () => {
    const reasons: string[] = []
    const parsed = parseSpaceDefaults(
      JSON.stringify({
        AAAAbad: { harness: 'gpt', reasoning: 'turbo' },
        AAAAok: { harness: 'codex' }
      }),
      reason => reasons.push(reason)
    )
    expect(parsed).toEqual({ AAAAok: { harnessType: 'codex' } })
    expect(reasons.some(r => r.includes('AAAAbad') && r.includes('unknown harness'))).toBe(true)
    expect(reasons.some(r => r.includes('AAAAbad') && r.includes('no usable'))).toBe(true)
  })

  test('reports and ignores invalid JSON without throwing', () => {
    const reasons: string[] = []
    expect(parseSpaceDefaults('{not json', reason => reasons.push(reason))).toEqual({})
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('invalid JSON')
  })
})

describe('spaceIdFromThreadId', () => {
  test('extracts the space id from a Google Chat thread key', () => {
    expect(spaceIdFromThreadId('chat:spaces:AAAA:spaces:AAAA:threads:BBBB')).toBe('AAAA')
  })

  test('returns undefined for a non-Google-Chat thread key', () => {
    expect(spaceIdFromThreadId('slack:C0ENG:1700000000.0001')).toBeUndefined()
    expect(spaceIdFromThreadId('chat:C123:123.456')).toBeUndefined()
  })
})

describe('resolveSpaceDefault', () => {
  const defaults = { AAAA: { harnessType: 'claudecode', model: 'claude-opus-4-8' } }

  test('returns the default for a matching space', () => {
    expect(
      resolveSpaceDefault(defaults, 'chat:spaces:AAAA:spaces:AAAA:threads:BBBB')
    ).toEqual({
      harnessType: 'claudecode',
      model: 'claude-opus-4-8'
    })
  })

  test('returns undefined for an unmapped space or missing config', () => {
    expect(
      resolveSpaceDefault(defaults, 'chat:spaces:OTHER:spaces:OTHER:threads:BBBB')
    ).toBeUndefined()
    expect(resolveSpaceDefault(undefined, 'chat:spaces:AAAA:spaces:AAAA:threads:BBBB')).toBeUndefined()
    expect(resolveSpaceDefault(defaults, 'slack:C0ENG:ts')).toBeUndefined()
  })
})

describe('spaceDefaultsFromConfig', () => {
  test('parses GOOGLECHATBOT_SPACE_DEFAULTS from config', () => {
    const config = loadConfig({
      GOOGLECHATBOT_SPACE_DEFAULTS: JSON.stringify({ AAAA: { harness: 'codex' } })
    })
    expect(spaceDefaultsFromConfig(config)).toEqual({ AAAA: { harnessType: 'codex' } })
  })

  test('returns an empty map when unset', () => {
    const config = loadConfig({})
    expect(spaceDefaultsFromConfig(config)).toEqual({})
  })
})
