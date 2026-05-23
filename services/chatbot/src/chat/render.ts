import type { GoogleChatCard, GoogleChatCardSection, GoogleChatCardWidget } from './types'
import { chatReplyLimits } from '../constants'

const MAX_TEXT_CHARS = chatReplyLimits.card.textParagraphChars
const MAX_CARDS = chatReplyLimits.card.maxCards
const MAX_HEADER_CHARS = chatReplyLimits.card.headerTitleChars

export function markdownToChatMessage(markdown: string, opts: { header?: string } = {}): {
  text: string
  fallbackText: string
  cardsV2?: Array<{ cardId: string; card: GoogleChatCard }>
} {
  const trimmed = markdown.trim() || ' '
  const fallback = trimmed.slice(0, chatReplyLimits.message.maxFallbackChars)

  const cards = splitMarkdownToCards(trimmed)
  const cardsV2 = cards.slice(0, MAX_CARDS).map((card, index) => ({
    cardId: `card-${index}`,
    card: {
      ...(index === 0 && opts.header
        ? { header: { title: opts.header.slice(0, MAX_HEADER_CHARS) } }
        : {}),
      sections: card
    }
  }))

  return {
    text: trimmed.slice(0, chatReplyLimits.message.maxFallbackChars),
    fallbackText: fallback,
    cardsV2
  }
}

function splitMarkdownToCards(markdown: string): GoogleChatCardSection[][] {
  const cards: GoogleChatCardSection[][] = []
  let currentSections: GoogleChatCardSection[] = []
  let currentText = ''

  const lines = markdown.split('\n')
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/)
    if (headingMatch) {
      if (currentText.trim()) {
        currentSections.push({
          widgets: buildTextWidgets(currentText.trim())
        })
        currentText = ''
      }
      currentSections.push({
        header: headingMatch[1]!.slice(0, MAX_HEADER_CHARS),
        widgets: []
      })
      if (currentSections.length > 20) {
        cards.push(currentSections)
        currentSections = []
      }
      continue
    }

    if (line.trim() === '') {
      currentText += '\n'
      continue
    }

    if (line.trimStart().startsWith('```')) {
      if (currentText.trim()) {
        currentSections.push({
          widgets: buildTextWidgets(currentText.trim())
        })
        currentText = ''
      }
      continue
    }

    const listMatch = line.match(/^\s*[-*+]\s+(.+)/)
    if (listMatch) {
      if (currentText.trim()) {
        currentSections.push({
          widgets: buildTextWidgets(currentText.trim())
        })
        currentText = ''
      }
      currentSections.push({
        widgets: [
          {
            decoratedText: {
              icon: { knownIcon: 'STAR' },
              text: `  ${listMatch[1]!.slice(0, MAX_TEXT_CHARS)}`,
              wrapText: true
            }
          }
        ]
      })
      continue
    }

    currentText += line + '\n'

    if (currentText.length > MAX_TEXT_CHARS) {
      currentSections.push({
        widgets: buildTextWidgets(currentText.trim())
      })
      currentText = ''
    }
  }

  if (currentText.trim()) {
    currentSections.push({
      widgets: buildTextWidgets(currentText.trim())
    })
  }

  if (currentSections.length) cards.push(currentSections)

  return cards
}

function buildTextWidgets(text: string): GoogleChatCardWidget[] {
  const widgets: GoogleChatCardWidget[] = []

  const parts = splitMarkdownText(text, MAX_TEXT_CHARS)
  for (const part of parts) {
    if (part.trimStart().startsWith('```')) continue
    if (part.startsWith('# ') || part.startsWith('## ') || part.startsWith('### ')) continue

    if (part.trimStart().startsWith('>')) {
      widgets.push({
        decoratedText: {
          icon: { knownIcon: 'BOOKMARK' },
          text: part.slice(0, MAX_TEXT_CHARS),
          wrapText: true
        }
      })
      continue
    }

    if (part.startsWith('|') && part.includes('|---')) continue

    widgets.push({
      textParagraph: {
        text: part.slice(0, MAX_TEXT_CHARS)
      }
    })
  }

  return widgets
}

export function splitMarkdownText(input: string, maxChars: number): string[] {
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

export function thinkingContextText(commentary: string): string {
  const trimmed = commentary.trim()
  if (!trimmed) return ''
  const maxChars = 2_800
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 13)}\n// truncated` : trimmed
}

export function fallbackTextForMessage(input: { markdown?: string; fallback?: string }): string {
  const parts = [input.fallback, input.markdown].filter(Boolean)
  const text = parts.join('\n').replace(/\s+/g, ' ').trim() || 'Centaur update'
  const maxChars = chatReplyLimits.message.maxFallbackChars
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}
