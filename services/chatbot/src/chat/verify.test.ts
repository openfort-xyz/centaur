import { test, expect, describe } from 'bun:test'
import { verifyChatRequest } from './verify'
import { loadConfig, type AppConfig } from '../config'
import type { GoogleChatEnvelope } from './types'

function configWith(overrides: Record<string, string>): AppConfig {
  return loadConfig({ ...process.env, ...overrides })
}

function envelopeAt(timestamp: string, userEmail?: string): GoogleChatEnvelope {
  return {
    type: 'MESSAGE',
    eventTime: timestamp,
    space: { name: 'spaces/AAAA', type: 'SPACE' },
    user: userEmail ? { name: 'users/U1', email: userEmail } : undefined
  }
}

describe('verifyChatRequest', () => {
  test('accepts a fresh event when no domain allowlist is configured', () => {
    const config = configWith({ CHATBOT_ALLOWED_DOMAIN: '' })
    const out = verifyChatRequest({
      config,
      envelope: envelopeAt('2026-01-01T00:00:00Z'),
      nowSeconds: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
    })
    expect(out.ok).toBe(true)
  })

  test('rejects an event from an outside domain when allowlist is configured', () => {
    const config = configWith({ CHATBOT_ALLOWED_DOMAIN: 'openfort.xyz' })
    const out = verifyChatRequest({
      config,
      envelope: envelopeAt('2026-01-01T00:00:00Z', 'attacker@evil.example'),
      nowSeconds: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(403)
      expect(out.reason).toBe('domain_not_allowlisted')
    }
  })

  test('accepts an allowlisted domain', () => {
    const config = configWith({ CHATBOT_ALLOWED_DOMAIN: 'openfort.xyz,other.example' })
    const out = verifyChatRequest({
      config,
      envelope: envelopeAt('2026-01-01T00:00:00Z', 'me@openfort.xyz'),
      nowSeconds: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
    })
    expect(out.ok).toBe(true)
  })

  test('rejects events older than CHAT_EVENT_MAX_AGE_SECONDS as stale', () => {
    const config = configWith({
      CHATBOT_ALLOWED_DOMAIN: '',
      CHAT_EVENT_MAX_AGE_SECONDS: '60'
    })
    const now = Math.floor(new Date('2026-01-01T00:10:00Z').getTime() / 1000)
    const out = verifyChatRequest({
      config,
      envelope: envelopeAt('2026-01-01T00:00:00Z'),
      nowSeconds: now
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(401)
      expect(out.reason).toBe('stale_event_timestamp')
    }
  })

  test('rejects an invalid event timestamp', () => {
    const config = configWith({ CHATBOT_ALLOWED_DOMAIN: '' })
    const out = verifyChatRequest({
      config,
      envelope: envelopeAt('not-a-timestamp')
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(400)
      expect(out.reason).toBe('invalid_event_timestamp')
    }
  })
})
