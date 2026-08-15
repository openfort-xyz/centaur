import type { AppConfig } from '../config'
import type { SpaceDmConfirmation } from './space-verify'
import {
  GOOGLE_CHAT_SA_ISSUER,
  GOOGLE_OIDC_ISSUERS,
  verifyGoogleSignedJwt,
  type KeyResolver
} from './token'
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
export type ChatVerification =
  | { ok: true; verified: boolean; userEmail?: string; userId?: string }
  | ChatVerificationFailure

/**
 * Outcome of the envelope-shape checks (domain allowlist, event freshness).
 * These say nothing about authenticity — the envelope is attacker-controllable
 * without a signature — so this result deliberately carries no `verified` field
 * that could be mistaken for one.
 */
export type ChatEnvelopeCheck = { ok: true } | ChatVerificationFailure

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
  userIdToken?: string
  resolveKey: KeyResolver
  nowSeconds?: number
}): Promise<ChatVerification> {
  const { config } = opts
  // Skipped, not passed: the request is processed but nothing about it was
  // authenticated, so it can never source identity metadata.
  if (!config.GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS) return { ok: true, verified: false }

  const mode = config.GOOGLECHATBOT_INGRESS_MODE
  const audience = mode === 'chat_api_project'
    ? config.GOOGLECHATBOT_PROJECT_NUMBER
    : config.GOOGLECHATBOT_WEBHOOK_AUDIENCE
  if (!audience) return { ok: false, status: 401, reason: 'audience_not_configured' }
  const allowedIssuers = mode === 'chat_api_project'
    ? [GOOGLE_CHAT_SA_ISSUER]
    : GOOGLE_OIDC_ISSUERS
  const expectedSignerEmail = mode === 'chat_api_url'
    ? GOOGLE_CHAT_SA_ISSUER
    : mode === 'workspace_addon'
      ? config.GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL
      : undefined
  if (mode === 'workspace_addon' && !expectedSignerEmail) {
    return { ok: false, status: 401, reason: 'addon_signer_email_not_configured' }
  }

  const match = /^Bearer\s+(.+)$/i.exec((opts.authorization ?? '').trim())
  const token = match?.[1]?.trim()
  if (!token) return { ok: false, status: 401, reason: 'missing_bearer_token' }

  let result: Awaited<ReturnType<typeof verifyGoogleSignedJwt>>
  try {
    result = await verifyGoogleSignedJwt({
      token,
      audiences: [audience],
      allowedIssuers,
      maxAgeSeconds: config.GOOGLECHATBOT_SIGNED_REQUEST_MAX_AGE_SECONDS,
      nowSeconds: opts.nowSeconds,
      resolveKey: opts.resolveKey
    })
  } catch {
    return { ok: false, status: 401, reason: 'key_resolution_failed' }
  }
  if (!result.ok) return { ok: false, status: 401, reason: result.reason }
  if (expectedSignerEmail) {
    if (result.claims.email_verified !== true) {
      return { ok: false, status: 401, reason: 'signer_email_not_verified' }
    }
    if (result.claims.email !== expectedSignerEmail) {
      return { ok: false, status: 401, reason: 'signer_email_mismatch' }
    }
  }

  if (mode !== 'workspace_addon' || !opts.userIdToken) {
    return { ok: true, verified: true }
  }
  if (!config.GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID) {
    return { ok: false, status: 401, reason: 'addon_oauth_client_id_not_configured' }
  }
  let userResult: Awaited<ReturnType<typeof verifyGoogleSignedJwt>>
  try {
    userResult = await verifyGoogleSignedJwt({
      token: opts.userIdToken,
      audiences: [config.GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID],
      allowedIssuers: GOOGLE_OIDC_ISSUERS,
      maxAgeSeconds: config.GOOGLECHATBOT_SIGNED_REQUEST_MAX_AGE_SECONDS,
      nowSeconds: opts.nowSeconds,
      resolveKey: opts.resolveKey
    })
  } catch {
    return { ok: false, status: 401, reason: 'user_token_key_resolution_failed' }
  }
  if (!userResult.ok) {
    return { ok: false, status: 401, reason: `user_token_${userResult.reason}` }
  }
  if (userResult.claims.email_verified !== true || typeof userResult.claims.email !== 'string') {
    return { ok: false, status: 401, reason: 'user_email_not_verified' }
  }
  if (typeof userResult.claims.sub !== 'string' || !userResult.claims.sub.trim()) {
    return { ok: false, status: 401, reason: 'user_id_not_verified' }
  }
  return {
    ok: true,
    verified: true,
    userEmail: userResult.claims.email,
    userId: userResult.claims.sub
  }
}

