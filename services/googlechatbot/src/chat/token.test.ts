import { test, expect, describe, beforeAll } from 'bun:test'
import {
  GOOGLE_CHAT_ISSUER,
  GOOGLE_REQUEST_ISSUERS,
  googleChatKeyResolver,
  googleRequestKeyResolver,
  verifyGoogleSignedJwt
} from './token'
import { base64url, generateRsaKeyPair, signJwt, staticKeyResolver } from './test-jwt'

const KID = 'test-key-1'
const AUD = '734836800829'
const NOW = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)

let pair: CryptoKeyPair
let resolveKey: ReturnType<typeof staticKeyResolver>

beforeAll(async () => {
  pair = await generateRsaKeyPair()
  resolveKey = staticKeyResolver(KID, pair.publicKey)
})

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: GOOGLE_CHAT_ISSUER, aud: AUD, iat: NOW, exp: NOW + 300, ...overrides }
}

describe('verifyGoogleSignedJwt', () => {
  test('accepts a well-formed, correctly-signed Google Chat token', async () => {
    const token = await signJwt({ privateKey: pair.privateKey, kid: KID, claims: claims() })
    const out = await verifyGoogleSignedJwt({ token, audiences: [AUD], allowedIssuers: [GOOGLE_CHAT_ISSUER], nowSeconds: NOW, resolveKey })
    expect(out.ok).toBe(true)
  })

  test('rejects a token minted for a different audience', async () => {
    const token = await signJwt({ privateKey: pair.privateKey, kid: KID, claims: claims({ aud: 'someone-else' }) })
    const out = await verifyGoogleSignedJwt({ token, audiences: [AUD], allowedIssuers: [GOOGLE_CHAT_ISSUER], nowSeconds: NOW, resolveKey })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toMatch(/^audience_mismatch\(aud=someone-else\)$/)
  })

  test('rejects a token from the wrong issuer', async () => {
    const token = await signJwt({ privateKey: pair.privateKey, kid: KID, claims: claims({ iss: 'attacker@evil.example' }) })
    const out = await verifyGoogleSignedJwt({ token, audiences: [AUD], allowedIssuers: [GOOGLE_CHAT_ISSUER], nowSeconds: NOW, resolveKey })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toMatch(/^issuer_mismatch\(iss=attacker@evil\.example\)$/)
  })

  test('rejects an expired token', async () => {
    const token = await signJwt({ privateKey: pair.privateKey, kid: KID, claims: claims({ exp: NOW - 600 }) })
    const out = await verifyGoogleSignedJwt({ token, audiences: [AUD], allowedIssuers: [GOOGLE_CHAT_ISSUER], nowSeconds: NOW, resolveKey })
    expect(out).toEqual({ ok: false, reason: 'token_expired' })
  })

  test('rejects a token signed by an unrelated key (forged signature)', async () => {
    const attacker = await generateRsaKeyPair()
    const token = await signJwt({ privateKey: attacker.privateKey, kid: KID, claims: claims() })
    const out = await verifyGoogleSignedJwt({ token, audiences: [AUD], allowedIssuers: [GOOGLE_CHAT_ISSUER], nowSeconds: NOW, resolveKey })
    expect(out).toEqual({ ok: false, reason: 'bad_signature' })
  })

  test('rejects a tampered payload', async () => {
    const token = await signJwt({ privateKey: pair.privateKey, kid: KID, claims: claims() })
    const [h, , s] = token.split('.')
    const forged = `${h}.${base64url(JSON.stringify(claims({ aud: AUD, sub: 'escalated' })))}.${s}`
    const out = await verifyGoogleSignedJwt({ token: forged, audiences: [AUD], allowedIssuers: [GOOGLE_CHAT_ISSUER], nowSeconds: NOW, resolveKey })
    expect(out).toEqual({ ok: false, reason: 'bad_signature' })
  })

  test('rejects the alg=none downgrade', async () => {
    const token = await signJwt({ privateKey: pair.privateKey, kid: KID, alg: 'none', claims: claims() })
    const out = await verifyGoogleSignedJwt({ token, audiences: [AUD], allowedIssuers: [GOOGLE_CHAT_ISSUER], nowSeconds: NOW, resolveKey })
    expect(out).toEqual({ ok: false, reason: 'unsupported_alg' })
  })

  test('rejects a token whose kid is unknown', async () => {
    const token = await signJwt({ privateKey: pair.privateKey, kid: 'rotated-out', claims: claims() })
    const out = await verifyGoogleSignedJwt({ token, audiences: [AUD], allowedIssuers: [GOOGLE_CHAT_ISSUER], nowSeconds: NOW, resolveKey })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toMatch(/^unknown_key\(kid=rotated-out,iss=/)
  })

  test('rejects a structurally malformed token', async () => {
    const out = await verifyGoogleSignedJwt({ token: 'not-a-jwt', audiences: [AUD], allowedIssuers: [GOOGLE_CHAT_ISSUER], nowSeconds: NOW, resolveKey })
    expect(out).toEqual({ ok: false, reason: 'malformed_token' })
  })

  test('accepts either configured audience (project number OR url model)', async () => {
    const url = 'https://chat-centaur.fort.dev/api/chat/events'
    const token = await signJwt({ privateKey: pair.privateKey, kid: KID, claims: claims({ aud: url }) })
    const out = await verifyGoogleSignedJwt({ token, audiences: [AUD, url], allowedIssuers: [GOOGLE_CHAT_ISSUER], nowSeconds: NOW, resolveKey })
    expect(out.ok).toBe(true)
  })
})

describe('googleChatKeyResolver', () => {
  test('imports the JWK set, caches it, and resolves by kid', async () => {
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    let fetches = 0
    const fetchImpl = (async () => {
      fetches++
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] }), {
        status: 200,
        headers: { 'cache-control': 'public, max-age=3600' }
      })
    }) as unknown as typeof fetch

    const resolver = googleChatKeyResolver({ fetchImpl, nowMs: () => 0 })
    const first = await resolver(KID)
    const second = await resolver(KID)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(fetches).toBe(1) // second call served from cache
    expect(await resolver('unknown-kid')).toBeNull()

    // A real signed token verifies against the resolver-imported public key.
    const token = await signJwt({ privateKey: pair.privateKey, kid: KID, claims: claims() })
    const out = await verifyGoogleSignedJwt({ token, audiences: [AUD], allowedIssuers: [GOOGLE_CHAT_ISSUER], nowSeconds: NOW, resolveKey: resolver })
    expect(out.ok).toBe(true)
  })
})

