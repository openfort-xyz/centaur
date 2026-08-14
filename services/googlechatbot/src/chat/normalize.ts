import { logWarn } from '../logging'
import { INITIAL_STATUS } from '../renderer'
import { cardFallbackText } from './card-text'
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
    opts: {
      pageSize?: number
      pageToken?: string
      filter?: string
      orderBy?: string
      impersonateSubject?: string
    }
  ): Promise<{ messages?: ChatListMessage[]; nextPageToken?: string }>
}

// Same idea as ChatHistoryFetcher, for attachment content downloads.
export interface ChatAttachmentDownloader {
  downloadAttachment(resourceName: string): Promise<ArrayBuffer>
  downloadDriveAttachment?(input: {
    driveFileId: string
    expectedMimeType: string
    declaredSize?: number
  }): Promise<{
    data?: ArrayBuffer
    mimeType?: string
    name?: string
    size?: number
    unavailableReason?: NormalizedBinaryPart['unavailable_reason']
  }>
}

// Cap on how many thread messages we ship to the agent. A typical 4-5 turn
// thread fits well under this; mega-threads would blow up the LLM context.
export const DEFAULT_THREAD_HISTORY_LIMIT = 50

// Largest attachment we buffer and inline as base64 into the agent turn. The
// whole turn ships as ONE blocks-protocol input line, so this mirrors
// slackbotv2's inline cap scaled down to what a single line can safely carry —
// slackbotv2 stages bigger files as attachment.chunk lines, which googlechatbot
// does not do yet. Over the cap we keep the part but drop the bytes, so the
// agent still sees the placeholder text.
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

// Bound the fan-out of media downloads triggered by a single inbound message.
const MAX_ATTACHMENTS_PER_MESSAGE = 10

export async function normalizeChatEnvelope(
  envelope: GoogleChatEnvelope,
  botUserName?: string,
  client?: ChatAttachmentDownloader,
  opts: { acceptFollowUpAttachments?: boolean } = {}
): Promise<NormalizedChatEvent | null> {
  if (!envelope.type) return null
  if (!envelope.space?.name) return null

  const spaceName = envelope.space.name
  const spaceType = normalizeSpaceType(envelope.space.spaceType ?? envelope.space.type)
  if (!spaceType) return null

  const eventTime = envelope.eventTime

  if (envelope.type === 'ADDED_TO_SPACE') {
    return buildAddedToSpaceEvent(spaceName, spaceType, eventTime)
  }

  if (envelope.type === 'REMOVED_FROM_SPACE') {
    return null
  }

  // Actions are normalized into workflow events by index.ts, never LLM turns.
  if (envelope.type !== 'MESSAGE') return null

  const message = envelope.message
  if (!message || !message.sender || !message.name) return null

  const senderName = message.sender.name
  if (!senderName) return null

  // Never let bot-authored messages start an agent loop. The canonical resource
  // catches older payloads that omit sender.type.
  if (message.sender.type === 'BOT' || (botUserName && senderName === botUserName)) return null

  // A slash command (`/centaur …`) is addressed to the app: Google strips the
  // command token and puts the rest in argumentText, which is the cleanest
  // prompt. Treat it like a mention so it always starts a run.
  const isSlashCommand = Boolean(message.slashCommand)
    || (message.annotations ?? []).some(a => a.type === 'SLASH_COMMAND')
  const botMentionId = botUserName?.replace(/^users\//, '')
  const text = isSlashCommand
    ? normalizeChatText(message.argumentText ?? message.text ?? '', botMentionId)
    : normalizeChatText(message.text ?? '', botMentionId)
  const formattedText = isSlashCommand ? '' : message.formattedText ?? ''

  const displayName = message.sender.displayName ?? senderName

  // Determine if the bot was @mentioned.
  // In Google Chat, mentions use <users/{botUserId}> syntax in message text.
  // In the bot's 1:1 DM every message is addressed to it, so no @ is needed.
  const isExactMention = Boolean(
    botUserName
      && ((message.annotations ?? []).some(
        annotation =>
          annotation.type === 'USER_MENTION'
          && annotation.userMention?.user?.name === botUserName
      )
        || (message.text ?? '').includes(`<${botUserName}>`)
        || (message.formattedText ?? '').includes(`<${botUserName}>`))
  )
  const isMention = isSlashCommand || isExactMention || envelope.space.singleUserBotDm === true

  const parts: NormalizedPart[] = []
  // formattedText is another representation of the same message, not an
  // additional paragraph. Prefer plain/argument text so prompts are not doubled.
  const textPart = (text || formattedText || cardFallbackText(message)).trim()
  if (textPart) parts.push({ type: 'text', text: textPart })

  // Only hydrate attachment bytes for a message that will actually start a run
  // (a mention / DM / slash command). The caller drops non-mention messages
  // unless follow-up threads are enabled, so downloading their files here would
  // be wasted work and an amplification vector on the unauthenticated webhook —
  // one forged envelope with a big `attachment` array would fan out to that many
  // authenticated media fetches. Bounded per message either way.
  const threadField = envelope.thread || message.thread
  const threadName = threadField?.name
  const acceptedFollowUp = Boolean(
    opts.acceptFollowUpAttachments
      && message.threadReply === true
      && threadName
      && THREAD_NAME_PATTERN.test(threadName)
  )
  if (isMention || acceptedFollowUp) {
    for (const attachment of (message.attachment ?? []).slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
      parts.push(await toAttachmentPart(attachment, client, spaceName))
    }
  }

  // Use the event-level thread if available, otherwise message.thread, otherwise message.name
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
      thread_name: threadName,
      ...(typeof message.threadReply === 'boolean'
        ? { thread_reply: message.threadReply }
        : {})
    }
  }
}

