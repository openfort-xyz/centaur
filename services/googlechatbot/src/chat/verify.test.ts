import { test, expect, describe, beforeAll } from 'bun:test'
import {
  resolveIdentityEmission,
  resolveSessionIdentity,
  verifyChatRequest,
  verifyChatRequestToken
} from './verify'
import { GOOGLE_CHAT_SA_ISSUER } from './token'
import { generateRsaKeyPair, signJwt, staticKeyResolver } from './test-jwt'
import { loadConfig, type AppConfig } from '../config'
import type { SpaceDmConfirmation } from './space-verify'
import type { ChatSpaceType, GoogleChatEnvelope } from './types'

function configWith(overrides: Record<string, string>): AppConfig {
  return loadConfig({ ...process.env, ...overrides })
}

function envelopeAt(timestamp: string): GoogleChatEnvelope {
  return {
    type: 'MESSAGE',
    eventTime: timestamp,
    space: { name: 'spaces/AAAA', type: 'SPACE' },
    user: { name: 'users/U1' }
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
      envelope: envelopeAt('2026-01-01T00:00:00Z'),
      userEmail: 'attacker@evil.example',
      nowSeconds: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(403)
      expect(out.reason).toBe('domain_not_allowlisted')
    }
  })

  test.each([undefined, '', 'missing-at.example', '@openfort.xyz', 'a@b@openfort.xyz'])(
    'rejects a missing or malformed sender email when allowlist is configured: %s',
    userEmail => {
      const config = configWith({ GOOGLECHATBOT_ALLOWED_DOMAIN: 'openfort.xyz' })
      const out = verifyChatRequest({
        config,
        envelope: envelopeAt('2026-01-01T00:00:00Z'),
        userEmail,
        nowSeconds: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
      })
      expect(out).toEqual({ ok: false, status: 403, reason: 'domain_not_allowlisted' })
    }
  )

  test('accepts an allowlisted domain', () => {
    const config = configWith({ GOOGLECHATBOT_ALLOWED_DOMAIN: 'openfort.xyz,other.example' })
    const out = verifyChatRequest({
      config,
      envelope: envelopeAt('2026-01-01T00:00:00Z'),
      userEmail: 'me@openfort.xyz',
      nowSeconds: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
    })
    expect(out.ok).toBe(true)
  })

  test('uses a verified Add-on user email instead of the body email', () => {
    const config = configWith({ GOOGLECHATBOT_ALLOWED_DOMAIN: 'example.com' })
    const out = verifyChatRequest({
      config,
      envelope: {
        ...envelopeAt('2026-01-01T00:00:00Z'),
        user: { name: 'users/U1', email: 'attacker@evil.example' }
      } as unknown as GoogleChatEnvelope,
      userEmail: 'alice@example.com',
      nowSeconds: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
    })
    expect(out).toEqual({ ok: true })
  })

  test('binds a verified Add-on user token subject to the event user', () => {
    const config = configWith({ GOOGLECHATBOT_ALLOWED_DOMAIN: '' })
    expect(verifyChatRequest({
      config,
      envelope: { ...envelopeAt('2026-01-01T00:00:00Z'), user: { name: 'users/U1' } },
      userId: 'U1',
      nowSeconds: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
    })).toEqual({ ok: true })
    expect(verifyChatRequest({
      config,
      envelope: { ...envelopeAt('2026-01-01T00:00:00Z'), user: { name: 'users/U2' } },
      userId: 'U1',
      nowSeconds: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
    })).toEqual({ ok: false, status: 401, reason: 'user_id_mismatch' })
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
      claims: { iss: GOOGLE_CHAT_SA_ISSUER, aud: AUD, iat: NOW, exp: NOW + 300, ...overrides }
    })
    return `Bearer ${token}`
  }

  async function oidcBearer(
    aud: string,
    email: string,
    overrides: Record<string, unknown> = {}
  ): Promise<string> {
    return `Bearer ${await signJwt({
      privateKey: pair.privateKey,
      kid: KID,
      claims: {
        iss: 'https://accounts.google.com',
        aud,
        email,
        email_verified: true,
        sub: 'U1',
        iat: NOW,
        exp: NOW + 300,
        ...overrides
      }
    })}`
  }

  // The skip path is processable but NOT verified: nothing was authenticated,
  // so it must never source identity metadata.
  test('is a no-op when signed requests are not required (legacy / rollback)', async () => {
    const config = configWith({ GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'false' })
    const out = await verifyChatRequestToken({ config, authorization: undefined, resolveKey, nowSeconds: NOW })
    expect(out).toEqual({ ok: true, verified: false })
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
    expect(out).toEqual({ ok: true, verified: true })
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
      GOOGLECHATBOT_INGRESS_MODE: 'chat_api_url',
      GOOGLECHATBOT_WEBHOOK_AUDIENCE: url
    })
    const out = await verifyChatRequestToken({
      config,
      authorization: await oidcBearer(url, GOOGLE_CHAT_SA_ISSUER),
      resolveKey,
      nowSeconds: NOW
    })
    expect(out).toEqual({ ok: true, verified: true })
  })

  test.each([
    [{ email_verified: false }, 'signer_email_not_verified'],
    [{ email: 'other@example.iam.gserviceaccount.com' }, 'signer_email_mismatch']
  ])('rejects URL-mode sender claim mismatch', async (overrides, reason) => {
    const url = 'https://chat.example.test/api/chat/events'
    const config = configWith({
      GOOGLECHATBOT_INGRESS_MODE: 'chat_api_url',
      GOOGLECHATBOT_WEBHOOK_AUDIENCE: url
    })
    const out = await verifyChatRequestToken({
      config,
      authorization: await oidcBearer(url, GOOGLE_CHAT_SA_ISSUER, overrides),
      resolveKey,
      nowSeconds: NOW
    })
    expect(out).toEqual({ ok: false, status: 401, reason })
  })

  test('keeps issuer and audience paired across modes', async () => {
    const url = 'https://chat.example.test/api/chat/events'
    const projectWithUrlToken = await verifyChatRequestToken({
      config: configWith({
        GOOGLECHATBOT_INGRESS_MODE: 'chat_api_project',
        GOOGLECHATBOT_PROJECT_NUMBER: AUD,
        GOOGLECHATBOT_WEBHOOK_AUDIENCE: url
      }),
      authorization: await oidcBearer(AUD, GOOGLE_CHAT_SA_ISSUER),
      resolveKey,
      nowSeconds: NOW
    })
    expect(projectWithUrlToken.ok).toBe(false)

    const urlWithProjectToken = await verifyChatRequestToken({
      config: configWith({
        GOOGLECHATBOT_INGRESS_MODE: 'chat_api_url',
        GOOGLECHATBOT_PROJECT_NUMBER: AUD,
        GOOGLECHATBOT_WEBHOOK_AUDIENCE: url
      }),
      authorization: await bearer({ aud: url }),
      resolveKey,
      nowSeconds: NOW
    })
    expect(urlWithProjectToken.ok).toBe(false)
  })

  test('verifies Add-on signer and optional user identity tokens', async () => {
    const url = 'https://addon.example.test/events'
    const signer = 'addon@example.iam.gserviceaccount.com'
    const clientId = '123.apps.googleusercontent.com'
    const userIdToken = (await oidcBearer(clientId, 'alice@example.com')).replace(/^Bearer /, '')
    const out = await verifyChatRequestToken({
      config: configWith({
        GOOGLECHATBOT_INGRESS_MODE: 'workspace_addon',
        GOOGLECHATBOT_WEBHOOK_AUDIENCE: url,
        GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL: signer,
        GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID: clientId
      }),
      authorization: await oidcBearer(url, signer),
      userIdToken,
      resolveKey,
      nowSeconds: NOW
    })
    expect(out).toEqual({
      ok: true,
      verified: true,
      userEmail: 'alice@example.com',
      userId: 'U1'
    })
  })

  test('rejects an Add-on without its exact configured signer', async () => {
    const url = 'https://addon.example.test/events'
    const base = {
      GOOGLECHATBOT_INGRESS_MODE: 'workspace_addon',
      GOOGLECHATBOT_WEBHOOK_AUDIENCE: url
    }
    const missing = await verifyChatRequestToken({
      config: configWith(base),
      authorization: await oidcBearer(url, 'addon@example.iam.gserviceaccount.com'),
      resolveKey,
      nowSeconds: NOW
    })
    expect(missing).toEqual({
      ok: false,
      status: 401,
      reason: 'addon_signer_email_not_configured'
    })
    const wrong = await verifyChatRequestToken({
      config: configWith({
        ...base,
        GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL: 'expected@example.iam.gserviceaccount.com'
      }),
      authorization: await oidcBearer(url, 'other@example.iam.gserviceaccount.com'),
      resolveKey,
      nowSeconds: NOW
    })
    expect(wrong).toEqual({ ok: false, status: 401, reason: 'signer_email_mismatch' })
  })

  test('rejects an Add-on user token without the configured OAuth audience', async () => {
    const url = 'https://addon.example.test/events'
    const signer = 'addon@example.iam.gserviceaccount.com'
    const userIdToken = (await oidcBearer('client-id', 'alice@example.com')).replace(/^Bearer /, '')
    const out = await verifyChatRequestToken({
      config: configWith({
        GOOGLECHATBOT_INGRESS_MODE: 'workspace_addon',
        GOOGLECHATBOT_WEBHOOK_AUDIENCE: url,
        GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL: signer
      }),
      authorization: await oidcBearer(url, signer),
      userIdToken,
      resolveKey,
      nowSeconds: NOW
    })
    expect(out).toEqual({
      ok: false,
      status: 401,
      reason: 'addon_oauth_client_id_not_configured'
    })
  })
})

