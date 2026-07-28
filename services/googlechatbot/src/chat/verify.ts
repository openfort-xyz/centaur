import type { AppConfig } from '../config'
import type { SpaceDmConfirmation } from './space-verify'
import { GOOGLE_REQUEST_ISSUERS, verifyGoogleSignedJwt, type KeyResolver } from './token'
import type { ChatSpaceType, GoogleChatEnvelope } from './types'

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

/** Why a session was created without identity metadata. Every suppression is
 * reported with one of these so "my credential did not attach" is answerable
 * from the logs. */
export type IdentitySuppressionReason =
  | 'unverified'
  | 'no_email'
  | 'allowlist_empty'
  | 'domain_not_allowlisted'
  /** Google was asked about the space and did not answer "1:1 DM" — or the
   * request body did not even claim one, so Google was never asked. */
  | 'space_not_dm'
  /** Google could not be asked at all (Chat API error, non-200, timeout). */
  | 'space_unverified'

export type IdentityEmission =
  | { emit: true; userEmail: string }
  | { emit: false; reason: IdentitySuppressionReason }

/**
 * Decide whether an event may claim a human identity for the session it starts.
 *
 * Downstream, centaur labels the DM principal from that identity and
 * auto-grants the named person's OAuth credentials (Gmail, GitHub, …) to every
 * session in the room, so this gate is a credential-grant decision, not a
 * display concern. It fails closed for credentials only — the caller still
 * processes the chat event normally when identity is suppressed.
 *
 * Both conditions must hold:
 *  - the request carried a valid Google signature (`verified`), and
 *  - the email the identity is actually derived from sits in a non-empty
 *    GOOGLECHATBOT_ALLOWED_DOMAIN.
 *
 * An empty allowlist is a suppression reason, never a wildcard: the default is
 * '' (off), and "unset" must not mean "any domain may claim any identity".
 *
 * Note this validates the SENDER email the identity is built from, which is not
 * necessarily the `envelope.user.email` verifyChatRequest hard-rejects on — the
 * two fields differ, and only this one reaches the session metadata.
 */
export function resolveIdentityEmission(opts: {
  config: AppConfig
  verified: boolean
  userEmail: string | undefined
}): IdentityEmission {
  if (!opts.verified) return { emit: false, reason: 'unverified' }

  const email = (opts.userEmail ?? '').trim()
  // Stricter than the 403 path's `split('@')[1]`: an address that is not
  // exactly local@domain is not something to grant credentials from.
  const parts = email.split('@')
  const domain = parts.length === 2 ? (parts[1] ?? '').toLowerCase() : ''
  if (!parts[0] || !domain) return { emit: false, reason: 'no_email' }

  const allowedDomains = opts.config.GOOGLECHATBOT_ALLOWED_DOMAIN
  if (allowedDomains.length === 0) return { emit: false, reason: 'allowlist_empty' }
  if (!allowedDomains.some(allowed => allowed.toLowerCase() === domain)) {
    return { emit: false, reason: 'domain_not_allowlisted' }
  }

  return { emit: true, userEmail: email }
}

/** An emission that additionally carries the space as GOOGLE described it. The
 * space values are Google's, never the envelope's — the envelope's exist only
 * as a pre-filter. */
export type ConfirmedIdentityEmission =
  | { emit: true; userEmail: string; spaceType: ChatSpaceType; singleUserBotDm: boolean }
  | { emit: false; reason: IdentitySuppressionReason }

/**
 * resolveIdentityEmission plus the one thing the request body cannot be trusted
 * for: that the space really is a 1:1 DM.
 *
 * Google's signed request token verifies iss/aud/exp/signature but binds
 * NOTHING in the body, so a valid token can carry an envelope that names a
 * shared room while claiming `spaceType: DIRECT_MESSAGE` and a colleague's
 * address. Labelling that room's principal with that person would hand their
 * live OAuth credentials to everyone in it. So the DM-ness is re-asked of
 * Google, and only Google's answer counts.
 *
 * Order is deliberate and cost-ordered:
 *  1. the existing local checks (signature, sender domain) — free, and their
 *     reasons keep precedence so an unsigned request still reports `unverified`;
 *  2. the envelope's own `spaceType` as a pre-filter — a body that does not even
 *     claim a DM is suppressed without spending a Chat API call. Necessary,
 *     never sufficient;
 *  3. Google's answer, which is the only one that can grant emission.
 *
 * Fails closed for credentials, open for chat: a Chat API failure suppresses
 * identity and is reported, but never throws at the caller, whose turn proceeds.
 */
export async function resolveConfirmedIdentityEmission(opts: {
  config: AppConfig
  verified: boolean
  userEmail: string | undefined
  /** spaceType AS CLAIMED BY THE REQUEST BODY. Attacker-controllable; used only
   * to skip the API call for events that are obviously not DMs. */
  claimedSpaceType: ChatSpaceType
  confirmSpace: () => Promise<SpaceDmConfirmation>
}): Promise<ConfirmedIdentityEmission> {
  const local = resolveIdentityEmission(opts)
  if (!local.emit) return local

  if (opts.claimedSpaceType !== 'DIRECT_MESSAGE') return { emit: false, reason: 'space_not_dm' }

  let confirmation: SpaceDmConfirmation
  try {
    confirmation = await opts.confirmSpace()
  } catch {
    // The verifier already fails closed on its own; this is the belt-and-braces
    // case where it (or a future one) throws anyway.
    return { emit: false, reason: 'space_unverified' }
  }
  if (!confirmation.confirmed) return { emit: false, reason: confirmation.reason }

  return {
    emit: true,
    userEmail: local.userEmail,
    spaceType: confirmation.spaceType,
    singleUserBotDm: confirmation.singleUserBotDm
  }
}
