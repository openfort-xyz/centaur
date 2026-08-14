// Inbound request authentication for the Google Chat webhook.
//
// Google Chat signs every event it POSTs to an app's HTTP endpoint with a
// bearer JWT in the `Authorization` header. The event body is not bound to that
// token and is attacker-controllable, so verifying the request token is
// the only way to prove a request actually came from Google.
//
// Google Chat uses ONE OF TWO token models depending on the app's configured
// "Authentication audience" (Chat API config -> Connection settings):
//   - App URL model  -> a Google OIDC ID token: iss `https://accounts.google.com`
//     (or `accounts.google.com`), `aud` = the endpoint URL, signed by Google's
//     OAuth2 certs (oauth2/v3/certs).
//   - Project number -> a self-signed JWT: iss `chat@system.gserviceaccount.com`,
//     `aud` = the app's Cloud project number, signed by that SA's JWK set.
// The caller selects exactly one contract and supplies its paired issuer,
// audience, and JWK route. The generic verifier can validate either model but
// never treats them as an interchangeable issuer/audience cross-product.
// Web Crypto (RSASSA-PKCS1-v1_5 / SHA-256), no new deps.
// https://developers.google.com/workspace/chat/verify-requests-from-chat

/** Self-signed-JWT model issuer (audience = project number). */
export const GOOGLE_CHAT_SA_ISSUER = 'chat@system.gserviceaccount.com'
/** OIDC ID-token model issuers (audience = app endpoint URL). */
export const GOOGLE_OIDC_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
/** Every issuer we accept, in one list. */
export const GOOGLE_REQUEST_ISSUERS = [GOOGLE_CHAT_SA_ISSUER, ...GOOGLE_OIDC_ISSUERS]

const GOOGLE_CHAT_SA_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com'
const GOOGLE_OIDC_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

export type JwtVerifyResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: string }

/** Resolves the verification key for a JWT (`kid`, `iss`); null when unknown.
 *  `iss` lets a resolver route to the right JWK set; single-set resolvers ignore it. */
export type KeyResolver = (
  kid: string | undefined,
  iss?: string | undefined
) => Promise<CryptoKey | null>

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string }
type JwkSet = { keys?: Jwk[] }

function base64urlToBytes(input: string): Uint8Array<ArrayBuffer> {
  // Copied out of the Buffer so the bytes are backed by a plain ArrayBuffer,
  // which is what crypto.subtle's BufferSource requires.
  return Uint8Array.from(Buffer.from(input, 'base64url'))
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
 * Order: structural shape, `alg === RS256`, issuer allow-list (selects the JWK
 * set), signature over `header.payload`, audience membership, `exp`/`iat`
 * freshness. The issuer is checked before key resolution only to pick the JWK
 * set — the signature is then verified against that set's key, so a forged `iss`
 * cannot bypass anything. Returns a typed failure reason (with the non-secret
 * observed kid/iss/aud embedded) instead of throwing, so the caller can log it
 * and answer Google with a 401.
 */
export async function verifyGoogleSignedJwt(opts: {
  token: string
  audiences: string[]
  allowedIssuers: string[]
  maxAgeSeconds?: number
  nowSeconds?: number
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

  const iss = typeof payload.iss === 'string' ? payload.iss : undefined
  if (!iss || !opts.allowedIssuers.includes(iss)) {
    return { ok: false, reason: `issuer_mismatch(iss=${String(payload.iss)})` }
  }

  const kid = typeof header.kid === 'string' ? header.kid : undefined
  const key = await opts.resolveKey(kid, iss)
  if (!key) return { ok: false, reason: `unknown_key(kid=${String(kid)},iss=${iss})` }

  const signature = base64urlToBytes(signatureB64)
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput)
  if (!valid) return { ok: false, reason: 'bad_signature' }

  if (typeof payload.aud !== 'string' || !opts.audiences.includes(payload.aud)) {
    // Surface the observed audience so a wrong PROJECT_NUMBER/WEBHOOK_AUDIENCE is
    // obvious in logs when enforcement rejects a real event (aud is not secret).
    return { ok: false, reason: `audience_mismatch(aud=${String(payload.aud)})` }
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const skew = 30
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    return { ok: false, reason: 'invalid_iat' }
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    return { ok: false, reason: 'invalid_exp' }
  }
  if (payload.exp <= payload.iat) return { ok: false, reason: 'invalid_token_lifetime' }
  if (now > payload.exp + skew) {
    return { ok: false, reason: 'token_expired' }
  }
  if (payload.iat > now + skew) {
    return { ok: false, reason: 'token_not_yet_valid' }
  }
  if (now > payload.iat + (opts.maxAgeSeconds ?? 300) + skew) {
    return { ok: false, reason: 'token_too_old' }
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
 * A single-JWK-set resolver, caching imported keys until the JWK set's
 * `Cache-Control: max-age` (default 1h). Ignores `iss` (the caller routes by
 * issuer).
 */
function jwksKeyResolver(opts: {
  jwksUrl: string
  fetchImpl?: typeof fetch
  nowMs?: () => number
}): KeyResolver {
  const fetchImpl = opts.fetchImpl ?? fetch
  const nowMs = opts.nowMs ?? (() => Date.now())
  const url = opts.jwksUrl

  let cache: { keys: Map<string, CryptoKey>; expiresAt: number } | null = null

  async function refresh(): Promise<void> {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
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

/**
 * Resolver for inbound Google Chat request tokens, routing to the correct JWK
 * set by issuer: the `chat@system` SA set for the project-number model, and
 * Google's OAuth2 certs for the OIDC (app-URL) model. Each set is cached
 * independently. The bot builds one at startup and reuses it.
 */
export function googleRequestKeyResolver(opts?: {
  fetchImpl?: typeof fetch
  nowMs?: () => number
}): KeyResolver {
  const sa = jwksKeyResolver({ jwksUrl: GOOGLE_CHAT_SA_JWKS_URL, ...opts })
  const oidc = jwksKeyResolver({ jwksUrl: GOOGLE_OIDC_JWKS_URL, ...opts })
  return async (kid, iss) => {
    if (iss === GOOGLE_CHAT_SA_ISSUER) return sa(kid, iss)
    if (iss && GOOGLE_OIDC_ISSUERS.includes(iss)) return oidc(kid, iss)
    return null
  }
}