/**
 * Turn a Google Chat Attachment into a NormalizedBinaryPart.
 *
 * UPLOADED_CONTENT is downloaded and inlined as base64 (up to
 * MAX_ATTACHMENT_BYTES). Any failure degrades to metadata with a structured
 * reason: attachment handling must never drop the inbound event.
 */
async function toAttachmentPart(
  attachment: ChatAttachment,
  client: ChatAttachmentDownloader | undefined,
  spaceName: string
): Promise<NormalizedBinaryPart> {
  const mimeType = attachment.contentType ?? 'application/octet-stream'
  const resourceName = attachment.attachmentDataRef?.resourceName
  const driveFileId = attachment.driveDataRef?.driveFileId
  const name = attachment.contentName ?? resourceName ?? attachment.name ?? 'attachment'
  const partType: NormalizedBinaryPart['type'] =
    attachment.source !== 'DRIVE_FILE' && mimeType.startsWith('image/') ? 'image' : 'file'
  const stub: NormalizedBinaryPart = {
    type: partType,
    name,
    mime_type: mimeType,
    size: 0
  }

  if (attachment.source === 'DRIVE_FILE') {
    if (!driveFileId || !client?.downloadDriveAttachment) {
      return {
        ...stub,
        unavailable_reason: driveFileId ? 'download_not_configured' : 'invalid_resource'
      }
    }
    try {
      const result = await client.downloadDriveAttachment({
        driveFileId,
        expectedMimeType: mimeType
      })
      if (!result.data) {
        return { ...stub, unavailable_reason: result.unavailableReason ?? 'download_failed' }
      }
      const bytes = new Uint8Array(result.data)
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES || !result.mimeType) {
        return { ...stub, size: bytes.byteLength, unavailable_reason: 'metadata_mismatch' }
      }
      return binaryPart({
        ...stub,
        name: result.name ?? stub.name,
        mime_type: result.mimeType
      }, bytes, result.mimeType)
    } catch (error) {
      logAttachmentFailure(error, spaceName, attachment.name)
      return { ...stub, unavailable_reason: 'download_failed' }
    }
  }

  if (!resourceName) return { ...stub, unavailable_reason: 'invalid_resource' }
  if (!client) return { ...stub, unavailable_reason: 'download_not_configured' }

  try {
    const buffer = await client.downloadAttachment(resourceName)
    const bytes = new Uint8Array(buffer)
    // Envelopes don't always declare a size, so re-check after the download.
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return { ...stub, size: bytes.byteLength, unavailable_reason: 'declared_too_large' }
    }
    return binaryPart(stub, bytes, mimeType)
  } catch (error) {
    logAttachmentFailure(error, spaceName, attachment.name)
    return { ...stub, unavailable_reason: 'download_failed' }
  }
}

