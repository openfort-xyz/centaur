import { logWarn } from '../logging'
import type {
  ChatListMessage,
  ChatSpaceType,
  GoogleChatEnvelope,
  NormalizedBinaryPart,
  NormalizedChatEvent,
  NormalizedPart
} from './types'

type ChatHistoryMessage = NonNullable<NormalizedChatEvent['history_messages']>[number]
type ChatAttachment = NonNullable<NonNullable<GoogleChatEnvelope['message']>['attachment']>[number]

// Minimal interface we need from ChatEdgeClient — keeps normalize.ts unit-testable
// without instantiating the real client (which needs a service-account JSON).
export interface ChatHistoryFetcher {
  listMessages(
    spaceName: string,
    opts: { pageSize?: number; pageToken?: string; filter?: string; orderBy?: string }
  ): Promise<{ messages?: ChatListMessage[]; nextPageToken?: string }>
}

// Same idea as ChatHistoryFetcher, for attachment content downloads.
export interface ChatAttachmentDownloader {
  downloadAttachment(resourceName: string): Promise<ArrayBuffer>
}

// Cap on how many thread messages we ship to the agent. A typical 4-5 turn
// thread fits well under this; mega-threads would blow up the LLM context.
const THREAD_HISTORY_LIMIT = 50

// Largest attachment we buffer and inline as base64 into the agent turn. The
// whole turn ships as ONE blocks-protocol input line, so this mirrors
// slackbotv2's inline cap scaled down to what a single line can safely carry —
// slackbotv2 stages bigger files as attachment.chunk lines, which googlechatbot
// does not do yet. Over the cap we keep the part but drop the bytes, so the
// agent still sees the placeholder text.
const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024

export async function normalizeChatEnvelope(
  envelope: GoogleChatEnvelope,
  botUserName?: string,
  client?: ChatAttachmentDownloader
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

  // A slash command (`/centaur …`) is addressed to the app: Google strips the
  // command token and puts the rest in argumentText, which is the cleanest
  // prompt. Treat it like a mention so it always starts a run.
  const isSlashCommand = (message.annotations ?? []).some(a => a.type === 'SLASH_COMMAND')
  const text = isSlashCommand
    ? normalizeChatText(message.argumentText ?? message.text ?? '', senderName)
    : normalizeChatText(message.text ?? '', senderName)
  const formattedText = isSlashCommand ? '' : message.formattedText ?? ''

  const parts: NormalizedPart[] = []
  const textPart = [formattedText, text].filter(Boolean).join('\n').trim()
  if (textPart) parts.push({ type: 'text', text: textPart })

  for (const attachment of message.attachment ?? []) {
    parts.push(await toAttachmentPart(attachment, client, spaceName))
  }

  const displayName = message.sender.displayName ?? message.sender.email ?? senderName

  // Determine if the bot was @mentioned.
  // In Google Chat, mentions use <users/{botUserId}> syntax in message text.
  const isMention =
    isSlashCommand ||
    Boolean(botUserName && (message.text ?? '').includes(botUserName)) ||
    Boolean(botUserName && (message.text ?? '').includes('@')) ||
    envelope.space?.singleUserBotDm === true

  // Use the event-level thread if available, otherwise message.thread, otherwise message.name
  const threadField = envelope.thread || message.thread
  const threadName = threadField?.name
  const threadKey = buildThreadKey(spaceName, threadName ?? message.name)

  return {
    thread_key: threadKey,
    message_id: message.name,
    space_name: spaceName,
    space_type: spaceType,
    user_id: senderName,
    user_name: displayName,
    is_mention: isMention,
    parts,
    chat: {
      event_time: eventTime,
      message_name: message.name,
      thread_name: threadName
    }
  }
}

/**
 * Turn a Google Chat Attachment into a NormalizedBinaryPart.
 *
 * UPLOADED_CONTENT is downloaded and inlined as base64 (up to
 * MAX_INLINE_ATTACHMENT_BYTES). DRIVE_FILE is never downloaded — we hold no
 * Drive scope — so the part carries name/mime only and downstream renders the
 * placeholder text. Any failure degrades the same way: the part survives
 * without bytes, the event never fails.
 */