export function verifyChatRequest(opts: {
  config: AppConfig
  envelope: GoogleChatEnvelope
  userEmail?: string
  userId?: string
  nowSeconds?: number
}): ChatEnvelopeCheck {
  if (opts.userId) {
    const envelopeUser = opts.envelope.message?.sender?.name ?? opts.envelope.user?.name
    if (envelopeUser !== opts.userId && envelopeUser !== `users/${opts.userId}`) {
      return { ok: false, status: 401, reason: 'user_id_mismatch' }
    }
  }
  const allowedDomains = opts.config.GOOGLECHATBOT_ALLOWED_DOMAIN
  if (allowedDomains.length > 0) {
    // Chat Event User resources have no email. Only a separately verified
    // Workspace Add-on userIdToken can satisfy an email-domain policy.
    const emailParts = (opts.userEmail ?? '').trim().split('@')
    const domain = emailParts.length === 2 ? emailParts[1]?.toLowerCase() : undefined
    if (
      !emailParts[0]
      || !domain
      || !allowedDomains.some(allowed => allowed.toLowerCase() === domain)
    ) {
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
 * The email must come from the verified Add-on userIdToken. Chat Event User
 * resources do not expose email addresses.
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

/**
 * Everything the create-session metadata needs to say about who sent an event.
 *
 * The three parts are reported separately because they are trusted separately.
 * `verified` and `spaceType` describe the request and are always reported —
 * api-rs gates on both, and neither hands anyone a credential on its own.
 * `email` is the credential-bearing part, so it is the only one that has to
 * survive every check.
 */
export type ResolvedSessionIdentity = {
  /** Whether Google's signature was actually checked on this request. */
  verified: boolean
  /** GOOGLE's answer when the space was looked up, the body's claim otherwise
   * (see resolveSessionIdentity). */
  spaceType: ChatSpaceType
  /** Whether the sender's email may be named — and, when it may not, why. */
  email: IdentityEmission
}

/**
 * resolveIdentityEmission plus the one thing the request body cannot be trusted
 * for: that the space really is a 1:1 DM.
 *
 * Google's signed request token verifies iss/aud/exp/signature but binds
 * NOTHING in the body, so a valid token can carry an envelope that names a
 * shared room while claiming `spaceType: DIRECT_MESSAGE` and a colleague's
 * address. Labelling that room's principal with that person would hand their
 * live OAuth credentials to everyone in it. So the DM-ness is re-asked of
 * Google, and only Google's answer can release the email.
 *
 * Order is deliberate and cost-ordered:
 *  1. the existing local checks (signature, sender domain) — free, and their
 *     reasons keep precedence so an unsigned request still reports `unverified`;
 *  2. the envelope's own `spaceType` as a pre-filter — a body that does not even
 *     claim a DM is suppressed without spending a Chat API call. Necessary,
 *     never sufficient;
 *  3. Google's answer, which is the only one that can release the email.
 *
 * The returned `spaceType` prefers Google's answer and falls back to the body's
 * claim on the paths that never asked (steps 1 and 2). It is therefore a mix of
 * confirmed and unconfirmed values and is NOT a trust signal on its own — but a
 * consumer can only label a principal once it also has an email, and the email
 * is released only on the path where Google confirmed the DM.
 *
 * Fails closed for credentials, open for chat: a Chat API failure suppresses
 * the email and is reported, but never throws at the caller, whose turn proceeds.
 */
export async function resolveSessionIdentity(opts: {
  config: AppConfig
  verified: boolean
  userEmail: string | undefined
  /** spaceType AS CLAIMED BY THE REQUEST BODY. Attacker-controllable; used only
   * to skip the API call for events that are obviously not DMs. */
  claimedSpaceType: ChatSpaceType
  confirmSpace: () => Promise<SpaceDmConfirmation>
}): Promise<ResolvedSessionIdentity> {
  const claimed = { verified: opts.verified, spaceType: opts.claimedSpaceType }

  const local = resolveIdentityEmission(opts)
  if (!local.emit) return { ...claimed, email: local }

  if (opts.claimedSpaceType !== 'DIRECT_MESSAGE') {
    return { ...claimed, email: { emit: false, reason: 'space_not_dm' } }
  }

  let confirmation: SpaceDmConfirmation
  try {
    confirmation = await opts.confirmSpace()
  } catch {
    // The verifier already fails closed on its own; this is the belt-and-braces
    // case where it (or a future one) throws anyway.
    return { ...claimed, email: { emit: false, reason: 'space_unverified' } }
  }
  if (!confirmation.confirmed) {
    return {
      verified: opts.verified,
      // Google contradicting the body is exactly the case worth reporting
      // truthfully; it only falls back when Google named no usable type.
      spaceType: confirmation.spaceType ?? opts.claimedSpaceType,
      email: { emit: false, reason: confirmation.reason }
    }
  }

  return { verified: opts.verified, spaceType: confirmation.spaceType, email: local }
}
