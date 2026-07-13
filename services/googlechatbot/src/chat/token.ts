// Inbound request authentication for the Google Chat webhook.
//
// Google Chat signs every event it POSTs to an app's HTTP endpoint with a
// bearer JWT in the `Authorization` header (RS256, issued by the Chat app's
// service account). Verifying that token is the only way to prove a request
// actually came from Google — the event body (including `user.email`) is
// entirely attacker-controllable, so the domain allowlist in verify.ts is not
// an authentication control on its own.
//
// This module verifies the JWT with Web Crypto (RSASSA-PKCS1-v1_5 / SHA-256),
// mirroring the outbound `createJWT` in chat/client.ts so we add no new deps.
// https://developers.google.com/workspace/chat/authenticate-user

/** Issuer Google Chat stamps on the bearer token it sends to app endpoints. */
export const GOOGLE_CHAT_ISSUER = 'chat@system.gserviceaccount.com'

/** JWK set holding the public keys that sign Google Chat's request tokens. */
const GOOGLE_CHAT_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com'

export type JwtVerifyResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: string }

/** Resolves the verification key for a JWT `kid` (null when unknown). */
export type KeyResolver = (kid: string | undefined) => Promise<CryptoKey | null>

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string }
type JwkSet = { keys?: Jwk[] }

function base64urlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64urlToBytes(segment))) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Verify a compact JWS bearer token against a resolved RSA public key.
 *
 * Checks, in order: structural shape, `alg === RS256`, signature over
 * `header.payload`, issuer, audience membership, and `exp`/`iat` freshness
 * (with a small clock-skew tolerance). Returns a typed failure reason instead
 * of throwing so the caller can log it and answer Google with a 401.
 */
export async function verifyGoogleSignedJwt(opts: {
  token: string
  audiences: string[]
  issuer?: string
  nowSeconds?: number
  clockSkewSeconds?: number
  resolveKey: KeyResolver
}): Promise<JwtVerifyResult> {
  const parts = opts.token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed_token' }
  const [headerB64, payloadB64, signatureB64] = parts
  if (!headerB64 || !payloadB64 || !signatureB64) return { ok: false, reason: 'malformed_token' }

  const header = decodeJsonSegment(headerB64)
  const payload = decodeJsonSegment(payloadB64)
  if (!header || !payload) return { ok: false, reason: 'malformed_token' }
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported_alg' }

  const kid = typeof header.kid === 'string' ? header.kid : undefined
  const key = await opts.resolveKey(kid)
  if (!key) return { ok: false, reason: 'unknown_key' }

  let signature: Uint8Array<ArrayBuffer>
  try {
    signature = base64urlToBytes(signatureB64)
  } catch {
    return { ok: false, reason: 'malformed_token' }
  }
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput)
  if (!valid) return { ok: false, reason: 'bad_signature' }

  const issuer = opts.issuer ?? GOOGLE_CHAT_ISSUER
  if (payload.iss !== issuer) return { ok: false, reason: 'issuer_mismatch' }

  if (typeof payload.aud !== 'string' || !opts.audiences.includes(payload.aud)) {
    return { ok: false, reason: 'audience_mismatch' }
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const skew = opts.clockSkewSeconds ?? 30
  if (typeof payload.exp === 'number' && now > payload.exp + skew) {
    return { ok: false, reason: 'token_expired' }
  }
  if (typeof payload.iat === 'number' && payload.iat > now + skew) {
    return { ok: false, reason: 'token_not_yet_valid' }
  }

  return { ok: true, claims: payload }
}

async function importJwk(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  )
}

function parseMaxAgeSeconds(cacheControl: string | null): number | null {
  if (!cacheControl) return null
  const match = /max-age=(\d+)/i.exec(cacheControl)
  return match ? Number(match[1]) : null
}

/**
 * Build a {@link KeyResolver} backed by Google's Chat JWK set, caching the
 * imported keys until the `Cache-Control: max-age` Google returns (default 1h).
 * Cache is per-resolver, so the bot creates one at startup and reuses it.
 */
export function googleChatKeyResolver(opts?: {
  fetchImpl?: typeof fetch
  nowMs?: () => number
  jwksUrl?: string
  fetchTimeoutMs?: number
}): KeyResolver {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const nowMs = opts?.nowMs ?? (() => Date.now())
  const url = opts?.jwksUrl ?? GOOGLE_CHAT_JWKS_URL
  const timeoutMs = opts?.fetchTimeoutMs ?? 5000

  let cache: { keys: Map<string, CryptoKey>; expiresAt: number } | null = null

  async function refresh(): Promise<void> {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`jwks_fetch_failed_${res.status}`)
    const body = (await res.json()) as JwkSet
    const keys = new Map<string, CryptoKey>()
    for (const jwk of body.keys ?? []) {
      if (jwk.kid && jwk.n && jwk.e) keys.set(jwk.kid, await importJwk(jwk))
    }
    const maxAge = parseMaxAgeSeconds(res.headers.get('cache-control')) ?? 3600
    cache = { keys, expiresAt: nowMs() + maxAge * 1000 }
  }

  return async kid => {
    if (!cache || nowMs() >= cache.expiresAt) await refresh()
    const keys = cache?.keys
    if (!keys) return null
    if (kid) return keys.get(kid) ?? null
    // A token without a `kid` is only resolvable when the set has one key.
    return keys.size === 1 ? ([...keys.values()][0] ?? null) : null
  }
}
