import { test, expect, describe } from 'bun:test'
import { markdownToChatMessage, fenceMarkdownTables, toChatTextMarkup } from './render'
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

  test('fences and column-aligns tables instead of leaking raw pipes', () => {
    const md = '| name | age |\n| --- | --- |\n| bob | 30 |'
    const out = markdownToChatMessage(md)
    const joined = paragraphs(out)
      .map((p) => p.text)
      .join('\n')
    expect(joined).toContain('```')
    // Cells are padded to the column width; outer pipes are dropped.
    expect(joined).toContain('name | age')
    expect(joined).toContain('bob  | 30')
    expect(joined).not.toContain('| name | age |')
  })

  test('aligns ragged unpadded tables and tables without outer pipes', () => {
    const md = 'Metric | Value\n--- | ---\nLatency | 42ms\nErrors | 0'
    const out = markdownToChatMessage(md)
    // No outer pipes => not "rich" by the delivery heuristic, so the plain `text`
    // path must still carry an aligned, fenced table (never raw pipes).
    expect(out.text).toContain('```')
    expect(out.text).toContain('Metric  | Value')
    expect(out.text).toContain('Latency | 42ms')
    expect(out.text).not.toMatch(/\n[^`\n]*\|\s*\n/) // no unfenced pipe row leaks
  })

  test('wide / link-heavy tables become a responsive record list, not dash soup', () => {
    const md = [
      '| Live site | What it is | Repo |',
      '| --- | --- | --- |',
      '| [demo.openfort.io](https://demo.openfort.io/) | **"Openfort Examples"** — 7 interactive use-case demos: stablecoin transfer, agentic CFO, x402 paywall, DCA into Morpho | `openfort-xyz/demo-directory` |'
    ].join('\n')
    const out = markdownToChatMessage(md)
    const joined = paragraphs(out)
      .map((p) => p.text)
      .join('\n')
    // No fence and no giant dash separator — it would wrap unreadably on a card.
    expect(joined).not.toContain('```')
    expect(joined).not.toMatch(/-{20}/)
    // Row title + labelled bullets, with the link preserved (clickable, not raw).
    expect(joined).toContain('**[demo.openfort.io](https://demo.openfort.io/)**')
    expect(joined).toContain('- What it is: **"Openfort Examples"**')
    expect(joined).toContain('- Repo: `openfort-xyz/demo-directory`')
  })

  test('compact plain tables still render as an aligned monospace fence', () => {
    const md = '| name | age |\n| --- | --- |\n| bob | 30 |'
    const out = markdownToChatMessage(md)
    const joined = paragraphs(out)
      .map((p) => p.text)
      .join('\n')
    expect(joined).toContain('```')
    expect(joined).toContain('name | age')
  })

  test('table-first answers fence the table and keep the prose in the card body', () => {
    const md = '| name | age |\n| --- | --- |\n| bob | 30 |\n\nSummary prose here.'
    const out = markdownToChatMessage(md)
    const joined = paragraphs(out)
      .map((p) => p.text)
      .join('\n')
    expect(joined).toContain('```')
    expect(joined).toContain('Summary prose here')
  })

  test('plain text path keeps the full answer', () => {
    const long = 'x'.repeat(10_000)
    const out = markdownToChatMessage(long)
    expect(out.text.length).toBe(10_000)
  })

  test('plain text path translates GFM the text field cannot render into Chat markup', () => {
    const md = '**Barcelona ~29°C, sunny** — Sources: [Met Office](https://w.example/sp3) · [AccuWeather](https://a.example/bcn)'
    const out = markdownToChatMessage(md)
    // No leaked GFM: bold double-asterisks and `[label](url)` are gone.
    expect(out.text).not.toContain('**')
    expect(out.text).not.toContain('](http')
    // Rendered as Chat-flavoured bold + `<url|label>` links.
    expect(out.text).toContain('*Barcelona ~29°C, sunny*')
    expect(out.text).toContain('<https://w.example/sp3|Met Office>')
    expect(out.text).toContain('<https://a.example/bcn|AccuWeather>')
  })

  test('toChatTextMarkup leaves image embeds and plain prose untouched', () => {
    expect(toChatTextMarkup('plain prose, no markup')).toBe('plain prose, no markup')
    expect(toChatTextMarkup('![alt](https://img.example/x.png)')).toBe('![alt](https://img.example/x.png)')
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
