import { describe, expect, test } from 'bun:test'
import {
  buildConsoleSessionWidget,
  consoleSessionUrl,
  defaultModelForHarness,
  defaultReasoningForHarness,
  effectiveReasoningForHarness,
  harnessDisplayName,
  reasoningForModel
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

// Upstream #1178/#1179 parity: api-rs may route a Codex request onto Nanocodex,
// so the trailer has to name the harness that actually runs and the effort it
// applies. See SLACK_PARITY.md §8.
describe('nanocodex harness parity', () => {
  const bakedCodexModel = (codexConfig as { model: string }).model
  const bakedCodexEffort = (codexConfig as { model_reasoning_effort?: string })
    .model_reasoning_effort

  test('nanocodex renders as a first-class harness name', () => {
    expect(harnessDisplayName('nanocodex')).toBe('Nanocodex')
  })

  test('nanocodex shares the baked Codex default model', () => {
    expect(defaultModelForHarness('nanocodex')).toBe(bakedCodexModel)
  })

  test('nanocodex shares the CODEX_MODEL deployment override', () => {
    expect(defaultModelForHarness('nanocodex', { nanocodex: 'gpt-override' })).toBe(
      'gpt-override'
    )
  })

  test('defaults to the baked Codex effort for both Codex-family harnesses', () => {
    expect(bakedCodexEffort).toBeTruthy()
    expect(defaultReasoningForHarness('codex')).toBe(bakedCodexEffort)
    expect(defaultReasoningForHarness('nanocodex')).toBe(bakedCodexEffort)
  })
})

describe('effectiveReasoningForHarness', () => {
  test('prefers the requested effort over the configured default', () => {
    expect(effectiveReasoningForHarness('codex', 'high', { codex: 'medium' })).toBe('high')
  })

  test('falls back to the configured default, then the baked one', () => {
    expect(effectiveReasoningForHarness('codex', undefined, { codex: 'xhigh' })).toBe('xhigh')
    expect(effectiveReasoningForHarness('codex', '   ', { codex: 'xhigh' })).toBe('xhigh')
  })

  test('folds Minimal into Low for nanocodex, which has no Minimal level', () => {
    expect(effectiveReasoningForHarness('nanocodex', 'minimal')).toBe('low')
    expect(effectiveReasoningForHarness('codex', 'minimal')).toBe('minimal')
  })

  test('returns undefined for harnesses without a reasoning knob', () => {
    expect(effectiveReasoningForHarness('claudecode', 'high')).toBeUndefined()
    expect(effectiveReasoningForHarness('amp', 'high')).toBeUndefined()
    expect(effectiveReasoningForHarness(undefined, 'high')).toBeUndefined()
  })
})

describe('reasoningForModel', () => {
  test('accepts only efforts supported by the selected Codex model', () => {
    expect(reasoningForModel('codex', 'gpt-5.6-sol', 'max')).toBe('max')
    expect(reasoningForModel('codex', 'gpt-5.4-pro', 'low')).toBeUndefined()
    expect(reasoningForModel('codex', 'gpt-5.4-pro', 'high')).toBe('high')
  })

  test('drops reasoning for non-Codex harnesses and unknown models', () => {
    expect(reasoningForModel('claudecode', 'claude-opus-5', 'high')).toBeUndefined()
    expect(reasoningForModel('codex', 'gpt-unknown', 'high')).toBeUndefined()
  })

  test('validates Nanocodex minimal as its effective low effort', () => {
    expect(reasoningForModel('nanocodex', 'gpt-5.6-terra', 'minimal')).toBe('minimal')
  })
})

describe('buildConsoleSessionWidget effort segment', () => {
  test('appends the effort after the harness, middot separated', () => {
    const widget = buildConsoleSessionWidget({
      consoleBaseUrl: 'https://console.centaur.dev',
      threadKey: 'chat:spaces:A:1',
      harnessType: 'nanocodex',
      model: 'gpt-5.2',
      reasoning: 'xhigh'
    })
    expect(widget?.textParagraph.text).toContain('GPT-5.2 · Nanocodex · XHigh')
  })

  test('omits the segment when no effort applies', () => {
    const widget = buildConsoleSessionWidget({
      consoleBaseUrl: 'https://console.centaur.dev',
      threadKey: 'chat:spaces:A:1',
      harnessType: 'claudecode',
      model: 'claude-opus-5'
    })
    expect(widget?.textParagraph.text).toContain('CLAUDE-OPUS-5 · Claude Code')
    expect(widget?.textParagraph.text).not.toContain('·  ·')
  })
})
