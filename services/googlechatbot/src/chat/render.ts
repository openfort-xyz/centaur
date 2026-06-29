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
  cardsV2?: Array<{ cardId: string; card: GoogleChatCard }>
} {
  const trimmed = markdown.trim() || ' '
  // Google Chat renders no table on any surface, so re-emit Markdown tables as
  // either a column-aligned monospace fence (compact, plain tables) or a
  // responsive record list (wide/link-heavy tables). Applied to BOTH the card
  // body and the plain-text path so a table never leaks raw `| a | b |` pipes
  // or dash soup regardless of which delivery path is taken. (Name kept for the
  // public test import; it now does more than fence.)
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
    text: clampText(fenced, chatReplyLimits.message.maxPlainTextChars),
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

/** A monospace fence wider than this wraps (never scrolls) on a Chat card. */
const MAX_FENCED_TABLE_WIDTH = 64

/**
 * Convert GitHub-flavoured Markdown tables into something Google Chat can render
 * legibly. Chat has no table widget and renders no Markdown/HTML table on any
 * surface, and its monospace code blocks WRAP rather than scroll — so a wide
 * aligned table collapses into dash soup (as seen with prose/link-heavy tables).
 *
 * Strategy per table:
 *  - compact + plain  → column-aligned monospace fence (a real little table);
 *  - wide OR contains links/inline markdown → a responsive record list
 *    (`**row title**` + `- Column: value` bullets) that wraps naturally and
 *    keeps links clickable (a fence would show `[text](url)` raw).
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
    out.push(...renderMarkdownTable(block))
  }

  return out.join('\n')
}

/** Pick the legible rendering for one GFM table block. */
function renderMarkdownTable(block: string[]): string[] {
  const rows = block.map(splitTableRow)
  const aligned = alignMarkdownTable(rows)
  const widest = Math.max(0, ...aligned.map(line => line.length))
  // Links/images can't render inside a fence, and prose cells overflow the card
  // width; either way, a record list reads far better than a wrapped grid.
  const hasInlineMarkdown = block.some(line => /\]\(|!\[/.test(line))
  if (widest <= MAX_FENCED_TABLE_WIDTH && !hasInlineMarkdown) {
    return ['```', ...aligned, '```']
  }
  return tableRowsToList(rows)
}

/**
 * Column-align a parsed table (header, separator, data rows) into fixed-width
 * monospace lines. The separator is rebuilt with dashes sized to each column;
 * GFM alignment colons are dropped (no effect in a monospace block).
 */
function alignMarkdownTable(rows: string[][]): string[] {
  const columnCount = Math.max(0, ...rows.map(row => row.length))
  const widths = Array.from({ length: columnCount }, (_, c) =>
    Math.max(3, ...rows.map((row, idx) => (idx === 1 ? 0 : (row[c]?.length ?? 0))))
  )

  return rows.map((row, idx) => {
    if (idx === 1) {
      return widths.map(width => '-'.repeat(width)).join(' | ')
    }
    return widths
      .map((width, c) => (row[c] ?? '').padEnd(width))
      .join(' | ')
      .replace(/\s+$/, '')
  })
}

/**
 * Render a table as a responsive record list: each data row becomes a bold
 * first-cell title followed by `- Header: value` bullets for the rest. This
 * wraps cleanly on narrow Chat cards and preserves clickable links/markdown.
 */
function tableRowsToList(rows: string[][]): string[] {
  const header = rows[0] ?? []
  const out: string[] = []

  for (const row of rows.slice(2)) {
    if (!row.some(cell => cell.trim())) continue
    const title = row[0]?.trim()
    if (title) out.push(`**${title}**`)
    for (let c = 1; c < Math.max(header.length, row.length); c += 1) {
      const value = row[c]?.trim()
      if (!value) continue
      const label = header[c]?.trim()
      out.push(label ? `- ${label}: ${value}` : `- ${value}`)
    }
    out.push('')
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

/** Split one table row into trimmed cells, dropping the leading/trailing pipes. */
function splitTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  // Split on unescaped pipes so `\|` inside a cell is kept, then unescape it.
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim())
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
