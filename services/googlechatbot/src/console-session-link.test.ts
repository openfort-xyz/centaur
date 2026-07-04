import { describe, expect, test } from 'bun:test'
import {
  buildConsoleSessionWidget,
  consoleSessionUrl,
  defaultModelForHarness,
  harnessDisplayName
} from './console-session-link'
import claudeSettings from '../../../harness/claude/settings.json'
import codexConfig from '../../../harness/codex/config.toml'

describe('harnessDisplayName', () => {
  test('maps known harness wire values to display names', () => {
    expect(harnessDisplayName('codex')).toBe('Codex')
    expect(harnessDisplayName('claudecode')).toBe('Claude Code')
    expect(harnessDisplayName('amp')).toBe('Amp')
  })

  test('is case-insensitive and trims', () => {
    expect(harnessDisplayName(' Codex ')).toBe('Codex')
    expect(harnessDisplayName('CLAUDECODE')).toBe('Claude Code')
  })

  test('title-cases unknown harnesses', () => {
    expect(harnessDisplayName('my-custom-harness')).toBe('My Custom Harness')
    expect(harnessDisplayName('gemini')).toBe('Gemini')
  })

  test('returns undefined for empty or missing values', () => {
    expect(harnessDisplayName(undefined)).toBeUndefined()
    expect(harnessDisplayName(null)).toBeUndefined()
    expect(harnessDisplayName('')).toBeUndefined()
    expect(harnessDisplayName('   ')).toBeUndefined()
  })
})

describe('defaultModelForHarness', () => {
  const bakedClaudeModel = claudeSettings.model
  const bakedCodexModel = (codexConfig as { model: string }).model

  test('reads the baked default model from the repo harness config files', () => {
    expect(bakedClaudeModel).toBeTruthy()
    expect(bakedCodexModel).toBeTruthy()
    expect(defaultModelForHarness('claudecode')).toBe(bakedClaudeModel)
    expect(defaultModelForHarness('codex')).toBe(bakedCodexModel)
  })

  test('prefers the deployment-configured model over the baked default', () => {
    const configured = { claudecode: 'claude-fable-5' }
    expect(defaultModelForHarness('claudecode', configured)).toBe('claude-fable-5')
    expect(defaultModelForHarness('codex', configured)).toBe(bakedCodexModel)
    expect(defaultModelForHarness('claudecode', { claudecode: '   ' })).toBe(bakedClaudeModel)
  })

  test('is case-insensitive and trims', () => {
    expect(defaultModelForHarness(' CLAUDECODE ')).toBe(bakedClaudeModel)
  })

  test('returns undefined for harnesses without a fixed default', () => {
    expect(defaultModelForHarness('amp')).toBeUndefined()
    expect(defaultModelForHarness('gemini')).toBeUndefined()
    expect(defaultModelForHarness(undefined)).toBeUndefined()
    expect(defaultModelForHarness(null)).toBeUndefined()
    expect(defaultModelForHarness('')).toBeUndefined()
  })
})

describe('consoleSessionUrl', () => {
  test('builds the /console/threads URL with an encoded thread key', () => {
    expect(
      consoleSessionUrl(
        'https://console.centaur.dev',
        'chat:spaces:AAAA:spaces:AAAA:threads:BBBB'
      )
    ).toBe(
      'https://console.centaur.dev/console/threads?thread=chat%3Aspaces%3AAAAA%3Aspaces%3AAAAA%3Athreads%3ABBBB'
    )
  })

  test('strips trailing slashes from the base URL', () => {
    expect(consoleSessionUrl('https://console.centaur.dev/', 'chat:spaces:A:1')).toBe(
      'https://console.centaur.dev/console/threads?thread=chat%3Aspaces%3AA%3A1'
    )
  })

  test('returns undefined when no base URL is configured', () => {
    expect(consoleSessionUrl(undefined, 'chat:spaces:A:1')).toBeUndefined()
    expect(consoleSessionUrl(null, 'chat:spaces:A:1')).toBeUndefined()
    expect(consoleSessionUrl('   ', 'chat:spaces:A:1')).toBeUndefined()
  })
})

describe('buildConsoleSessionWidget', () => {
  test('builds a textParagraph with linked label, uppercased model then harness, middot separated', () => {
    const widget = buildConsoleSessionWidget({
      consoleBaseUrl: 'https://console.centaur.dev',
      threadKey: 'chat:spaces:AAAA:spaces:AAAA:threads:BBBB',
      harnessType: 'codex',
      model: 'gpt-5.2'
    })
    expect(widget).toEqual({
      textParagraph: {
        text:
          '<a href="https://console.centaur.dev/console/threads?thread=chat%3Aspaces%3AAAAA%3Aspaces%3AAAAA%3Athreads%3ABBBB">Open chat in Console</a> · GPT-5.2 · Codex'
      }
    })
  })

  test('omits the model segment when no model is provided', () => {
    const widget = buildConsoleSessionWidget({
      consoleBaseUrl: 'https://console.centaur.dev',
      threadKey: 'chat:spaces:A:1',
      harnessType: 'claudecode'
    })
    expect(widget?.textParagraph.text).toBe(
      '<a href="https://console.centaur.dev/console/threads?thread=chat%3Aspaces%3AA%3A1">Open chat in Console</a> · Claude Code'
    )
  })

  test('escapes HTML-significant characters in model and harness segments', () => {
    const widget = buildConsoleSessionWidget({
      consoleBaseUrl: 'https://console.centaur.dev',
      threadKey: 'chat:spaces:A:1',
      harnessType: 'a<b&c',
      model: 'm<one>&two'
    })
    expect(widget?.textParagraph.text).toContain('M&lt;ONE&gt;&amp;TWO')
    expect(widget?.textParagraph.text).toContain('A&lt;b&amp;c')
  })

  test('skips the widget entirely when no console base URL is set', () => {
    expect(
      buildConsoleSessionWidget({
        consoleBaseUrl: undefined,
        threadKey: 'chat:spaces:A:1',
        harnessType: 'codex',
        model: 'gpt-5.2'
      })
    ).toBeUndefined()
  })
})
