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

  // The card body and the plain `text` field disagree on newlines (verified live
  // by posting probe cards): a card textParagraph renders a single `\n` as a line
  // break but COLLAPSES a blank line (`\n\n`) to nothing, mashing consecutive
  // paragraphs onto one line ("…no new package releases.**Product & SDK**"). The
  // plain `text` field does the opposite (blank line = paragraph break). So
  // normalise the CARD source only — collapse blank lines to single breaks —
  // and flatten inline markup in card prose, which cards would otherwise
  // fragment onto separate lines (see flattenCardProseInline).
  const cards = splitMarkdownToCards(flattenCardProseInline(normalizeCardBreaks(fenced)))
  const cardsV2 = cards.slice(0, MAX_CARDS).map((card, index) => ({
    cardId: `card-${index}`,
    card: {
      ...(index === 0 && opts.header
        ? { header: { title: stripInlineMarkdown(opts.header).slice(0, MAX_HEADER_CHARS) } }
        : {}),
      sections: card
    }
  }))

  return {
    text: clampText(toChatTextMarkup(fenced), chatReplyLimits.message.maxPlainTextChars),
    cardsV2
  }
}

/**
 * Normalise a card's Markdown so Google Chat renders each block on its own line.
 * Empirically (probe cards posted to a live space): in a card textParagraph a
 * single `\n` is a line break, but a blank line (`\n\n`) collapses to nothing and
 * mashes the surrounding paragraphs; a blank line AFTER a list item is safe (the
 * list block forces the break); and `<br>` immediately before a list item orphans
 * the first item, so we never use it.
 *
 * Rules (fence-aware so monospace tables are never touched):
 *  - collapse a run of blank lines to a single `\n` break between two text lines;
 *  - keep ONE blank line when the previous content line is a list item (preserves
 *    a gap there and avoids a list→text lazy continuation);
 *  - drop standalone horizontal rules (`---`/`***`/`___`) — cards can't render them.
 * Card-path only; the plain `text` field already treats a blank line as a break.
 */
export function normalizeCardBreaks(markdown: string): string {
  const isListItem = (l: string) => /^\s*([-*+]|\d+\.)\s/.test(l)
  const isHorizontalRule = (l: string) => /^\s*([-*_])\1{2,}\s*$/.test(l)
  // A `<br>` directly before a list item orphans the item (renders literal), and
  // a card already breaks on a single `\n`, so a raw `<br>` the model emits is
  // redundant at best and harmful before a list — turn each into a real newline
  // (fence-aware: never touch `<br>` inside a ``` code block).
  const lines = expandBreaksOutsideFences(markdown)
  const out: string[] = []
  let inFence = false
  let lastContent: string | null = null
  let sawBlank = false

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      out.push(line)
      lastContent = line
      sawBlank = false
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (line.trim() === '') {
      sawBlank = true
      continue
    }
    if (isHorizontalRule(line)) continue // unsupported in cards; drop it

    // Re-emit the break before this line: a blank only after a list item.
    if (lastContent !== null && sawBlank && isListItem(lastContent)) out.push('')
    out.push(line)
    lastContent = line
    sawBlank = false
  }

  return out.join('\n')
}

/** Split into lines, turning `<br>` into newlines on non-fence lines only. */
function expandBreaksOutsideFences(markdown: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    out.push(...line.replace(/<br\s*\/?>/gi, '\n').split('\n'))
  }
  return out
}

/** Strip inline markdown that a card section `header` (plain text only) can't render. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]+)\]\([^)\s]+\)/g, '$1') // [label](url) / ![alt](url) → label
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // **bold** / __bold__ → bold
    .replace(/(\*|_)(.+?)\1/g, '$2') // *italic* / _italic_ → italic
    .replace(/~~(.+?)~~/g, '$1') // ~~strike~~ → strike
    .replace(/`([^`]+)`/g, '$1') // `code` → code
    .trim()
}

/**
 * Translate the GitHub-flavoured Markdown the agent emits into the Chat-flavoured
 * markup the plain `text` field actually renders. The `text` field does NOT
 * understand `**bold**`, `[label](url)`, or `# headings` — it renders `*bold*`,
 * `<url|label>`, and has no heading concept — so without this they leak as
 * literal asterisks, raw URLs, and `#` prefixes (observed live on a weather
 * answer). The plain surface is the primary one: card textParagraphs fragment
 * every inline span onto its own line (see NEEDS_CARD_RE in renderer.ts), so
 * answers are only readable here. Fence-aware: lines inside ``` blocks pass
 * through untouched (Chat renders the fence natively, and a `# comment` inside
 * code must not become a bold line).
 */
export function toChatTextMarkup(text: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    // `# Heading` → a bold line (`*Heading*`), the closest Chat-markup analog.
    // Inner markers are stripped first so `## **X**` nests to `*X*`, not `***X***`.
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading) {
      out.push(`*${stripInlineMarkdown(heading[1]!)}*`)
      continue
    }
    out.push(
      line
        // `[label](url)` → `<url|label>`; skip image embeds (`![alt](url)`).
        .replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>')
        // GFM `*italic*` → Chat `_italic_` — in Chat markup a single `*` is
        // BOLD, so leaving it would silently promote italics. Runs before the
        // `**bold**` conversion; the lookarounds keep it off `**` runs.
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '_$1_')
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*') // **bold** → *bold*
        .replace(/__([^_\n]+)__/g, '*$1*') // __bold__ → *bold*
        .replace(/~~([^~\n]+)~~/g, '~$1~') // ~~strike~~ → ~strike~
    )
  }
  return out.join('\n')
}

/**
 * Flatten inline markup in card PROSE lines so Google Chat cannot fragment it.
 * Card textParagraphs render every inline span in a top-level paragraph as its
 * own block — `Farao's **launch**, not` becomes three lines — for every markup
 * form (`**b**`, `*b*`, `<b>`, backtick code; textSyntax MARKDOWN and default
 * alike; probe cards, 2026-07-06). Exempt, markdown kept as-is:
 *  - list items — their inline spans render correctly in cards;
 *  - `#` heading lines — extracted into section headers downstream;
 *  - whole-line bold (`**Pseudo heading**`, record-list row titles) — the span
 *    already owns the line, so "fragmenting" it changes nothing and the bold
 *    is wanted.
 * Fences pass through untouched. Links become `label (url)` — an `<a>`/`[]()`
 * span would fragment too. Card-path only; the plain path renders inline
 * markup fine via toChatTextMarkup.
 */
export function flattenCardProseInline(markdown: string): string {
  const isListItem = (l: string) => /^\s*([-*+]|\d+\.)\s/.test(l)
  const isHeading = (l: string) => /^\s*#{1,6}\s/.test(l)
  const isWholeLineBold = (l: string) => /^\s*\*\*[^*]+\*\*:?\s*$/.test(l)
  const out: string[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence || isListItem(line) || isHeading(line) || isWholeLineBold(line)) {
      out.push(line)
      continue
    }
    out.push(
      line
        .replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)') // [label](url) → label (url)
        .replace(/(\*\*|__)([^*_\n]+)\1/g, '$2') // **bold** / __bold__ → bold
        .replace(/(\*|_)([^*_\n]+)\1/g, '$2') // *italic* / _italic_ → italic
        .replace(/~~([^~\n]+)~~/g, '$1') // ~~strike~~ → strike
        .replace(/`([^`\n]+)`/g, '$1') // `code` → code
    )
  }
  return out.join('\n')
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
      pushSection({
        header: stripInlineMarkdown(headingMatch[1]!).slice(0, MAX_HEADER_CHARS),
        widgets: []
      })
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
