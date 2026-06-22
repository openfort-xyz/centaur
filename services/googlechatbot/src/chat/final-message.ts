import type { GoogleChatCardSection } from './types'
import { chatReplyLimits } from '../constants'

export type FinalMessagePayload = {
  text: string
  cardsV2?: Array<{ cardId: string; card: { sections: GoogleChatCardSection[] } }>
  status?: {
    tasks: Array<{
      id: string
      title: string
      status: 'pending' | 'in_progress' | 'complete' | 'error'
      details?: string
      output?: string
    }>
  }
}

export function sanitizeFinalMessage(payload: FinalMessagePayload): FinalMessagePayload {
  const maxTasks = chatReplyLimits.finalPlan.maxTasks
  const maxCards = chatReplyLimits.card.maxCards

  const sanitized: FinalMessagePayload = {
    text: sanitizeText(payload.text),
    ...(payload.cardsV2 ? { cardsV2: payload.cardsV2.slice(0, maxCards) } : {})
  }

  if (payload.status) {
    sanitized.status = {
      tasks: payload.status.tasks.slice(0, maxTasks).map(task => ({
        id: sanitizeText(task.id).slice(0, 64),
        title: sanitizeText(task.title).slice(0, chatReplyLimits.finalPlan.taskTitleChars),
        status: task.status,
        ...(task.details
          ? {
              details: sanitizeText(task.details).slice(
                0,
                chatReplyLimits.stream.taskDetailsChars
              )
            }
          : {}),
        ...(task.output
          ? {
              output: sanitizeText(task.output).slice(
                0,
                chatReplyLimits.stream.taskOutputChars
              )
            }
          : {})
      }))
    }
  }

  return sanitized
}

function sanitizeText(text: string): string {
  return text
    .replace(/api[_-]?key[=:]\s*[A-Za-z0-9_\-]+/gi, 'api_key=[REDACTED]')
    .replace(/bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
    .replace(/private_key[=:]\s*-----[\s\S]*?-----/gi, 'private_key=[REDACTED]')
    .trim()
}
