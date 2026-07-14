import { test, expect, describe, beforeAll } from 'bun:test'
import { verifyChatRequest, verifyChatRequestToken } from './verify'
import { GOOGLE_CHAT_ISSUER } from './token'
import { generateRsaKeyPair, signJwt, staticKeyResolver } from './test-jwt'
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
    const config = configWith({ GOOGLECHATBOT_ALLOWED_DOMAIN: '' })
    const out = verifyChatRequest({
      config,
      envelope: envelopeAt('2026-01-01T00:00:00Z'),
      nowSeconds: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
    })
    expect(out.ok).toBe(true)
  })

  test('rejects an event from an outside domain when allowlist is configured', () => {
    const config = configWith({ GOOGLECHATBOT_ALLOWED_DOMAIN: 'openfort.xyz' })
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
    const config = configWith({ GOOGLECHATBOT_ALLOWED_DOMAIN: 'openfort.xyz,other.example' })
    const out = verifyChatRequest({
      config,
      envelope: envelopeAt('2026-01-01T00:00:00Z', 'me@openfort.xyz'),
      nowSeconds: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
    })
    expect(out.ok).toBe(true)
  })

  test('rejects events older than CHAT_EVENT_MAX_AGE_SECONDS as stale', () => {
    const config = configWith({
      GOOGLECHATBOT_ALLOWED_DOMAIN: '',
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
    const config = configWith({ GOOGLECHATBOT_ALLOWED_DOMAIN: '' })
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

describe('verifyChatRequestToken', () => {
  const KID = 'test-key-1'
  const AUD = '734836800829'
  const NOW = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
  let pair: CryptoKeyPair
  let resolveKey: ReturnType<typeof staticKeyResolver>

  beforeAll(async () => {
    pair = await generateRsaKeyPair()
    resolveKey = staticKeyResolver(KID, pair.publicKey)
  })

  async function bearer(overrides: Record<string, unknown> = {}): Promise<string> {
    const token = await signJwt({
      privateKey: pair.privateKey,
      kid: KID,
      claims: { iss: GOOGLE_CHAT_ISSUER, aud: AUD, iat: NOW, exp: NOW + 300, ...overrides }
    })
    return `Bearer ${token}`
  }

  test('is a no-op when signed requests are not required (legacy / rollback)', async () => {
    const config = configWith({ GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'false' })
    const out = await verifyChatRequestToken({ config, authorization: undefined, resolveKey, nowSeconds: NOW })
    expect(out.ok).toBe(true)
  })

  test('rejects a missing bearer token when required', async () => {
    const config = configWith({
      GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: '1',
      GOOGLECHATBOT_PROJECT_NUMBER: AUD
    })
    const out = await verifyChatRequestToken({ config, authorization: undefined, resolveKey, nowSeconds: NOW })
    expect(out).toEqual({ ok: false, status: 401, reason: 'missing_bearer_token' })
  })

  test('fails closed when enforcement is on but no audience is configured', async () => {
    const config = configWith({ GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: '1', GOOGLECHATBOT_PROJECT_NUMBER: '', GOOGLECHATBOT_WEBHOOK_AUDIENCE: '' })
    const out = await verifyChatRequestToken({ config, authorization: await bearer(), resolveKey, nowSeconds: NOW })
    expect(out).toEqual({ ok: false, status: 401, reason: 'audience_not_configured' })
  })

  test('accepts a valid Google-signed token for the configured project number', async () => {
    const config = configWith({
      GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'true',
      GOOGLECHATBOT_PROJECT_NUMBER: AUD
    })
    const out = await verifyChatRequestToken({ config, authorization: await bearer(), resolveKey, nowSeconds: NOW })
    expect(out.ok).toBe(true)
  })

  test('rejects a valid signature carrying the wrong audience', async () => {
    const config = configWith({
      GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'true',
      GOOGLECHATBOT_PROJECT_NUMBER: AUD
    })
    const out = await verifyChatRequestToken({
      config,
      authorization: await bearer({ aud: 'not-our-project' }),
      resolveKey,
      nowSeconds: NOW
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(401)
      expect(out.reason).toMatch(/^audience_mismatch\(aud=not-our-project\)$/)
    }
  })

  test('accepts the URL audience model', async () => {
    const url = 'https://chat-centaur.fort.dev/api/chat/events'
    const config = configWith({
      GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'true',
      GOOGLECHATBOT_WEBHOOK_AUDIENCE: url
    })
    const out = await verifyChatRequestToken({
      config,
      authorization: await bearer({ aud: url }),
      resolveKey,
      nowSeconds: NOW
    })
    expect(out.ok).toBe(true)
  })
})
