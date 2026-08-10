import { describe, expect, test } from 'bun:test'
import {
  buildConsoleSessionWidget,
  defaultModelForHarness,
  defaultServiceTierForHarness,
  effectiveReasoningForHarness,
  reasoningForModel
} from './console-session-link'
import claudeSettings from '../../../harness/claude/settings.json'
import codexConfig from '../../../harness/codex/config.toml'

/** Harness/URL rendering is internal to the widget, so assert it through one. */
function widgetText(params: {
  consoleBaseUrl?: string | null
  harnessType?: string | null
  model?: string | null
}): string | undefined {
  return buildConsoleSessionWidget({
    consoleBaseUrl: undefined,
    threadKey: 'chat:spaces:A:1',
    metadataEnabled: true,
    ...params
  })?.textParagraph.text
}

describe('harness display names', () => {
  test('maps known harness wire values to display names', () => {
    expect(widgetText({ harnessType: 'codex' })).toBe('Codex')
    expect(widgetText({ harnessType: 'claudecode' })).toBe('Claude Code')
    expect(widgetText({ harnessType: 'amp' })).toBe('Amp')
  })

  test('is case-insensitive and trims', () => {
    expect(widgetText({ harnessType: ' Codex ' })).toBe('Codex')
    expect(widgetText({ harnessType: 'CLAUDECODE' })).toBe('Claude Code')
  })

  test('title-cases unknown harnesses', () => {
    expect(widgetText({ harnessType: 'my-custom-harness' })).toBe('My Custom Harness')
    expect(widgetText({ harnessType: 'gemini' })).toBe('Gemini')
  })

  test('drops the segment for empty or missing values', () => {
    expect(widgetText({ harnessType: undefined })).toBeUndefined()
    expect(widgetText({ harnessType: null })).toBeUndefined()
    expect(widgetText({ harnessType: '' })).toBeUndefined()
    expect(widgetText({ harnessType: '   ' })).toBeUndefined()
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

describe('console session URL', () => {
  test('builds the /console/threads URL with an encoded thread key', () => {
    expect(
      buildConsoleSessionWidget({
        consoleBaseUrl: 'https://console.centaur.dev',
        threadKey: 'chat:spaces:AAAA:spaces:AAAA:threads:BBBB',
        metadataEnabled: false
      })?.textParagraph.text
    ).toBe(
      '<a href="https://console.centaur.dev/console/threads?thread=chat%3Aspaces%3AAAAA%3Aspaces%3AAAAA%3Athreads%3ABBBB">Open chat in Console</a>'
    )
  })

  test('strips one or many trailing slashes from the base URL', () => {
    expect(widgetText({ consoleBaseUrl: 'https://console.centaur.dev///' })).toBe(
      '<a href="https://console.centaur.dev/console/threads?thread=chat%3Aspaces%3AA%3A1">Open chat in Console</a>'
    )
  })

  test('renders no link when no base URL is configured', () => {
    expect(widgetText({ consoleBaseUrl: undefined })).toBeUndefined()
    expect(widgetText({ consoleBaseUrl: null })).toBeUndefined()
    expect(widgetText({ consoleBaseUrl: '   ' })).toBeUndefined()
  })
})

describe('buildConsoleSessionWidget', () => {
  test('builds a textParagraph with linked label, uppercased model then harness, middot separated', () => {
    const widget = buildConsoleSessionWidget({
      consoleBaseUrl: 'https://console.centaur.dev',
      threadKey: 'chat:spaces:AAAA:spaces:AAAA:threads:BBBB',
      harnessType: 'codex',
      metadataEnabled: true,
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
      harnessType: 'claudecode',
      metadataEnabled: true
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
      metadataEnabled: true,
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

  test('renders metadata without a Console URL and can render the link alone', () => {
    expect(
      buildConsoleSessionWidget({
        consoleBaseUrl: undefined,
        threadKey: 'chat:spaces:A:1',
        harnessType: 'codex',
        metadataEnabled: true,
        model: 'gpt-5.6-sol'
      })?.textParagraph.text
    ).toBe('GPT-5.6-SOL · Codex')

    expect(
      buildConsoleSessionWidget({
        consoleBaseUrl: 'https://console.centaur.dev',
        threadKey: 'chat:spaces:A:1',
        metadataEnabled: false,
        model: 'gpt-5.6-sol'
      })?.textParagraph.text
    ).toBe(
      '<a href="https://console.centaur.dev/console/threads?thread=chat%3Aspaces%3AA%3A1">Open chat in Console</a>'
    )
  })
})

describe('response metadata controls', () => {
  test('reads and renders the baked Codex service tier', () => {
    const serviceTier = (codexConfig as { service_tier?: string }).service_tier
    expect(defaultServiceTierForHarness('codex')).toBe(serviceTier)
    expect(defaultServiceTierForHarness('nanocodex')).toBeUndefined()
    expect(
      buildConsoleSessionWidget({
        consoleBaseUrl: undefined,
        threadKey: 'chat:spaces:A:1',
        metadataEnabled: true,
        serviceTier: 'flex_tier'
      })?.textParagraph.text
    ).toBe('Flex Tier')
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
    expect(widgetText({ harnessType: 'nanocodex' })).toBe('Nanocodex')
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
    expect(effectiveReasoningForHarness('codex')).toBe(bakedCodexEffort)
    expect(effectiveReasoningForHarness('nanocodex')).toBe(bakedCodexEffort)
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
      metadataEnabled: true,
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
      metadataEnabled: true,
      model: 'claude-opus-5'
    })
    expect(widget?.textParagraph.text).toContain('CLAUDE-OPUS-5 · Claude Code')
    expect(widget?.textParagraph.text).not.toContain('·  ·')
  })
})
