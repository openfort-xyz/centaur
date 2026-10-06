import { describe, expect, test } from 'bun:test'
import {
  buildResponseContextWidget,
  defaultModelForHarness,
  defaultServiceTierForHarness,
  effectiveReasoningForHarness,
  personaFallbackNotice,
  reasoningForModel
} from './response-context'
import claudeSettings from '../../../harness/claude/settings.json'
import codexConfig from '../../../harness/codex/config.toml'

/** Harness rendering is internal to the widget, so assert it through one. */
function widgetText(params: {
  harnessType?: string | null
  model?: string | null
}): string | undefined {
  return buildResponseContextWidget({
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

describe('buildResponseContextWidget', () => {
  test('builds a textParagraph with model then harness, middot separated', () => {
    const widget = buildResponseContextWidget({
      harnessType: 'codex',
      metadataEnabled: true,
      model: 'gpt-5.2'
    })
    expect(widget).toEqual({
      textParagraph: {
        text:
          'GPT 5.2 · Codex'
      }
    })
  })

  test('omits the model segment when no model is provided', () => {
    const widget = buildResponseContextWidget({
      harnessType: 'claudecode',
      metadataEnabled: true
    })
    expect(widget?.textParagraph.text).toBe(
      'Claude Code'
    )
  })

  test('escapes HTML-significant characters in model and harness segments', () => {
    const widget = buildResponseContextWidget({
      harnessType: 'a<b&c',
      metadataEnabled: true,
      model: 'm<one>&two'
    })
    expect(widget?.textParagraph.text).toContain('M&lt;ONE&gt;&amp;TWO')
    expect(widget?.textParagraph.text).toContain('A&lt;b&amp;c')
  })

  test('skips the widget when metadata is disabled', () => {
    expect(
      buildResponseContextWidget({
        harnessType: 'codex',
        model: 'gpt-5.2'
      })
    ).toBeUndefined()
  })

  test('renders metadata only when enabled', () => {
    expect(
      buildResponseContextWidget({
        harnessType: 'codex',
        metadataEnabled: true,
        model: 'gpt-5.6-sol'
      })?.textParagraph.text
    ).toBe('Sol 5.6 · Codex')

    expect(
      buildResponseContextWidget({
        metadataEnabled: false,
        model: 'gpt-5.6-sol'
      })?.textParagraph.text
    ).toBeUndefined()
  })
})

describe('response metadata controls', () => {
  test('reads and renders the baked Codex service tier', () => {
    const serviceTier = (codexConfig as { service_tier?: string }).service_tier
    expect(defaultServiceTierForHarness('codex')).toBe(serviceTier)
    expect(defaultServiceTierForHarness('nanocodex')).toBeUndefined()
    expect(
      buildResponseContextWidget({
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
    expect(effectiveReasoningForHarness('claudecode', 'high')).toBe('high')
    expect(effectiveReasoningForHarness('pi', 'medium')).toBe('medium')
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

  test('supports Claude effort and drops unknown Codex models', () => {
    expect(reasoningForModel('claudecode', 'claude-opus-5', 'high')).toBe('high')
    expect(reasoningForModel('claudecode', 'claude-haiku-4-5', 'high')).toBeUndefined()
    expect(reasoningForModel('claudecode', 'claude-sonnet-4-6', 'xhigh')).toBeUndefined()
    expect(reasoningForModel('pi', undefined, 'max')).toBe('max')
    expect(reasoningForModel('pi', undefined, 'ultra')).toBeUndefined()
    expect(reasoningForModel('codex', 'gpt-unknown', 'high')).toBeUndefined()
  })

  test('validates Nanocodex minimal as its effective low effort', () => {
    expect(reasoningForModel('nanocodex', 'gpt-5.6-terra', 'minimal')).toBe('minimal')
  })
})

describe('buildResponseContextWidget effort segment', () => {
  test('appends the effort after the harness, middot separated', () => {
    const widget = buildResponseContextWidget({
      harnessType: 'nanocodex',
      metadataEnabled: true,
      model: 'gpt-5.2',
      reasoning: 'xhigh'
    })
    expect(widget?.textParagraph.text).toContain('GPT 5.2 · Nanocodex · XHigh')
  })

  test('omits the segment when no effort applies', () => {
    const widget = buildResponseContextWidget({
      harnessType: 'claudecode',
      metadataEnabled: true,
      model: 'claude-opus-5'
    })
    expect(widget?.textParagraph.text).toContain('Opus 5 · Claude Code')
    expect(widget?.textParagraph.text).not.toContain('·  ·')
  })
})

// Upstream #1598 parity: api-rs may replace an unavailable requested persona;
// the trailer says so even when metadata is disabled.
describe('persona fallback notice', () => {
  test('names the replacement or the absence of a persona', () => {
    expect(personaFallbackNotice(undefined, 'eng')).toBeUndefined()
    expect(personaFallbackNotice('ghost', 'eng')).toBe(
      'Persona "ghost" isn\'t available. Using "eng" instead.'
    )
    expect(personaFallbackNotice('ghost', null)).toBe(
      'Persona "ghost" isn\'t available. Continuing without a persona.'
    )
  })

  test('renders the notice first, HTML-escaped, and alone if needed', () => {
    expect(
      buildResponseContextWidget({
        metadataEnabled: false,
        notice: 'Persona "<x>" isn\'t available. Continuing without a persona.'
      })?.textParagraph.text
    ).toBe('⚠️ Persona "&lt;x&gt;" isn\'t available. Continuing without a persona.')

    expect(
      buildResponseContextWidget({
        harnessType: 'codex',
        metadataEnabled: true,
        model: 'gpt-6-astra',
        notice: 'n',
        reasoning: 'ultra'
      })?.textParagraph.text
    ).toBe('⚠️ n · Astra 6 · Codex · Ultra')
  })
})

describe('gpt-6-astra efforts', () => {
  test('accepts ultra on astra only', () => {
    expect(reasoningForModel('codex', 'gpt-6-astra', 'ultra')).toBe('ultra')
    expect(reasoningForModel('codex', 'gpt-6-astra', 'minimal')).toBeUndefined()
    expect(reasoningForModel('codex', 'gpt-5.6-sol', 'ultra')).toBeUndefined()
  })
})

for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
  test(`${model} preserves supported reasoning and rejects ultra`, () => {
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(reasoningForModel('codex', model, effort)).toBe(effort)
    }
    expect(reasoningForModel('codex', model, 'ultra')).toBeUndefined()
    expect(reasoningForModel('codex', model, 'minimal')).toBeUndefined()
  })
}