async function toAttachmentPart(
  attachment: ChatAttachment,
  client: ChatAttachmentDownloader | undefined,
  spaceName: string
): Promise<NormalizedBinaryPart> {
  const mimeType = attachment.contentType ?? 'application/octet-stream'
  const resourceName = attachment.attachmentDataRef?.resourceName
  const name = attachment.contentName ?? resourceName ?? attachment.name ?? 'attachment'
  const declaredSize = attachment.size ? Number(attachment.size) : undefined
  const partType: NormalizedBinaryPart['type'] =
    attachment.source !== 'DRIVE_FILE' && mimeType.startsWith('image/') ? 'image' : 'file'
  const stub: NormalizedBinaryPart = {
    type: partType,
    name,
    mime_type: mimeType,
    size: declaredSize ?? 0
  }

  if (attachment.source === 'DRIVE_FILE' || !resourceName || !client) return stub
  if (declaredSize !== undefined && declaredSize > MAX_INLINE_ATTACHMENT_BYTES) return stub

  try {
    const buffer = await client.downloadAttachment(resourceName)
    const bytes = new Uint8Array(buffer)
    // Envelopes don't always declare a size, so re-check after the download.
    if (bytes.byteLength > MAX_INLINE_ATTACHMENT_BYTES) {
      return { ...stub, size: bytes.byteLength }
    }
    return {
      ...stub,
      size: bytes.byteLength,
      source: {
        type: 'base64',
        media_type: mimeType,
        // Buffer instead of btoa(String.fromCharCode(...bytes)): spreading a
        // multi-MB array as call arguments overflows the stack.
        data: Buffer.from(bytes).toString('base64')
      }
    }
  } catch (error) {
    logWarn('chat_attachment_download_failed', {
      space: spaceName,
      attachment: attachment.name,
      error: error instanceof Error ? error.message : String(error)
    })
    return stub
  }
}

// thread.name = "spaces/<S>/threads/<T>" — strict shape, anything else is
// either a Google API surface change or a forged envelope. Build the filter
// only after passing this guard to keep the filter expression safe.
const THREAD_NAME_PATTERN = /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+$/

/**
 * Fetch prior messages in the thread the bot was @mentioned in.
 * Caller should post the user-visible ack BEFORE awaiting this (a slow Chat
 * backend on the listMessages call could otherwise blow the ~5s "bot not
 * responding" budget Google enforces).
 *
 * Returns [] when:
 *  - The thread is a fresh root (no prior context to fetch).
 *  - The threadName fails validation (defense in depth against injection).
 *  - The API errors out (degrades silently so a Chat outage cannot drop the event).
 *
 * Throws? No — all failures are converted to [] with a structured log line.
 */
