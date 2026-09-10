import type { AppConfig } from './config'
import type { GoogleChatEnvelope } from './chat/types'
import { logWarn } from './logging'
import { incr } from './metrics'

/**
 * The sender's email for a Workspace Add-on event that carries no
 * `userIdToken`, resolved from the Workspace directory.
 *
 * Google never attaches the Add-on user token to a standalone HTTP Chat app's
 * events, so the only identity in a message is the sender's `users/<id>`.
 * That id is Google's own claim inside a request whose bearer was verified as
 * the add-on's service account, which is why it may be trusted here and only
 * here: an unsigned request could name anyone. Only human MESSAGE events are
 * resolved. Undefined means the turn stays anonymous, exactly as before.
 */
export async function resolveSenderEmail(opts: {
  lookup: (userName: string) => Promise<string | null>
  verified: boolean
  ingressMode: AppConfig['GOOGLECHATBOT_INGRESS_MODE']
  envelope: GoogleChatEnvelope
}): Promise<string | undefined> {
  const { envelope } = opts
  if (!opts.verified || opts.ingressMode !== 'workspace_addon') return undefined
  if (envelope.type !== 'MESSAGE') return undefined
  const sender = envelope.message?.sender ?? envelope.user
  const senderType = sender?.type
  if (senderType !== undefined && senderType !== 'HUMAN') return undefined
  const name = sender?.name
  if (!name?.startsWith('users/')) return undefined

  try {
    const email = await opts.lookup(name)
    incr('googlechatbot_sender_lookup_total', { outcome: email ? 'resolved' : 'unknown' })
    return email ?? undefined
  } catch (error) {
    incr('googlechatbot_sender_lookup_total', { outcome: 'error' })
    logWarn('googlechatbot_sender_lookup_failed', {
      sender: name,
      error: error instanceof Error ? error.message : String(error)
    })
    return undefined
  }
}
