import type { ChatEdgeClient } from '../chat/client'
import { centaurApiKey, type AppConfig } from '../config'
import { logError } from '../logging'
import { markdownToChatMessage } from '../chat/render'
import { withLaminarSpan } from './tracing'

const CONSUMER_ID = `chatbot-${process.pid}`
// The live ack path posts a placeholder message and round-trips its
// resource name through API metadata into the outbox row. Here we PATCH that
// same message with the canonical final answer, so the user sees a single
// bubble that mutates from "_Centaur is thinking…_" → final answer.
//
// If the patch fails (message deleted, edit-window expired, name missing
// because live open() failed) we fall back to createMessage, threading under
// the user's original message when we know its thread.
//
// Outbox claims are at-least-once: if the /delivered ACK is lost between
// `deliver` and the API write, the next tick re-claims and re-patches. PATCHing
// the same message with the same content is idempotent in practice, so this
// is safe — the duplicate-bubble bug is gone by construction now that live and
// outbox write the same slot.

const NON_RETRYABLE_CHAT_ERRORS = new Set([
  'space_not_found',
  'message_not_found',
  'permission_denied',
  'not_a_member',
  'account_inactive'
])

export function startFinalDeliveryPoller(config: AppConfig, client: ChatEdgeClient): void {
  if (!centaurApiKey(config)) return
  const tick = async () => {
    try {
      await pollFinalDeliveriesOnce(config, client)
    } catch (error) {
      logError('final_delivery_poll_failed', error)
    }
  }
  setInterval(tick, 2_000).unref?.()
  void tick()
}

export async function pollFinalDeliveriesOnce(
  config: AppConfig,
  client: ChatEdgeClient
): Promise<void> {
  const claimed = await centaurRequest(config, '/agent/final-deliveries/claim', {
    consumer_id: CONSUMER_ID,
    platform: 'google-chat',
    limit: 5,
    lease_seconds: 60
  })
  const deliveries: any[] = Array.isArray(claimed.deliveries) ? claimed.deliveries : []
  for (const delivery of deliveries) {
    await withLaminarSpan('centaur.chatbot.final_delivery', delivery, async () => {
      const executionId = String(delivery.execution_id)
      try {
        await deliver(client, delivery)
        await centaurRequest(config, `/agent/final-deliveries/${executionId}/delivered`, {
          consumer_id: CONSUMER_ID
        })
      } catch (error) {
        const errorMessage = chatDeliveryErrorMessage(error)
        const errorClass = chatDeliveryErrorClass(error)
        await centaurRequest(config, `/agent/final-deliveries/${executionId}/failed`, {
          consumer_id: CONSUMER_ID,
          error: errorMessage,
          retry_after_seconds: 10,
          ...(errorClass ? { error_class: errorClass, non_retryable: true } : {})
        }).catch(failError => logError('final_delivery_mark_failed_failed', failError))
      }
    })
  }
}

async function deliver(client: ChatEdgeClient, delivery: any): Promise<void> {
  const meta = delivery.delivery ?? {}
  const payload = delivery.final_payload ?? {}
  const spaceName: string = meta.space_name ?? meta.spaceName ?? ''
  if (!spaceName) throw new Error('missing_chat_delivery_target')

  const ackMessageName: string =
    payload.chatbot_session_message_name ?? meta.chatbot_session_message_name ?? ''
  const threadName: string | undefined = meta.thread_name ?? meta.threadName

  const text = extractText(payload)
  const rendered = markdownToChatMessage(text)
  // For simple text answers (no markdown structure), Google Chat renders both
  // the `text` fallback AND the cardsV2 textParagraph — looks like the bot
  // replied twice. Reserve cardsV2 for content with structure (headers, lists,
  // code blocks, tables); send plain text otherwise. When PATCHing the ack
  // we always include cardsV2 in the body (with [] in the plain case) so the
  // updateMask clears any prior cards the ack may have carried.
  const looksRich = /^\s*#{1,6}\s|\n#{1,6}\s|```|^\s*[-*+]\s|\n\s*[-*+]\s|^\s*\d+\.\s|\n\s*\d+\.\s|\|.*\|/.test(text)
  const body = looksRich
    ? { text: rendered.fallbackText, cardsV2: rendered.cardsV2 }
    : { text: rendered.fallbackText, cardsV2: [] }

  if (ackMessageName) {
    try {
      await client.updateMessage(ackMessageName, body)
      return
    } catch (error) {
      // Edit-window expired, message deleted, or other unrecoverable PATCH
      // failure — fall through to createMessage so the user still gets the
      // answer. The ack remains visible as an orphan, accepted trade-off.
      logError('final_delivery_patch_failed_falling_back_to_create', error)
    }
  }

  // createMessage doesn't tolerate empty cardsV2 the same way PATCH does;
  // drop the field when there's no card content.
  const createBody = looksRich ? body : { text: rendered.fallbackText }
  await client.createMessage(spaceName, createBody, { threadName })
}

function extractText(payload: any): string {
  const value = firstNonEmpty(
    payload?.result_text,
    payload?.result,
    payload?.text,
    payload?.final_text,
    payload?.message
  )
  if (value) return value

  const executionId = String(payload?.execution_id ?? '').trim()
  const suffix = executionId ? ` Execution: \`${executionId}\`.` : ''
  return `Execution completed, but no final text was captured.${suffix}`
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = value === undefined || value === null ? '' : String(value).trim()
    if (text) return text
  }
  return ''
}

function chatDeliveryErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function chatDeliveryErrorClass(error: unknown): string | null {
  const normalized = chatDeliveryErrorFingerprint(error).trim().toLowerCase()
  for (const errorClass of NON_RETRYABLE_CHAT_ERRORS) {
    if (normalized.includes(errorClass)) return errorClass
  }
  return null
}

function chatDeliveryErrorFingerprint(error: unknown): string {
  const parts = [chatDeliveryErrorMessage(error)]
  const data = (error as { data?: unknown })?.data
  if (data && typeof data === 'object') {
    const chatError = (data as { error?: unknown }).error
    if (chatError) parts.push(String(chatError))
  }
  const code = (error as { code?: unknown })?.code
  if (code) parts.push(String(code))
  return parts.join(' ')
}

async function centaurRequest(config: AppConfig, path: string, body: unknown): Promise<any> {
  const apiKey = centaurApiKey(config)
  const response = await fetch(new URL(path, config.CENTAUR_API_URL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  const parsed: any = text ? JSON.parse(text) : {}
  if (!response.ok)
    throw new Error(
      parsed?.detail?.message ?? parsed?.detail ?? parsed?.error ?? response.statusText
    )
  return parsed
}
