import { centaurApiKey, type AppConfig } from '../config'
import type { NormalizedChatEvent } from '../chat/types'

export type CentaurHandoffResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; body: unknown }

export class CentaurHandoff {
  readonly config: AppConfig

  constructor(config: AppConfig) {
    this.config = config
  }

  async emit(
    event: NormalizedChatEvent,
    opts: { ackMessageName?: string } = {}
  ): Promise<CentaurHandoffResult> {
    const url = new URL('/workflows/runs', this.config.CENTAUR_API_URL)
    const apiKey = centaurApiKey(this.config)
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        workflow_name: 'slack_thread_turn',
        trigger_key: event.message_id,
        eager_start: true,
        input: {
          thread_key: event.thread_key,
          parts: event.parts,
          history_messages: event.history_messages ?? [],
          message_id: event.message_id,
          user_id: event.user_id,
          metadata: {
            source: 'chatbot',
            chat: {
              space_name: event.space_name,
              space_type: event.space_type,
              message_name: event.chat.message_name,
              thread_name: event.chat.thread_name
            },
            is_mention: event.is_mention
          },
          delivery: {
            platform: 'google-chat',
            space_name: event.space_name,
            space_type: event.space_type,
            message_name: event.chat.message_name,
            thread_name: event.chat.thread_name,
            user_id: event.user_id,
            user_name: event.user_name,
            // Pre-created ack message — round-tripped into the outbox row's
            // delivery dict so the final-delivery poller PATCHes this name
            // instead of creating a new bubble. Empty string means the
            // inline ack failed and the poller should createMessage instead.
            ...(opts.ackMessageName ? { chatbot_session_message_name: opts.ackMessageName } : {})
          }
        }
      })
    })

    const body = await readResponseBody(response)
    return { ok: response.ok, status: response.status, body }
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