function binaryPart(
  stub: NormalizedBinaryPart,
  bytes: Uint8Array,
  mimeType: string
): NormalizedBinaryPart {
  return {
    ...stub,
    size: bytes.byteLength,
    source: {
      type: 'base64',
      media_type: mimeType,
      data: Buffer.from(bytes).toString('base64')
    }
  }
}

function logAttachmentFailure(error: unknown, space: string, attachment: string | undefined): void {
  logWarn('chat_attachment_download_failed', {
    space,
    attachment,
    error: error instanceof Error ? error.message : String(error)
  })
}

// thread.name = spaces/<S>/threads/<T> — strict shape, anything else is
// either a Google API surface change or a forged envelope. Build the filter
// only after passing this guard to keep the filter expression safe.
const THREAD_NAME_PATTERN = /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+$/

/**
 * Fetch prior messages in the thread the bot was @mentioned in.
 * Caller should post the user-visible ack BEFORE awaiting this (a slow Chat
 * backend on the listMessages call could otherwise consume Google's 30-second
 * synchronous response deadline).
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
    threadReply?: boolean
    botUserName?: string
    /** Requester email; used to read DM history as that user when app auth
     * (which cannot read DMs) is refused. */
    requesterEmail?: string
    historyLimit?: number
  }
): Promise<ChatHistoryMessage[]> {
  // No thread, or this message *is* the thread root → nothing earlier exists.
  if (!opts.threadName || opts.threadReply !== true) return []

  // Reject anything that doesn't match the canonical resource-name shape.
  // Prevents quote/backslash/newline injection into the filter expression
  // and guards against unexpected envelope mutations.
  if (!THREAD_NAME_PATTERN.test(opts.threadName)) {
    logWarn('chat_thread_history_invalid_thread_name', {
      space: opts.spaceName,
      thread: opts.threadName
    })
    return []
  }

  const filter = `thread.name = ${opts.threadName}`

  const historyLimit = Math.max(1, Math.floor(opts.historyLimit ?? DEFAULT_THREAD_HISTORY_LIMIT))
  const collected: ChatListMessage[] = []
  let pageToken: string | undefined
  try {
    do {
      const page = await client.listMessages(opts.spaceName, {
        pageSize: Math.min(100, historyLimit - collected.length),
        pageToken,
        filter,
        ...(opts.requesterEmail ? { impersonateSubject: opts.requesterEmail } : {}),
        // Newest first so the cap drops the OLDEST messages — recency carries
        // the most context for a reply. Long threads will lose their head turn;
        // acceptable for an assistant in conversational use.
        orderBy: 'createTime DESC'
      })
      for (const message of page.messages ?? []) {
        if (!message.name || message.name === opts.currentMessageName) continue
        if (isAckOrEmpty(message)) continue
        collected.push(message)
        if (collected.length >= historyLimit) break
      }
      if (collected.length >= historyLimit) break
      pageToken = page.nextPageToken
    } while (pageToken)
  } catch (error) {
    // Distinguish scope/auth errors so a missed admin grant surfaces in logs
    // rather than silently degrading every event for days.
    const message = error instanceof Error ? error.message : String(error)
    const isAuth = /\b(401|403)\b/.test(message)
    logWarn(
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
  return event.chat.thread_reply === true
}

function isAckOrEmpty(message: ChatListMessage): boolean {
  const text = messageText(message)
  if (!text) return true
  // The inline ack we post at the start of every mention — it would otherwise
  // show up as an "assistant said this" turn on every follow-up mention in the
  // same thread.
  if (text === INITIAL_STATUS) return true
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

export function buildThreadKey(spaceName: string, resourceName: string): string {
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
  const rawText = messageText(message)
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

function messageText(message: ChatListMessage): string {
  for (const candidate of [
    message.argumentText,
    message.text,
    message.formattedText,
    message.fallbackText
  ]) {
    const value = candidate?.trim()
    if (value) return value
  }
  const cardText = cardFallbackText(message).trim()
  if (cardText) return cardText
  return (message.attachedGifs ?? []).map(gif => gif.uri?.trim()).filter(Boolean).join('\n')
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
