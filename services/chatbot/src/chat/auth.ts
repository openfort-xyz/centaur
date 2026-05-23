import type { GoogleChatEnvelope } from './types'

export function isDirectMessage(envelope: GoogleChatEnvelope): boolean {
  return envelope.space?.type === 'DIRECT_MESSAGE'
}

export function isGroupChat(envelope: GoogleChatEnvelope): boolean {
  return envelope.space?.type === 'GROUP_CHAT'
}

export function isNamedSpace(envelope: GoogleChatEnvelope): boolean {
  return envelope.space?.type === 'SPACE'
}

export function isSlashCommand(envelope: GoogleChatEnvelope): boolean {
  if (envelope.type === 'MESSAGE' && envelope.message?.annotations) {
    return envelope.message.annotations.some(
      a => a.type === 'SLASH_COMMAND' || a.type === 'slashCommand'
    )
  }
  if (envelope.type === 'APP_COMMAND') return true
  return false
}

export function isQuickCommand(envelope: GoogleChatEnvelope): boolean {
  return (
    envelope.type === 'APP_COMMAND' &&
    envelope.appCommandMetadata?.appCommandType !== 'MESSAGE_ACTION'
  )
}

export function isMessageAction(envelope: GoogleChatEnvelope): boolean {
  return (
    envelope.type === 'APP_COMMAND' &&
    envelope.appCommandMetadata?.appCommandType === 'MESSAGE_ACTION'
  )
}

export function isAddedToSpace(envelope: GoogleChatEnvelope): boolean {
  return envelope.type === 'ADDED_TO_SPACE'
}

export function isRemovedFromSpace(envelope: GoogleChatEnvelope): boolean {
  return envelope.type === 'REMOVED_FROM_SPACE'
}

export function isCardClicked(envelope: GoogleChatEnvelope): boolean {
  return envelope.type === 'CARD_CLICKED'
}

export function isSubmitForm(envelope: GoogleChatEnvelope): boolean {
  return envelope.type === 'SUBMIT_FORM'
}
