import { test, expect, describe } from 'bun:test'
import { markdownToChatMessage, fenceMarkdownTables } from './render'
import { chatReplyLimits } from '../constants'

type TextParagraph = { text: string; textSyntax?: 'MARKDOWN' | 'HTML' }

function paragraphs(out: ReturnType<typeof markdownToChatMessage>): TextParagraph[] {
  const widgets = (out.cardsV2 ?? []).flatMap((c) => c.card.sections ?? []).flatMap((s) => s.widgets ?? [])
  return widgets.map((w) => w.textParagraph).filter((p): p is TextParagraph => Boolean(p))
}

describe('markdownToChatMessage', () => {
  test('renders body text as MARKDOWN so inline formatting and links survive', () => {
    const out = markdownToChatMessage('Here is **bold** and a [link](https://example.com).')
    const ps = paragraphs(out)
    expect(ps.length).toBeGreaterThan(0)
    expect(ps.every((p) => p.textSyntax === 'MARKDOWN')).toBe(true)
    // Raw Markdown is preserved verbatim (Google Chat renders it natively).
    expect(ps[0]!.text).toContain('**bold**')
    expect(ps[0]!.text).toContain('[link](https://example.com)')
  })

  test('keeps fenced code blocks intact', () => {
    const out = markdownToChatMessage('Run this:\n```ts\nconst x = 1\n```')
    const joined = paragraphs(out)
      .map((p) => p.text)
      .join('\n')
    expect(joined).toContain('```')
    expect(joined).toContain('const x = 1')
  })

  test('renders standalone Markdown images as image widgets', () => {
    const out = markdownToChatMessage('Look:\n![a diagram](https://example.com/x.png)')
    const widgets = (out.cardsV2 ?? [])
      .flatMap((c) => c.card.sections ?? [])
      .flatMap((s) => s.widgets ?? [])
    const image = widgets.find((w) => w.image)?.image
    expect(image?.imageUrl).toBe('https://example.com/x.png')
    expect(image?.altText).toBe('a diagram')
  })

  test('maps headings to section headers', () => {
    const out = markdownToChatMessage('# Title\nbody text')
    const headers = (out.cardsV2 ?? []).flatMap((c) => c.card.sections ?? []).map((s) => s.header)
    expect(headers).toContain('Title')
  })

  test('fences tables instead of leaking raw pipes', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const out = markdownToChatMessage(md)
    const joined = paragraphs(out)
      .map((p) => p.text)
      .join('\n')
    expect(joined).toContain('```')
    expect(joined).toContain('| a | b |')
  })

  test('plain text path keeps the full answer; summary stays short', () => {
    const long = 'x'.repeat(10_000)
    const out = markdownToChatMessage(long)
    expect(out.text.length).toBeGreaterThan(chatReplyLimits.message.maxFallbackChars)
    expect(out.fallbackText.length).toBeLessThanOrEqual(chatReplyLimits.message.maxFallbackChars + 1)
  })

  test('splits into multiple cards before exceeding the per-card widget limit', () => {
    // Many headings => many sections/widgets; must roll into >1 card.
    const md = Array.from({ length: 200 }, (_, i) => `# H${i}\nline ${i}`).join('\n')
    const out = markdownToChatMessage(md)
    for (const entry of out.cardsV2 ?? []) {
      const widgets = (entry.card.sections ?? []).reduce(
        (n, s) => n + (s.header ? 1 : 0) + (s.widgets?.length ?? 0),
        0
      )
      expect(widgets).toBeLessThanOrEqual(chatReplyLimits.card.maxWidgetsPerCard + 1)
    }
  })
})

describe('fenceMarkdownTables', () => {
  test('does not double-fence tables already inside a code block', () => {
    const md = '```\n| a | b |\n| --- | --- |\n```'
    expect(fenceMarkdownTables(md)).toBe(md)
  })
})
