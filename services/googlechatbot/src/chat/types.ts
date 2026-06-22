export type NormalizedTextPart = {
  type: 'text'
  text: string
}

export type NormalizedBinaryPart = {
  type: 'image' | 'document' | 'file'
  name: string
  mime_type: string
  size: number
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

export type NormalizedPart = NormalizedTextPart | NormalizedBinaryPart

// Google Chat API uses: SPACE (named), DIRECT_MESSAGE (DM), GROUP_CHAT
// See: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces#Space.FIELDS.type
export type ChatSpaceType = 'SPACE' | 'DIRECT_MESSAGE' | 'GROUP_CHAT'

export type NormalizedChatEvent = {
  thread_key: string
  message_id: string
  space_name: string
  space_type: ChatSpaceType
  user_id: string
  user_name: string
  is_mention: boolean
  parts: NormalizedPart[]
  history_messages?: Array<{
    message_id: string
    role?: 'user' | 'assistant'
    parts: NormalizedPart[]
    user_id?: string
    metadata?: Record<string, unknown>
  }>
  chat: {
    event_time?: string
    message_name?: string
    thread_name?: string
  }
}

// Matches Google Chat Event schema:
// https://developers.google.com/workspace/chat/api/reference/rest/v1/Event
export type GoogleChatEnvelope = {
  type?: string
  eventTime?: string
  token?: string
  threadKey?: string
  space?: {
    name?: string
    type?: string
    displayName?: string
    singleUserBotDm?: boolean
  }
  message?: {
    name?: string
    text?: string
    thread?: { name?: string; threadKey?: string }
    sender?: { name?: string; displayName?: string; email?: string; avatarUrl?: string }
    argumentText?: string
    attachment?: Array<{
      name?: string
      contentType?: string
      contentData?: string
      size?: string
    }>
    annotations?: Array<{
      type?: string
      slashCommand?: {
        commandName?: string
        commandId?: number
        triggersDialog?: boolean
      }
    }>
    formattedText?: string
    fallbackText?: string
    cardsV2?: Array<{ cardId?: string; card: unknown }>
  }
  user?: {
    name?: string
    displayName?: string
    email?: string
    avatarUrl?: string
  }
  thread?: {
    name?: string
    threadKey?: string
  }
  isDialogEvent?: boolean
  dialogEventType?: string
  appCommandMetadata?: {
    appCommandId?: number
    appCommandType?: string
  }
  configCompleteRedirectUrl?: string
}

// Inbound message shape returned by spaces.messages.list / spaces.messages.get.
// Richer than the outbound `GoogleChatMessage` (which only types fields we send).
// Field reference: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages#Message
export type ChatListMessage = {
  name?: string
  text?: string
  argumentText?: string
  formattedText?: string
  fallbackText?: string
  createTime?: string
  lastUpdateTime?: string
  threadReply?: boolean
  thread?: { name?: string }
  sender?: {
    name?: string
    displayName?: string
    type?: 'HUMAN' | 'BOT'
    domainId?: string
  }
  annotations?: Array<{ type?: string }>
}

export type GoogleChatMessage = {
  name?: string
  text?: string
  fallbackText?: string
  cardsV2?: Array<{
    cardId?: string
    card: GoogleChatCard
  }>
  thread?: {
    name?: string
    threadReply?: boolean
  }
  privateMessageViewer?: { name?: string }
}

export type GoogleChatCard = {
  header?: {
    title: string
    subtitle?: string
    imageUrl?: string
  }
  sections?: GoogleChatCardSection[]
  fixedFooter?: { primaryButton?: GoogleChatButton }
}

export type GoogleChatCardSection = {
  header?: string
  collapsible?: boolean
  widgets?: GoogleChatCardWidget[]
}

export type GoogleChatCardWidget = {
  textParagraph?: { text: string }
  decoratedText?: {
    icon?: { knownIcon?: string }
    text: string
    bottomLabel?: string
    wrapText?: boolean
  }
  image?: { imageUrl: string; altText?: string }
  buttonList?: { buttons: GoogleChatButton[] }
  divider?: Record<string, never>
  columns?: { columnItems: Array<{ widgets: GoogleChatCardWidget[] }> }
}

export type GoogleChatButton = {
  text: string
  onClick?: {
    openLink?: { url: string }
    action?: {
      function: string
      parameters?: Array<{ key: string; value: string }>
    }
  }
  color?: { red?: number; green?: number; blue?: number }
}
