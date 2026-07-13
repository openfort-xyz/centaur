// Test-only helpers for minting RS256 JWTs with a locally generated key, so
// the request-token verification can be exercised end-to-end without touching
// Google's JWK endpoint. Not imported by the server (filename has no `.test.`).
import type { KeyResolver } from './token'

export function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )
}

/** A KeyResolver that returns `publicKey` for the given `kid`, null otherwise. */
export function staticKeyResolver(kid: string, publicKey: CryptoKey): KeyResolver {
  return async requestedKid => (requestedKid === kid ? publicKey : null)
}

export async function signJwt(opts: {
  privateKey: CryptoKey
  claims: Record<string, unknown>
  kid?: string
  alg?: string
}): Promise<string> {
  const header = base64url(JSON.stringify({ alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid }))
  const payload = base64url(JSON.stringify(opts.claims))
  const signingInput = `${header}.${payload}`
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      opts.privateKey,
      new TextEncoder().encode(signingInput)
    )
  )
  return `${signingInput}.${base64url(signature)}`
}