describe('resolveIdentityEmission', () => {
  const verifiedClaim = (email: string | undefined, env: Record<string, string> = {}) =>
    resolveIdentityEmission({
      config: configWith({ GOOGLECHATBOT_ALLOWED_DOMAIN: 'openfort.xyz,other.example', ...env }),
      verified: true,
      userEmail: email
    })

  test('allows a verified sender on an allowlisted domain', () => {
    expect(verifiedClaim('Ada@Openfort.xyz')).toEqual({ emit: true, userEmail: 'Ada@Openfort.xyz' })
    expect(verifiedClaim('bob@other.example').emit).toBe(true)
  })

  // An unverified request's body is attacker-controllable: anyone able to POST
  // the webhook could claim any colleague's email.
  test('suppresses an unverified request even from an allowlisted domain', () => {
    const out = resolveIdentityEmission({
      config: configWith({ GOOGLECHATBOT_ALLOWED_DOMAIN: 'openfort.xyz' }),
      verified: false,
      userEmail: 'ada@openfort.xyz'
    })
    expect(out).toEqual({ emit: false, reason: 'unverified' })
  })

  test('suppresses a domain outside the allowlist', () => {
    expect(verifiedClaim('mallory@evil.example')).toEqual({
      emit: false,
      reason: 'domain_not_allowlisted'
    })
  })

  // GOOGLECHATBOT_ALLOWED_DOMAIN defaults to '' — that is "no domain may claim
  // an identity", not "every domain may".
  test('suppresses everything while the allowlist is empty', () => {
    expect(verifiedClaim('ada@openfort.xyz', { GOOGLECHATBOT_ALLOWED_DOMAIN: '' })).toEqual({
      emit: false,
      reason: 'allowlist_empty'
    })
  })

  test('suppresses a missing or malformed sender email', () => {
    expect(verifiedClaim(undefined).emit).toBe(false)
    expect(verifiedClaim('')).toEqual({ emit: false, reason: 'no_email' })
    expect(verifiedClaim('   ')).toEqual({ emit: false, reason: 'no_email' })
    expect(verifiedClaim('ada')).toEqual({ emit: false, reason: 'no_email' })
    expect(verifiedClaim('@openfort.xyz')).toEqual({ emit: false, reason: 'no_email' })
    // Multiple '@' is not an address we grant credentials from, even though the
    // 403 path's looser split() would read a domain out of it.
    expect(verifiedClaim('ada@evil.example@openfort.xyz')).toEqual({
      emit: false,
      reason: 'no_email'
    })
  })

  test('matches the domain case-insensitively on both sides', () => {
    expect(verifiedClaim('ada@OPENFORT.XYZ', { GOOGLECHATBOT_ALLOWED_DOMAIN: 'Openfort.XYZ' }).emit)
      .toBe(true)
  })
})

