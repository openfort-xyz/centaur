import type { AppConfig } from '../config'
import { GOOGLE_CHAT_ISSUER, verifyGoogleSignedJwt, type KeyResolver } from './token'
import type { GoogleChatEnvelope } from './types'

export type ChatVerification =
  | { ok: true }
  | { ok: false; status: 400 | 401 | 403; reason: string }

/** Audiences a signed request token's `aud` claim may match (project number
 *  and/or endpoint URL, whichever the app is configured with). */
export function chatRequestAudiences(config: AppConfig): string[] {
  const audiences: string[] = []
  if (config.GOOGLECHATBOT_PROJECT_NUMBER) audiences.push(config.GOOGLECHATBOT_PROJECT_NUMBER)
  if (config.GOOGLECHATBOT_AUDIENCE) audiences.push(config.GOOGLECHATBOT_AUDIENCE)
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
  if (!config.GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS) return { ok: true }

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
      issuer: GOOGLE_CHAT_ISSUER,
      nowSeconds: opts.nowSeconds,
      resolveKey: opts.resolveKey
    })
  } catch {
    return { ok: false, status: 401, reason: 'key_resolution_failed' }
  }
  if (!result.ok) return { ok: false, status: 401, reason: result.reason }
  return { ok: true }
}

export function verifyChatRequest(opts: {
  config: AppConfig
  envelope: GoogleChatEnvelope
  nowSeconds?: number
}): ChatVerification {
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
