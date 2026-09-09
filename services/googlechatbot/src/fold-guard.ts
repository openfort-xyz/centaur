import type { NormalizedChatEvent } from './chat/types'
import type { GoogleChatThreadState } from './state'

/**
 * Whether a message may be folded into the thread's already-running turn.
 *
 * A DM has one human, so folding is always the same person. In a shared space
 * the running turn's proxy carries the requester principal of whoever started
 * it, and api-rs binds that from the sender's verified email. Folding another
 * person's message in would let them steer a turn that holds the starter's
 * own grants, so only the same verified sender may fold; an unverified sender,
 * or a run whose starter is unknown, never folds.
 */
export function canFoldIntoActiveRun(
  event: Pick<NormalizedChatEvent, 'space_type' | 'user_email'>,
  state: Pick<GoogleChatThreadState, 'activeRequesterEmail'>
): boolean {
  if (event.space_type === 'DIRECT_MESSAGE') return true
  const sender = event.user_email?.trim().toLowerCase()
  const starter = state.activeRequesterEmail?.trim().toLowerCase()
  return Boolean(sender) && sender === starter
}