describe('resolveSessionIdentity', () => {
  const ALLOWLISTED = { GOOGLECHATBOT_ALLOWED_DOMAIN: 'openfort.xyz' }

  const CONFIRMED: SpaceDmConfirmation = { confirmed: true, spaceType: 'DIRECT_MESSAGE' }

  const resolve = async (
    opts: {
      claimedSpaceType?: ChatSpaceType
      confirmSpace?: () => Promise<SpaceDmConfirmation>
      env?: Record<string, string>
      userEmail?: string
      verified?: boolean
    } = {}
  ) =>
    resolveSessionIdentity({
      config: configWith({ ...ALLOWLISTED, ...opts.env }),
      verified: opts.verified ?? true,
      userEmail: opts.userEmail ?? 'ada@openfort.xyz',
      claimedSpaceType: opts.claimedSpaceType ?? 'DIRECT_MESSAGE',
      confirmSpace: opts.confirmSpace ?? (async () => CONFIRMED)
    })

  test('releases the email and Google’s space type for a confirmed DM', async () => {
    expect(await resolve()).toEqual({
      verified: true,
      spaceType: 'DIRECT_MESSAGE',
      email: { emit: true, userEmail: 'ada@openfort.xyz' }
    })
  })

  // The whole point of the gate: the request body's spaceType claim is not
  // signature-bound, so Google's contradicting answer wins outright — and it is
  // Google's answer, not the disbelieved claim, that gets reported.
  test('withholds the email when Google contradicts the body’s DM claim', async () => {
    expect(
      await resolve({
        confirmSpace: async () => ({ confirmed: false, reason: 'space_not_dm', spaceType: 'SPACE' })
      })
    ).toEqual({
      verified: true,
      spaceType: 'SPACE',
      email: { emit: false, reason: 'space_not_dm' }
    })
  })

  // Google said "not a DM" but named no usable type, so there is nothing better
  // than the body's claim to report. Harmless: api-rs cannot label without the
  // email, which is withheld.
  test('falls back to the body’s claim when Google names no usable space type', async () => {
    expect(
      await resolve({ confirmSpace: async () => ({ confirmed: false, reason: 'space_not_dm' }) })
    ).toEqual({
      verified: true,
      spaceType: 'DIRECT_MESSAGE',
      email: { emit: false, reason: 'space_not_dm' }
    })
  })

  test('withholds the email when Google could not be asked', async () => {
    expect(
      await resolve({
        confirmSpace: async () => ({ confirmed: false, reason: 'space_unverified' })
      })
    ).toMatchObject({ email: { emit: false, reason: 'space_unverified' } })
  })

  // Fail closed, and never let a Chat API failure escape into the turn.
  test('withholds rather than throwing when the confirmation itself throws', async () => {
    expect(
      await resolve({
        confirmSpace: async () => {
          throw new Error('Chat API GET spaces/AAAA failed: 500 internal')
        }
      })
    ).toMatchObject({ email: { emit: false, reason: 'space_unverified' } })
  })

  test.each(['GROUP_CHAT', 'SPACE'] as const)(
    'short-circuits a %s body without asking Google',
    async claimedSpaceType => {
      let asked = false
      const out = await resolve({
        claimedSpaceType,
        confirmSpace: async () => {
          asked = true
          return CONFIRMED
        }
      })
      // No lookup was made, so the body's own claim is what gets reported — it
      // is a gate input for api-rs, which cannot label without an email anyway.
      expect(out).toEqual({
        verified: true,
        spaceType: claimedSpaceType,
        email: { emit: false, reason: 'space_not_dm' }
      })
      expect(asked).toBe(false)
    }
  )

  // The pre-existing local reasons keep precedence, and cost no API call.
  test.each([
    ['unverified', { verified: false }],
    ['no_email', { userEmail: '' }],
    ['domain_not_allowlisted', { userEmail: 'mallory@evil.example' }],
    ['allowlist_empty', { env: { GOOGLECHATBOT_ALLOWED_DOMAIN: '' } }]
  ] as const)('still reports %s before any space lookup', async (reason, opts) => {
    let asked = false
    const out = await resolve({
      ...opts,
      confirmSpace: async () => {
        asked = true
        return CONFIRMED
      }
    })
    expect(out.email).toEqual({ emit: false, reason })
    expect(asked).toBe(false)
  })

  // `verified` reports what actually happened rather than what was allowed —
  // an unsigned request says so in the metadata instead of going unmentioned.
  test('reports the real verification state even when the email is withheld', async () => {
    expect(await resolve({ verified: false })).toEqual({
      verified: false,
      spaceType: 'DIRECT_MESSAGE',
      email: { emit: false, reason: 'unverified' }
    })
  })
})
