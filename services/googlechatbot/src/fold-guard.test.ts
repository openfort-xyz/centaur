import { describe, expect, test } from 'bun:test'
import { canFoldIntoActiveRun } from './fold-guard'

describe('canFoldIntoActiveRun', () => {
  test('a DM always folds: there is only one human in it', () => {
    expect(canFoldIntoActiveRun({ space_type: 'DIRECT_MESSAGE' }, {})).toBe(true)
    expect(
      canFoldIntoActiveRun({ space_type: 'DIRECT_MESSAGE', user_email: 'b@x.test' }, { activeRequesterEmail: 'a@x.test' })
    ).toBe(true)
  })

  test('in a shared space only the same verified sender folds', () => {
    const run = { activeRequesterEmail: 'Ada@Openfort.xyz' }
    expect(canFoldIntoActiveRun({ space_type: 'SPACE', user_email: ' ada@openfort.xyz ' }, run)).toBe(true)
    expect(canFoldIntoActiveRun({ space_type: 'GROUP_CHAT', user_email: 'joan@openfort.xyz' }, run)).toBe(false)
  })

  test('an unverified sender or an unknown starter never folds', () => {
    expect(canFoldIntoActiveRun({ space_type: 'SPACE' }, { activeRequesterEmail: 'ada@openfort.xyz' })).toBe(false)
    expect(canFoldIntoActiveRun({ space_type: 'SPACE', user_email: 'ada@openfort.xyz' }, {})).toBe(false)
    expect(canFoldIntoActiveRun({ space_type: 'SPACE', user_email: 'ada@openfort.xyz' }, { activeRequesterEmail: null })).toBe(false)
    expect(canFoldIntoActiveRun({ space_type: 'SPACE' }, { activeRequesterEmail: null })).toBe(false)
  })
})
