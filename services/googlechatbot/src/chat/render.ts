import type { RendererTask, RendererTaskStatus } from '@centaur/rendering'
import type { GoogleChatCard, GoogleChatCardSection, GoogleChatCardWidget } from './types'
import { chatReplyLimits } from '../constants'

const MAX_TEXT_CHARS = chatReplyLimits.card.textParagraphChars
const MAX_CARDS = chatReplyLimits.card.maxCards
const MAX_HEADER_CHARS = chatReplyLimits.card.headerTitleChars
const MAX_WIDGETS_PER_CARD = chatReplyLimits.card.maxWidgetsPerCard
const MAX_CARD_BYTES = chatReplyLimits.card.maxCardBytes

/** Google Chat renders Markdown in card text only when textSyntax is MARKDOWN. */
const MARKDOWN = 'MARKDOWN' as const

export function markdownToChatMessage(markdown: string, opts: { header?: string } = {}): {
  /** Full answer for the card-less (plain) path. */
  text: string
  /** Short one-line summary shown above a card so the answer is not rendered twice. */
  fallbackText: string
  cardsV2?: Array<{ cardId: string; card: GoogleChatCard }>
} {
  const trimmed = markdown.trim() || ' '
  // Markdown tables aren't supported by Google Chat; preserve their alignment as
  // a monospace code block instead of leaking raw pipes into the text.
  const fenced = fenceMarkdownTables(trimmed)

  const cards = splitMarkdownToCards(fenced)
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
    text: clampText(trimmed, chatReplyLimits.message.maxPlainTextChars),
    fallbackText: summarizeMarkdown(trimmed),
    cardsV2
  }
}

/**
 * Build the card sections for one message, packing widgets into cards so no card
 * exceeds Google Chat's 100-widget / 32 KB limits (which silently drop sections).
 * Headings (#..######) become section headers; everything else is a Markdown
 * text paragraph that Google Chat renders natively via textSyntax MARKDOWN.
 */
function splitMarkdownToCards(markdown: string): GoogleChatCardSection[][] {
  const cards: GoogleChatCardSection[][] = []

  let sections: GoogleChatCardSection[] = []
  let widgetCount = 0
  let byteCount = 0
  let currentText = ''

  const startNewCard = () => {
    if (sections.length) cards.push(sections)
    sections = []
    widgetCount = 0
    byteCount = 0
  }

  const pushSection = (section: GoogleChatCardSection) => {
    // A header-only section still consumes layout budget; count it as one.
    const widgets = (section.widgets?.length ?? 0) + (section.header ? 1 : 0)
    const bytes = sectionBytes(section)
    // A heading section followed by its body must not split a card mid-thought
    // unless we genuinely overflow; honour the hard limits with margin.
    if (
      sections.length &&
      (widgetCount + widgets > MAX_WIDGETS_PER_CARD || byteCount + bytes > MAX_CARD_BYTES)
    ) {
      startNewCard()
    }
    sections.push(section)
    widgetCount += widgets
    byteCount += bytes
  }

  const flushText = () => {
    if (!currentText.trim()) {
      currentText = ''
      return
    }
    for (const widget of buildTextWidgets(currentText.trim())) {
      pushSection({ widgets: [widget] })
    }
    currentText = ''
  }

  for (const line of markdown.split('\n')) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)/)
    if (headingMatch) {
      flushText()
      pushSection({ header: headingMatch[1]!.slice(0, MAX_HEADER_CHARS), widgets: [] })
      continue
    }

    // Standalone Markdown image: Google Chat's card Markdown can't render
    // ![](), so emit a real image widget (public URL) instead of literal text.
    const imageMatch = line.match(/^\s*!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*$/)
    if (imageMatch) {
      flushText()
      const altText = imageMatch[1]!.trim()
      pushSection({
        widgets: [{ image: { imageUrl: imageMatch[2]!, ...(altText ? { altText } : {}) } }]
      })
      continue
    }

    currentText += line + '\n'
    if (currentText.length > MAX_TEXT_CHARS) flushText()
  }
  flushText()

  if (sections.length) cards.push(sections)
  return cards
}

function buildTextWidgets(text: string): GoogleChatCardWidget[] {
  return splitMarkdownText(text, MAX_TEXT_CHARS).map((part) => ({
    textParagraph: { text: part.slice(0, MAX_TEXT_CHARS), textSyntax: MARKDOWN }
  }))
}

/**
 * Wrap GitHub-flavoured Markdown tables in a fenced code block. Google Chat has
 * no table widget and no Markdown table support, so a fence keeps the columns
 * aligned in monospace rather than dumping raw `| a | b |` rows as prose.
 */
export function fenceMarkdownTables(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let inFence = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!

    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      out.push(line)
      continue
    }

    const next = lines[i + 1]
    const isTableStart =
      !inFence &&
      line.includes('|') &&
      next !== undefined &&
      next.includes('|') &&
      isTableSeparator(next)

    if (!isTableStart) {
      out.push(line)
      continue
    }

    const block: string[] = [line]
    i += 1
    while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
      block.push(lines[i]!)
      i += 1
    }
    i -= 1 // step back; outer loop re-increments
    out.push('```', ...block, '```')
  }

  return out.join('\n')
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.includes('-') && trimmed.includes('|') && /^[\s|:-]+$/.test(trimmed)
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

const PLAN_STATUS_ICON: Record<RendererTaskStatus, string> = {
  complete: '✅',
  in_progress: '⏳',
  error: '⚠️',
  pending: '◻️'
}

/**
 * Render the live task plan as a card: one decoratedText row per task so each
 * shows on its own line with a status glyph. Used to PATCH the "thinking" bubble
 * while the agent runs, giving Google Chat the task-timeline UX Slack has.
 */
export function taskPlanCard(
  tasks: RendererTask[],
  opts: { header?: string } = {}
): { cardId: string; card: GoogleChatCard } {
  const widgets: GoogleChatCardWidget[] = tasks
    .slice(0, chatReplyLimits.stream.maxPlanTasks)
    .map((task) => ({
      decoratedText: {
        text: `${PLAN_STATUS_ICON[task.status] ?? '◻️'} ${oneLine(task.title).slice(
          0,
          chatReplyLimits.stream.taskTitleChars
        )}`,
        wrapText: true
      }
    }))

  return {
    cardId: 'plan',
    card: {
      ...(opts.header ? { header: { title: opts.header.slice(0, MAX_HEADER_CHARS) } } : {}),
      sections: [{ widgets: widgets.length ? widgets : [{ textParagraph: { text: '…' } }] }]
    }
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Collapse Markdown into a short, single-line notification summary for `text`. */
function summarizeMarkdown(markdown: string): string {
  const firstBlock = markdown.split(/\n\s*\n/).find((b) => b.trim()) ?? markdown
  const plain = firstBlock
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~>#-]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return clampText(plain || 'Centaur update', chatReplyLimits.message.maxFallbackChars)
}

function clampText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

/** Rough serialized size of a section, used to keep a card under 32 KB. */
function sectionBytes(section: GoogleChatCardSection): number {
  let bytes = section.header ? section.header.length + 16 : 0
  for (const widget of section.widgets ?? []) {
    bytes += (widget.textParagraph?.text.length ?? 0) + 48
  }
  return bytes
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
