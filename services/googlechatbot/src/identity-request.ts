import type { AppConfig } from './config'
import type { GoogleChatEnvelope } from './chat/types'

/**
 * The reply that makes Chat run the add-on consent flow for the sender and
 * then re-send the same event with `authorizationEventObject.userIdToken`.
 * `all_scopes` means the scopes on the Marketplace SDK App Configuration
 * (email and profile), which is what identity needs.
 */
export const IDENTITY_REQUEST_RESPONSE = { requesting_google_scopes: { all_scopes: true } }

/**
 * Whether this event should be answered with an identity request instead of
 * being processed. Only a human MESSAGE delivered as a Workspace Add-on event
 * (it carries `authorizationEventObject`) that has no user token and no
 * record of consent at all. A sender who was asked and answered has
 * `authorizedScopes` on later events, granted or not, and is never asked
 * again by this rule; the per-sender TTL in the handler covers the case
 * where Google omits the list.
 */
export function wantsUserIdentity(config: AppConfig, envelope: GoogleChatEnvelope): boolean {
  if (!config.GOOGLECHATBOT_REQUEST_USER_IDENTITY) return false
  if (envelope.type !== 'MESSAGE') return false
  const tokens = envelope.authorizationEventObject
  if (!tokens) return false
  if (tokens.userIdToken) return false
  if (tokens.authorizedScopes !== undefined) return false
  const senderType = envelope.message?.sender?.type ?? envelope.user?.type
  return senderType === undefined || senderType === 'HUMAN'
}

export function identityRequestKey(sender: string): string {
  return `googlechatbot:identity-request:${sender}`
}
