import { describe, expect, test } from 'bun:test'
import { resolveSenderEmail } from './sender-lookup'
import type { GoogleChatEnvelope } from './chat/types'

function envelope(overrides: Partial<GoogleChatEnvelope> = {}): GoogleChatEnvelope {
  return {
    type: 'MESSAGE',
    authorizationEventObject: { systemIdToken: 'signed' },
    message: { name: 'spaces/AAAA/messages/M1', sender: { name: 'users/123', type: 'HUMAN' } },
    ...overrides
  }
}

const found = async (name: string) => (name === 'users/123' ? 'ada@example.com' : null)

describe('resolveSenderEmail', () => {
  test('resolves a signed human Add-on message sender', async () => {
    const email = await resolveSenderEmail({
      lookup: found,
      verified: true,
      ingressMode: 'workspace_addon',
      envelope: envelope()
    })
    expect(email).toBe('ada@example.com')
  })

  test('falls back to the envelope user when the message has no sender', async () => {
    const email = await resolveSenderEmail({
      lookup: found,
      verified: true,
      ingressMode: 'workspace_addon',
      envelope: envelope({ message: { name: 'spaces/AAAA/messages/M1' }, user: { name: 'users/123' } })
    })
    expect(email).toBe('ada@example.com')
  })

  test('never looks up an unverified request, another ingress, a bot, or a non-message', async () => {
    let lookups = 0
    const counting = async () => {
      lookups += 1
      return 'ada@example.com'
    }
    const base = { lookup: counting, verified: true, ingressMode: 'workspace_addon' as const }
    expect(await resolveSenderEmail({ ...base, verified: false, envelope: envelope() })).toBeUndefined()
    expect(
      await resolveSenderEmail({ ...base, ingressMode: 'chat_api_project', envelope: envelope() })
    ).toBeUndefined()
    expect(
      await resolveSenderEmail({
        ...base,
        envelope: envelope({ message: { sender: { name: 'users/9', type: 'BOT' } } })
      })
    ).toBeUndefined()
    expect(
      await resolveSenderEmail({ ...base, envelope: envelope({ type: 'ADDED_TO_SPACE' }) })
    ).toBeUndefined()
    expect(
      await resolveSenderEmail({
        ...base,
        envelope: envelope({ message: { sender: { name: 'people/123', type: 'HUMAN' } } })
      })
    ).toBeUndefined()
    expect(lookups).toBe(0)
  })

  test('an unknown person or a failing lookup leaves the turn anonymous', async () => {
    const unknown = await resolveSenderEmail({
      lookup: async () => null,
      verified: true,
      ingressMode: 'workspace_addon',
      envelope: envelope()
    })
    expect(unknown).toBeUndefined()
    const failed = await resolveSenderEmail({
      lookup: async () => {
        throw new Error('People API lookup failed: 500')
      },
      verified: true,
      ingressMode: 'workspace_addon',
      envelope: envelope()
    })
    expect(failed).toBeUndefined()
  })
})
