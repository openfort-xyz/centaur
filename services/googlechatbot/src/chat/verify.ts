import type { AppConfig } from '../config'
import type { GoogleChatEnvelope } from './types'

export type ChatVerification =
  | { ok: true }
  | { ok: false; status: 400 | 401 | 403; reason: string }

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
