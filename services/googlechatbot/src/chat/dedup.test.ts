import { describe, expect, test } from 'bun:test'
import { chatDedupKey } from './dedup'

const base = {
  eventTime: '2026-01-01T00:00:00Z',
  spaceName: 'spaces/AAAA',
  messageName: 'spaces/AAAA/messages/M1',
  action: {
    event_type: 'card_click' as const,
    invoked_function: 'approve',
    space_name: 'spaces/AAAA',
    user_id: 'users/U1',
    parameters: { request: 'r1', nested: { b: 2, a: 1 } }
  }
}

describe('chatDedupKey actions', () => {
  test('canonicalizes parameter object order', () => {
    expect(chatDedupKey(base)).toBe(chatDedupKey({
      ...base,
      action: { ...base.action, parameters: { nested: { a: 1, b: 2 }, request: 'r1' } }
    }))
  })

  test('separates users, functions, and parameters on the same message', () => {
    const key = chatDedupKey(base)
    expect(chatDedupKey({ ...base, action: { ...base.action, user_id: 'users/U2' } })).not.toBe(key)
    expect(chatDedupKey({ ...base, action: { ...base.action, invoked_function: 'reject' } })).not.toBe(key)
    expect(chatDedupKey({ ...base, action: { ...base.action, parameters: { request: 'r2' } } })).not.toBe(key)
  })
})
