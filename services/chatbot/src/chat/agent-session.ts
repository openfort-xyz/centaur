import type { ChatEdgeClient } from './client'
import type { GoogleChatCard, GoogleChatCardSection, GoogleChatCardWidget } from './types'
import { chatReplyLimits } from '../constants'

type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'error'

type SessionTask = {
  id: string
  title: string
  status: TaskStatus
  details?: string
  output?: string
  updatedAt: number
}

type AgentSession = {
  id: string
  spaceName: string
  messageName: string
  tasks: Map<string, SessionTask>
  accumulatedText: string
  header?: string
  createdAt: number
  lastFlushedTextLength: number
}

const sessions = new Map<string, AgentSession>()
const sessionLocks = new Map<string, Promise<void>>()

let lastFlushTime = 0

export function getAgentSession(sessionId: string): AgentSession | undefined {
  return sessions.get(sessionId)
}

export async function withAgentSessionLock<T>(
  sessionId: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve()
  let release: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  sessionLocks.set(sessionId, prev.then(() => current))
  await prev
  try {
    return await fn()
  } finally {
    release!()
  }
}

export class AgentSessionRenderer {
  private readonly client: ChatEdgeClient

  constructor(client: ChatEdgeClient) {
    this.client = client
  }

  async open(opts: {
    spaceName: string
    header?: string
    title?: string
  }): Promise<{ sessionId: string }> {
    const sessionId = `chat-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const message = await this.client.createMessage(opts.spaceName, {
      text: 'Thinking…',
      cardsV2: [
        {
          cardId: 'status-card',
          card: {
            header: { title: opts.header ?? 'Centaur' },
            sections: buildStatusSections([], opts.title)
          }
        }
      ]
    })

    const session: AgentSession = {
      id: sessionId,
      spaceName: opts.spaceName,
      messageName: message.name ?? '',
      tasks: new Map(),
      accumulatedText: '',
      header: opts.header,
      createdAt: Date.now(),
      lastFlushedTextLength: 0
    }

    sessions.set(sessionId, session)
    return { sessionId }
  }

  async text(sessionId: string, markdown: string): Promise<void> {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Agent session not found: ${sessionId}`)
    session.accumulatedText += markdown
    await this.flushIfNeeded(session)
  }

  async step(
    sessionId: string,
    task: { id: string; title: string; status?: TaskStatus; details?: string; output?: string }
  ): Promise<void> {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Agent session not found: ${sessionId}`)

    session.tasks.set(task.id, {
      id: task.id,
      title: task.title.slice(0, chatReplyLimits.stream.taskTitleChars),
      status: task.status ?? 'pending',
      details: task.details?.slice(0, chatReplyLimits.stream.taskDetailsChars),
      output: task.output?.slice(0, chatReplyLimits.stream.taskOutputChars),
      updatedAt: Date.now()
    })

    await this.flushIfNeeded(session)
  }

  async done(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Agent session not found: ${sessionId}`)

    const text = session.accumulatedText.slice(0, chatReplyLimits.message.maxTextChars)
    const tasks = [...session.tasks.values()]

    try {
      await this.client.updateMessage(session.messageName, {
        text: text || 'Done.',
        cardsV2: [
          ...(tasks.length
            ? [
                {
                  cardId: 'status-card',
                  card: {
                    sections: buildStatusSections(tasks)
                  }
                }
              ]
            : []),
          ...buildTextCards(text)
        ]
      })
    } catch (error) {
      console.warn('agent_session_finalize_failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      try {
        await this.client.createMessage(session.spaceName, {
          text: text || 'Done.'
        })
      } catch {
        console.error('agent_session_fallback_create_failed', {
          sessionId
        })
      }
    }

    sessions.delete(sessionId)
    sessionLocks.delete(sessionId)
  }

  private async flushIfNeeded(session: AgentSession): Promise<void> {
    const now = Date.now()
    const unflushedLength = session.accumulatedText.length - session.lastFlushedTextLength
    const shouldFlush = unflushedLength > 1_000 || (now - lastFlushTime > 500 && unflushedLength > 0)

    if (!shouldFlush) return
    lastFlushTime = now
    session.lastFlushedTextLength = session.accumulatedText.length

    const visibleText = session.accumulatedText.slice(
      0,
      chatReplyLimits.stream.maxLiveTextChars
    )
    const tasks = [...session.tasks.values()]

    try {
      await this.client.updateMessage(session.messageName, {
        text: visibleText || 'Thinking…',
        cardsV2: buildCardsForUpdate(tasks, visibleText, session.header)
      })
    } catch (error) {
      console.warn('agent_session_flush_failed', {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

function buildStatusSections(
  tasks: SessionTask[],
  header?: string
): GoogleChatCardSection[] {
  if (!tasks.length) {
    return [
      {
        header: header ?? 'Status',
        widgets: [
          {
            textParagraph: {
              text: header ? 'Working...' : 'Thinking...'
            }
          }
        ]
      }
    ]
  }

  const widgets: GoogleChatCardWidget[] = tasks.map(task => ({
    decoratedText: {
      icon: { knownIcon: statusIcon(task.status) },
      text: `${statusPrefix(task.status)} ${task.title}`,
      bottomLabel: task.details?.slice(0, 200),
      wrapText: true
    }
  }))

  return [{ header: 'Progress', widgets }]
}

function buildTextCards(text: string): Array<{
  cardId: string
  card: { sections: GoogleChatCardSection[] }
}> {
  if (!text || text === 'Done.' || text === 'Thinking…') return []

  const sections: GoogleChatCardSection[] = []
  const parts = splitTextForCards(text, chatReplyLimits.card.textParagraphChars)

  for (const part of parts) {
    sections.push({
      widgets: [{ textParagraph: { text: part } }]
    })
  }

  return [
    {
      cardId: 'response-card',
      card: { sections: sections.slice(0, chatReplyLimits.card.maxSections) }
    }
  ]
}

function buildCardsForUpdate(
  tasks: SessionTask[],
  text: string,
  header?: string
): Array<{ cardId: string; card: { sections: GoogleChatCardSection[] } }> {
  const cards: Array<{ cardId: string; card: { sections: GoogleChatCardSection[] } }> = []

  if (tasks.length > 0) {
    cards.push({
      cardId: 'status-card',
      card: { sections: buildStatusSections(tasks) }
    })
  }

  if (text && text !== 'Thinking…') {
    const preview = text.slice(0, 1_000)
    cards.push({
      cardId: 'text-preview',
      card: {
        sections: [{ widgets: [{ textParagraph: { text: preview } }] }]
      }
    })
  }

  return cards
}

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case 'complete':
      return 'STAR'
    case 'in_progress':
      return 'CLOCK'
    case 'error':
      return 'DESCRIPTION'
    case 'pending':
      return 'BOOKMARK'
  }
}

function statusPrefix(status: TaskStatus): string {
  switch (status) {
    case 'complete':
      return '✅'
    case 'in_progress':
      return '⏳'
    case 'error':
      return '❌'
    case 'pending':
      return '📋'
  }
}

function splitTextForCards(input: string, maxChars: number): string[] {
  const chunks: string[] = []
  let remaining = input
  while (remaining.length > maxChars) {
    const hard = remaining.slice(0, maxChars)
    const paragraphBoundary = hard.lastIndexOf('\n\n')
    const lineBoundary = hard.lastIndexOf('\n')
    const spaceBoundary = hard.lastIndexOf(' ')
    const boundary = Math.max(paragraphBoundary, lineBoundary, spaceBoundary)
    const delimiterLength = boundary === paragraphBoundary ? 2 : boundary >= 0 ? 1 : 0
    const take = boundary > maxChars * 0.5 ? boundary + delimiterLength : maxChars
    chunks.push(remaining.slice(0, take))
    remaining = remaining.slice(take)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}
