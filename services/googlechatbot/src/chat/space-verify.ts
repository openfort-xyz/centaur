import type { ChatSpaceResource } from './types'

/**
 * Whether GOOGLE — not the request body — says a space is the bot's 1:1 DM with
 * exactly one human.
 *
 * Google Chat's signed request token binds the issuer, audience and expiry but
 * NOT the body (see token.ts), so anyone holding a live token can POST an
 * envelope naming a shared room while claiming `spaceType: DIRECT_MESSAGE`.
 * Since the DM shape is what lets a session claim a person's identity — and
 * with it their OAuth credentials — the claim has to be re-asked of Google.
 */
export type SpaceDmConfirmation =
  | { confirmed: true; spaceType: 'DIRECT_MESSAGE'; singleUserBotDm: boolean }
  /** `space_not_dm`: Google answered and the answer was not a 1:1 DM.
   *  `space_unverified`: Google did not answer (error, non-200, timeout). */
  | { confirmed: false; reason: 'space_not_dm' | 'space_unverified' }

export type SpaceLookup = (spaceName: string) => Promise<ChatSpaceResource>

/**
 * A space's classification is immutable in practice: a Chat DM cannot gain a
 * third member (Google forces a new GROUP_CHAT instead), and a GROUP_CHAT/SPACE
 * never becomes a DM. So an answer from Google stays true, and a long TTL keeps
 * this off the hot path without weakening the check.
 */
export const CONFIRMED_SPACE_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Failures are cached far more briefly: unlike a classification, "the Chat API
 * was unreachable" is not a fact about the space, and pinning a space to
 * `space_unverified` for hours would turn a blip into an outage of everyone's
 * credential grants.
 */
export const FAILED_LOOKUP_TTL_MS = 60 * 1000

/** Cap on distinct spaces held in the cache. Entries are only ever created for
 * signature-verified requests, so this is a backstop, not a hot limit. */
const MAX_CACHED_SPACES = 1024

type CacheEntry = { confirmation: SpaceDmConfirmation; expiresAt: number }

/**
 * Asks Google what a space is, and remembers the answer.
 *
 * Fails closed for credentials and open for chat: an unreachable Chat API
 * yields `space_unverified` (identity suppressed) and never throws, so the
 * caller can still process the turn normally.
 */
export class SpaceDmVerifier {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly lookup: SpaceLookup
  private readonly confirmedTtlMs: number
  private readonly failedTtlMs: number
  private readonly now: () => number

  constructor(
    lookup: SpaceLookup,
    opts: { confirmedTtlMs?: number; failedTtlMs?: number; now?: () => number } = {}
  ) {
    this.lookup = lookup
    this.confirmedTtlMs = opts.confirmedTtlMs ?? CONFIRMED_SPACE_TTL_MS
    this.failedTtlMs = opts.failedTtlMs ?? FAILED_LOOKUP_TTL_MS
    this.now = opts.now ?? Date.now
  }

  async confirm(spaceName: string): Promise<SpaceDmConfirmation> {
    const cached = this.cache.get(spaceName)
    if (cached && this.now() < cached.expiresAt) return cached.confirmation

    let confirmation: SpaceDmConfirmation
    let ttlMs: number
    try {
      confirmation = classifySpaceAsDm(await this.lookup(spaceName))
      ttlMs = this.confirmedTtlMs
    } catch {
      // Non-200, timeout, unreachable, unparseable — Google said nothing, so
      // nothing is confirmed. Retried soon rather than pinned for the long TTL.
      confirmation = { confirmed: false, reason: 'space_unverified' }
      ttlMs = this.failedTtlMs
    }
    this.remember(spaceName, { confirmation, expiresAt: this.now() + ttlMs })
    return confirmation
  }

  private remember(spaceName: string, entry: CacheEntry): void {
    if (this.cache.size >= MAX_CACHED_SPACES) {
      for (const [key, value] of this.cache) {
        if (this.now() >= value.expiresAt) this.cache.delete(key)
      }
      if (this.cache.size >= MAX_CACHED_SPACES) this.cache.clear()
    }
    this.cache.set(spaceName, entry)
  }
}

/**
 * Confirmation is conjunctive, mirroring how the overlay audit job classifies a
 * DM principal: Google must say the space is a DIRECT_MESSAGE *and* that it
 * holds exactly one joined human. Either signal alone is not enough — a
 * GROUP_CHAT that has drained to one human is still not a DM, and a
 * DIRECT_MESSAGE the count disagrees with is not something to hand credentials
 * to. Anything unrecognised is `space_not_dm`.
 */
export function classifySpaceAsDm(space: ChatSpaceResource): SpaceDmConfirmation {
  if (space.spaceType !== 'DIRECT_MESSAGE') return { confirmed: false, reason: 'space_not_dm' }
  if (joinedDirectHumanCount(space) !== 1) return { confirmed: false, reason: 'space_not_dm' }
  return {
    confirmed: true,
    spaceType: 'DIRECT_MESSAGE',
    // Google's own value, not the envelope's. Strict === so a truthy non-boolean
    // cannot become `true` in the session metadata.
    singleUserBotDm: space.singleUserBotDm === true
  }
}

/**
 * The joined-human count, or null when Google did not state one as a number.
 *
 * The `typeof` guard is the point: `Number(true) === 1` and `Number('1') === 1`,
 * so coercing would let a boolean or a string manufacture a passing count out
 * of a field that never said "one human".
 */
function joinedDirectHumanCount(space: ChatSpaceResource): number | null {
  const raw = space.membershipCount?.joinedDirectHumanUserCount
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return raw
}
