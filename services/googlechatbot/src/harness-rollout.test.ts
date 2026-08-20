import { describe, expect, test } from 'bun:test'
import { resolveHarnessRollout } from './harness-rollout'

describe('Google Chat harness rollout', () => {
  test('is sticky and bypasses explicit model selections', () => {
    const input = {
      requestedHarness: 'codex',
      rolloutPercent: 50,
      threadId: 'chat:spaces:AAAA:threads:T1'
    }

    expect(resolveHarnessRollout(input)).toEqual(resolveHarnessRollout(input))
    expect(resolveHarnessRollout({ ...input, rolloutPercent: 100 }).harnessType).toBe('nanocodex')
    expect(resolveHarnessRollout({ ...input, modelOverride: 'gpt-5.6-sol' })).toEqual({
      harnessType: 'codex'
    })
  })
})
