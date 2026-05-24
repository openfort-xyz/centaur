import type { NormalizedChatEvent, NormalizedPart, GoogleChatEnvelope, ChatSpaceType } from './types'

type ChatHistoryMessage = NonNullable<NormalizedChatEvent['history_messages']>[number]

export async function normalizeChatEnvelope(
  envelope: GoogleChatEnvelope,
  botUserName?: string
): Promise<NormalizedChatEvent | null> {
  if (!envelope.type) return null
  if (!envelope.space?.name) return null

  const spaceName = envelope.space.name
  const spaceType = normalizeSpaceType(envelope.space.type)
  if (!spaceType) return null

  const eventTime = envelope.eventTime

  if (envelope.type === 'ADDED_TO_SPACE') {
    return buildAddedToSpaceEvent(spaceName, spaceType, eventTime)
  }

  if (envelope.type === 'REMOVED_FROM_SPACE') {
    return null
  }

  // APP_COMMAND, CARD_CLICKED, and SUBMIT_FORM are deliberately ignored: the
  // workflow handler has no command-aware path, so propagating them would just
  // ship synthetic prompts to the LLM. Re-enable here once the workflow side
  // has a real command handler.
  if (envelope.type !== 'MESSAGE') return null

  const message = envelope.message
  if (!message || !message.sender || !message.name) return null

  const senderName = message.sender.name
  if (!senderName) return null

  // Skip bot's own messages (sender.name is a resource name like "users/123")
  if (botUserName && senderName === botUserName) return null

  const text = normalizeChatText(message.text ?? '', senderName)
  const formattedText = message.formattedText ?? ''

  const parts: NormalizedPart[] = []
  const textPart = [formattedText, text].filter(Boolean).join('\n').trim()
  if (textPart) parts.push({ type: 'text', text: textPart })

  const displayName = message.sender.displayName ?? message.sender.email ?? senderName

  // Determine if the bot was @mentioned.
  // In Google Chat, mentions use <users/{botUserId}> syntax in message text.
  const isMention =
    Boolean(botUserName && (message.text ?? '').includes(botUserName)) ||
    Boolean(botUserName && (message.text ?? '').includes('@')) ||
    envelope.space?.singleUserBotDm === true

  // Use the event-level thread if available, otherwise message.thread, otherwise message.name
  const threadField = envelope.thread || message.thread
  const threadName = threadField?.name
  const threadKey = buildThreadKey(spaceName, threadName ?? message.name)

  const historyMessages = isMention
    ? await collectThreadHistorySafely({
        spaceName,
        threadName,
        currentMessageName: message.name,
        botUserName
      })
    : []

  return {
    thread_key: threadKey,
    message_id: message.name,
    space_name: spaceName,
    space_type: spaceType,
    user_id: senderName,
    user_name: displayName,
    is_mention: isMention,
    parts,
    ...(historyMessages.length ? { history_messages: historyMessages } : {}),
    chat: {
      event_time: eventTime,
      message_name: message.name,
      thread_name: threadName
    }
  }
}

function buildAddedToSpaceEvent(
  spaceName: string,
  spaceType: ChatSpaceType,
  eventTime?: string
): NormalizedChatEvent {
  return {
    thread_key: buildThreadKey(spaceName, spaceName),
    message_id: `chat:${spaceName}:added_to_space`,
    space_name: spaceName,
    space_type: spaceType,
    user_id: 'system',
    user_name: 'System',
    is_mention: true,
    parts: [{ type: 'text', text: 'ADDED_TO_SPACE' }],
    chat: { event_time: eventTime }
  }
}

function normalizeSpaceType(type: string | undefined): ChatSpaceType | null {
  if (!type) return null
  const normalized = type.toUpperCase()
  // v1 (legacy Chat API) enum values
  if (normalized === 'DIRECT_MESSAGE') return 'DIRECT_MESSAGE'
  if (normalized === 'GROUP_CHAT') return 'GROUP_CHAT'
  if (normalized === 'SPACE') return 'SPACE'
  // v2 (Workspace Add-ons) enum values
  if (normalized === 'DM') return 'DIRECT_MESSAGE'
  if (normalized === 'ROOM') return 'SPACE'
  return null
}

export function normalizeChatText(input: string, senderResourceName?: string): string {
  let text = input

  if (senderResourceName) {
    text = text
      .replace(new RegExp(`<users/${escapeRegex(senderResourceName)}>`, 'gi'), '')
      .replace(new RegExp(`@${escapeRegex(senderResourceName)}`, 'gi'), '')
      .trim()
  }

  return text
    .replace(/<users\/([^>]+)>/gi, '@$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/gi, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/gi, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function buildThreadKey(spaceName: string, resourceName: string): string {
  return `chat:${normalizeThreadSegment(spaceName)}:${normalizeThreadSegment(resourceName)}`
}

function normalizeThreadSegment(segment: string): string {
  return segment.replace(/\//g, ':').replace(/\s+/g, '_')
}

async function collectThreadHistorySafely(opts: {
  spaceName: string
  threadName?: string
  currentMessageName: string
  botUserName?: string
}): Promise<ChatHistoryMessage[]> {
  try {
    return await collectThreadHistory(opts)
  } catch (error) {
    console.warn('chat_thread_history_collect_failed', {
      space: opts.spaceName,
      thread: opts.threadName,
      error: error instanceof Error ? error.message : String(error)
    })
    return []
  }
}

async function collectThreadHistory(opts: {
  spaceName: string
  threadName?: string
  currentMessageName: string
  botUserName?: string
}): Promise<ChatHistoryMessage[]> {
  if (!opts.threadName || opts.threadName === opts.currentMessageName) return []
  return []
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
