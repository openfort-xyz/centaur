import type { AppConfig } from '../config'
import { GOOGLE_REQUEST_ISSUERS, verifyGoogleSignedJwt, type KeyResolver } from './token'
import type { GoogleChatEnvelope } from './types'

type ChatVerificationFailure = { ok: false; status: 400 | 401 | 403; reason: string }

/**
 * Outcome of authenticating an inbound request.
 *
 * `ok` only says the request may be PROCESSED. `verified` says a Google
 * signature was actually checked — the two differ on every request while
 * GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS is off, where the check is skipped
 * entirely. Anything that grants trust from the request body (identity
 * metadata, and through it the requester's OAuth credentials) MUST read
 * `verified`; deriving trust from `ok` treats a skipped check as a passed one.
 */
export type ChatVerification = { ok: true; verified: boolean } | ChatVerificationFailure

/**
 * Outcome of the envelope-shape checks (domain allowlist, event freshness).
 * These say nothing about authenticity — the envelope is attacker-controllable
 * without a signature — so this result deliberately carries no `verified` field
 * that could be mistaken for one.
 */
export type ChatEnvelopeCheck = { ok: true } | ChatVerificationFailure

/** Audiences a signed request token's `aud` claim may match (project number
 *  and/or endpoint URL, whichever the app is configured with). */
export function chatRequestAudiences(config: AppConfig): string[] {
  const audiences: string[] = []
  if (config.GOOGLECHATBOT_PROJECT_NUMBER) audiences.push(config.GOOGLECHATBOT_PROJECT_NUMBER)
  if (config.GOOGLECHATBOT_WEBHOOK_AUDIENCE) audiences.push(config.GOOGLECHATBOT_WEBHOOK_AUDIENCE)
  return audiences
}

/**
 * Authenticate an inbound webhook request by verifying Google Chat's signed
 * bearer JWT. When GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS is off this is a no-op
 * (preserving legacy behavior — the rollback switch); when on, a request
 * without a valid, correctly-audienced, unexpired Google-signed token is
 * rejected with 401. Any key-resolution/network failure fails closed.
 */
export async function verifyChatRequestToken(opts: {
  config: AppConfig
  authorization: string | undefined
  resolveKey: KeyResolver
  nowSeconds?: number
}): Promise<ChatVerification> {
  const { config } = opts
  // Skipped, not passed: the request is processed but nothing about it was
  // authenticated, so it can never source identity metadata.
  if (!config.GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS) return { ok: true, verified: false }

  const audiences = chatRequestAudiences(config)
  if (audiences.length === 0) {
    // Enforcement requested but no audience to validate `aud` against: fail
    // closed rather than accept a token minted for someone else's endpoint.
    return { ok: false, status: 401, reason: 'audience_not_configured' }
  }

  const match = /^Bearer\s+(.+)$/i.exec((opts.authorization ?? '').trim())
  const token = match?.[1]?.trim()
  if (!token) return { ok: false, status: 401, reason: 'missing_bearer_token' }

  let result: Awaited<ReturnType<typeof verifyGoogleSignedJwt>>
  try {
    result = await verifyGoogleSignedJwt({
      token,
      audiences,
      allowedIssuers: GOOGLE_REQUEST_ISSUERS,
      nowSeconds: opts.nowSeconds,
      resolveKey: opts.resolveKey
    })
  } catch {
    return { ok: false, status: 401, reason: 'key_resolution_failed' }
  }
  if (!result.ok) return { ok: false, status: 401, reason: result.reason }
  return { ok: true, verified: true }
}

export function verifyChatRequest(opts: {
  config: AppConfig
  envelope: GoogleChatEnvelope
  nowSeconds?: number
}): ChatEnvelopeCheck {
  const allowedDomains = opts.config.GOOGLECHATBOT_ALLOWED_DOMAIN
  if (allowedDomains.length > 0 && opts.envelope.user?.email) {
    const domain = opts.envelope.user.email.split('@')[1]
    if (domain && !allowedDomains.includes(domain.toLowerCase())) {
      return { ok: false, status: 403, reason: 'domain_not_allowlisted' }
    }
  }

  const eventTime = opts.envelope.eventTime
  if (eventTime) {
    const eventMs = new Date(eventTime).getTime()
    if (!Number.isFinite(eventMs)) {
      return { ok: false, status: 400, reason: 'invalid_event_timestamp' }
    }
    const now = (opts.nowSeconds ?? Math.floor(Date.now() / 1000)) * 1000
    const maxAgeMs = opts.config.CHAT_EVENT_MAX_AGE_SECONDS * 1000
    if (Math.abs(now - eventMs) > maxAgeMs) {
      return { ok: false, status: 401, reason: 'stale_event_timestamp' }
    }
  }

  return { ok: true }
}