describe('googleRequestKeyResolver (both token models)', () => {
  const SA_KID = 'sa-key'
  const OIDC_KID = 'oidc-key'
  const URL_AUD = 'https://chat-centaur.fort.dev/api/chat/events'
  let saPair: CryptoKeyPair
  let oidcPair: CryptoKeyPair

  beforeAll(async () => {
    saPair = await generateRsaKeyPair()
    oidcPair = await generateRsaKeyPair()
  })

  // Serve the SA JWK set on the SA URL and Google's OIDC certs on the oauth2 URL.
  function routedFetch(): typeof fetch {
    return (async (url: string) => {
      const jwk = async (kid: string, pub: CryptoKey) => ({
        ...(await crypto.subtle.exportKey('jwk', pub)),
        kid,
        alg: 'RS256',
        use: 'sig'
      })
      const set = String(url).includes('oauth2/v3/certs')
        ? { keys: [await jwk(OIDC_KID, oidcPair.publicKey)] }
        : { keys: [await jwk(SA_KID, saPair.publicKey)] }
      return new Response(JSON.stringify(set), {
        status: 200,
        headers: { 'cache-control': 'max-age=3600' }
      })
    }) as unknown as typeof fetch
  }

  test('accepts the OIDC app-URL token (iss=accounts.google.com) via oauth2 certs', async () => {
    const resolveKey = googleRequestKeyResolver({ fetchImpl: routedFetch(), nowMs: () => 0 })
    const token = await signJwt({
      privateKey: oidcPair.privateKey,
      kid: OIDC_KID,
      claims: { iss: 'https://accounts.google.com', aud: URL_AUD, iat: NOW, exp: NOW + 300 }
    })
    const out = await verifyGoogleSignedJwt({
      token,
      audiences: [URL_AUD],
      allowedIssuers: GOOGLE_REQUEST_ISSUERS,
      nowSeconds: NOW,
      resolveKey
    })
    expect(out.ok).toBe(true)
  })

  test('accepts the SA project-number token (iss=chat@system) via the SA set', async () => {
    const resolveKey = googleRequestKeyResolver({ fetchImpl: routedFetch(), nowMs: () => 0 })
    const token = await signJwt({
      privateKey: saPair.privateKey,
      kid: SA_KID,
      claims: { iss: GOOGLE_CHAT_ISSUER, aud: '734836800829', iat: NOW, exp: NOW + 300 }
    })
    const out = await verifyGoogleSignedJwt({
      token,
      audiences: ['734836800829'],
      allowedIssuers: GOOGLE_REQUEST_ISSUERS,
      nowSeconds: NOW,
      resolveKey
    })
    expect(out.ok).toBe(true)
  })

  test('rejects an OIDC-issuer token signed with the SA key (wrong set → bad_signature/unknown)', async () => {
    const resolveKey = googleRequestKeyResolver({ fetchImpl: routedFetch(), nowMs: () => 0 })
    // iss says OIDC (routes to oauth2 certs) but signed by the SA key with the SA kid.
    const token = await signJwt({
      privateKey: saPair.privateKey,
      kid: SA_KID,
      claims: { iss: 'https://accounts.google.com', aud: URL_AUD, iat: NOW, exp: NOW + 300 }
    })
    const out = await verifyGoogleSignedJwt({
      token,
      audiences: [URL_AUD],
      allowedIssuers: GOOGLE_REQUEST_ISSUERS,
      nowSeconds: NOW,
      resolveKey
    })
    expect(out.ok).toBe(false)
  })
})