export async function collectThreadHistory(
  client: ChatHistoryFetcher,
  opts: {
    spaceName: string
    threadName: string | undefined
    currentMessageName: string
    botUserName?: string
  }
): Promise<ChatHistoryMessage[]> {
  // No thread, or this message *is* the thread root → nothing earlier exists.
  if (!opts.threadName) return []
  if (isThreadRoot(opts.threadName, opts.currentMessageName)) return []

  // Reject anything that doesn't match the canonical resource-name shape.
  // Prevents quote/backslash/newline injection into the filter expression
  // and guards against unexpected envelope mutations.
  if (!THREAD_NAME_PATTERN.test(opts.threadName)) {
    console.warn('chat_thread_history_invalid_thread_name', {
      space: opts.spaceName,
      thread: opts.threadName
    })
    return []
  }

  const filter = `thread.name = "${opts.threadName}"`

  const collected: ChatListMessage[] = []
  let pageToken: string | undefined
  try {
    do {
      const page = await client.listMessages(opts.spaceName, {
        pageSize: 100,
        pageToken,
        filter,
        // Newest first so the cap drops the OLDEST messages — recency carries
        // the most context for a reply. Long threads will lose their head turn;
        // acceptable for an assistant in conversational use.
        orderBy: 'createTime desc'
      })
      for (const message of page.messages ?? []) {
        if (!message.name || message.name === opts.currentMessageName) continue
        if (isAckOrEmpty(message)) continue
        collected.push(message)
        if (collected.length >= THREAD_HISTORY_LIMIT) break
      }
      if (collected.length >= THREAD_HISTORY_LIMIT) break
      pageToken = page.nextPageToken
    } while (pageToken)
  } catch (error) {
    // Distinguish scope/auth errors so a missed admin grant surfaces in logs
    // rather than silently degrading every event for days.
    const message = error instanceof Error ? error.message : String(error)
    const isAuth = /\b(401|403)\b/.test(message)
    console.warn(
      isAuth ? 'chat_thread_history_scope_denied' : 'chat_thread_history_collect_failed',
      {
        space: opts.spaceName,
        thread: opts.threadName,
        error: message
      }
    )
    return []
  }

  // desc → asc: agent prompt wants chronological order.
  collected.reverse()

  return collected.map(message => toHistoryMessage(message, opts.botUserName))
}

/**
 * True when the event is a reply inside an existing thread (not a fresh root).
 * Used to gate follow-up runs that continue a thread without a re-@mention.
 */
export function isThreadReply(event: NormalizedChatEvent): boolean {
  const threadName = event.chat.thread_name
  if (!threadName) return false
  return !isThreadRoot(threadName, event.message_id)
}

function isThreadRoot(threadName: string, currentMessageName: string): boolean {
  // Resource names live in different collections:
  //   thread.name  = spaces/<S>/threads/<T>
  //   message.name = spaces/<S>/messages/<T>           ← thread root (no suffix)
  //   message.name = spaces/<S>/messages/<T>.<reply>   ← reply in thread
  // A thread-root message has message-id EXACTLY equal to the thread id; any
  // ".<reply>" suffix means it's a reply, not the root.
  const threadId = threadName.split('/threads/')[1]
  const messageId = currentMessageName.split('/messages/')[1]
  if (!threadId || !messageId) return false
  return threadId === messageId
}

function isAckOrEmpty(message: ChatListMessage): boolean {
  const text = (message.argumentText ?? message.text ?? '').trim()
  if (!text) return true
  // The inline ack we post at the start of every mention is the same literal
  // string — it would otherwise show up as an "assistant said this" turn on
  // every follow-up mention in the same thread.
  if (text === '_Condor is thinking…_') return true
  return false
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

function toHistoryMessage(
  message: ChatListMessage,
  botUserName: string | undefined
): ChatHistoryMessage {
  const senderName = message.sender?.name
  // Two-pronged role detection: prefer the explicit sender.type from the API,
  // fall back to comparing against the bot's resource name. sender.type='BOT'
  // is the reliable signal — botUserName matching is brittle because the bot's
  // sender.name is a numeric "users/12345...", not "users/<email>".
  const role: 'user' | 'assistant' =
    message.sender?.type === 'BOT' || (botUserName && senderName === botUserName)
      ? 'assistant'
      : 'user'

  // Prefer argumentText (mention pre-stripped by Google) for cleaner agent
  // prompts; fall back to text. Pass the bare bot id (sans "users/" prefix) so
  // user messages mentioning the bot don't carry the raw <users/...> tag.
  const rawText = (message.argumentText ?? message.text ?? '').trim()
  const botMentionId = botUserName?.replace(/^users\//, '')
  const cleaned = normalizeChatText(rawText, botMentionId)

  const parts: NormalizedPart[] = cleaned ? [{ type: 'text', text: cleaned }] : []

  const metadata: Record<string, unknown> = {}
  if (message.createTime) metadata.create_time = message.createTime
  if (message.sender?.displayName) metadata.sender_display_name = message.sender.displayName

  return {
    message_id: message.name ?? '',
    role,
    parts,
    ...(senderName ? { user_id: senderName } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {})
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
