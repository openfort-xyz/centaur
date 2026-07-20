import type { AppConfig } from './config'
import {
  extractMessageOverrides,
  validateStrategyOverrides,
  type MessageOverrides
} from './overrides'
import { logInfo, logWarn } from './logging'

const DEFAULT_TIMEOUT_MS = 1_500
const DEFAULT_MAX_OUTPUT_TOKENS = 300

const SYSTEM_PROMPT = [
  'Decide whether the Google Chat message asks to use a specific AI harness, model, provider, or reasoning effort.',
  'Return only canonical override values from the schema.',
  'Use null for every field when the message does not ask to change model selection.',
  'Allowed harness values: codex, claudecode, amp.',
  'Allowed provider values: responses, amazon-bedrock, openrouter.',
  'Allowed reasoning values: none, minimal, low, medium, high, xhigh, max.',
  'Map fuzzy effort words to the nearest reasoning value by magnitude. Examples: tiny/cheap/fast -> low or minimal; normal/default -> medium; deep/strong/intense -> high or xhigh; maximum/superduper/biggest -> max.',
  'Return reasoning even when the requested model is not Codex; validation will ignore reasoning that cannot apply.',
  'Map OpenAI model aliases to canonical IDs: sol -> gpt-5.6-sol, terra -> gpt-5.6-terra, luna -> gpt-5.6-luna, 5.5 -> gpt-5.5, 5.5 pro -> gpt-5.5-pro, 5.4 -> gpt-5.4, 5.4 pro -> gpt-5.4-pro, 5.4 mini -> gpt-5.4-mini, 5.4 nano -> gpt-5.4-nano.',
  'Map Claude model aliases to canonical IDs: fable -> claude-fable-5, opus -> claude-opus-4-8, sonnet -> claude-sonnet-4-6, sonnet 5 -> claude-sonnet-5, haiku -> claude-haiku-4-5.',
  'Map Amp model aliases to canonical IDs: deep -> deep, fast -> fast.',
  'For example, "use max effort and the sol model" should return model "gpt-5.6-sol" and reasoning "max".',
  'Do not treat ordinary discussion of model names as a selection request.'
].join('\n')

const MODEL_VALUES = [
  'claude-fable-5',
  'claude-haiku-4-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'deep',
  'fast',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4-pro',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  null
] as const

const MESSAGE_OVERRIDES_SCHEMA = {
  additionalProperties: false,
  properties: {
    harness: {
      enum: ['codex', 'claudecode', 'amp', null],
      type: ['string', 'null']
    },
    model: {
      enum: MODEL_VALUES,
      type: ['string', 'null']
    },
    provider: {
      enum: ['responses', 'amazon-bedrock', 'openrouter', null],
      type: ['string', 'null']
    },
    reasoning: {
      enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', null],
      type: ['string', 'null']
    }
  },
  required: ['harness', 'model', 'provider', 'reasoning'],
  type: 'object'
}

/**
 * Resolves harness/model/provider/reasoning overrides (and any text cleanup
 * they imply) from a raw user message. `createFlagMessageOverridesStrategy`
 * (the default) parses literal `--flags`; `createOpenAiMessageOverridesStrategy`
 * asks an LLM to interpret natural-language requests instead.
 */
export type MessageOverridesStrategy = (text: string) => Promise<MessageOverrides>

export type OpenAiMessageOverridesStrategyOptions = {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
  maxOutputTokens?: number
  model: string
  timeoutMs?: number
}

type OpenAiMessageOverridesStrategyOutput = {
  harness?: unknown
  model?: unknown
  provider?: unknown
  reasoning?: unknown
}

export function createFlagMessageOverridesStrategy(): MessageOverridesStrategy {
  return async text => extractMessageOverrides(text)
}

/** Strip trailing slashes without a `/+$/`-style regex, which CodeQL (rightly)
 * flags as quadratic-time on a long run of slashes. */
function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end -= 1
  return value.slice(0, end)
}

export function createOpenAiMessageOverridesStrategy(
  options: OpenAiMessageOverridesStrategyOptions
): MessageOverridesStrategy {
  const responsesUrl = `${stripTrailingSlashes(options.baseUrl ?? 'https://api.openai.com/v1')}/responses`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const fetchFn = options.fetch ?? fetch

  return async text => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchFn(responsesUrl, {
        body: JSON.stringify({
          input: text,
          instructions: SYSTEM_PROMPT,
          max_output_tokens: maxOutputTokens,
          model: options.model,
          reasoning: { effort: 'none' },
          store: false,
          text: {
            format: {
              name: 'google_chat_message_overrides',
              schema: MESSAGE_OVERRIDES_SCHEMA,
              strict: true,
              type: 'json_schema'
            }
          }
        }),
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json'
        },
        method: 'POST',
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(
          `message overrides strategy request failed with HTTP ${response.status} ${response.statusText}`
        )
      }
      const value = await response.json()
      const outputText = responseOutputText(value)
      logInfo('googlechatbot_message_overrides_strategy_response_received', {
        model: options.model,
        output_text: outputText
      })
      if (!outputText) {
        throw new Error('message overrides strategy response did not include output text')
      }
      const parsed = JSON.parse(outputText)
      return {
        cleanedText: text,
        ...validateStrategyOverrides(
          isJsonObject(parsed) ? (parsed as OpenAiMessageOverridesStrategyOutput) : null
        )
      }
    } catch (error) {
      logWarn('googlechatbot_message_overrides_strategy_request_failed', {
        error: errorMessage(error),
        model: options.model,
        timeout_ms: timeoutMs
      })
      return { cleanedText: text }
    } finally {
      clearTimeout(timeout)
    }
  }
}

function responseOutputText(value: unknown): string | undefined {
  const parts = arrayValue(isJsonObject(value) ? value.output : undefined).flatMap(item =>
    arrayValue(isJsonObject(item) ? item.content : undefined).flatMap(content =>
      isJsonObject(content) && typeof content.text === 'string' ? [content.text] : []
    )
  )
  return parts.length > 0 ? parts.join('\n') : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

let cachedStrategy: MessageOverridesStrategy | undefined
let cachedStrategyConfig: AppConfig | undefined

/**
 * Build (and memoize, per config identity) the message-overrides strategy a
 * deployment is configured for. Called once per config from `driveSession` --
 * cheap either way, since neither strategy does eager setup, but memoizing
 * avoids re-validating the OpenAI options on every inbound message.
 */
export function messageOverridesStrategyFromConfig(config: AppConfig): MessageOverridesStrategy {
  if (cachedStrategy && cachedStrategyConfig === config) return cachedStrategy
  const strategy = buildMessageOverridesStrategy(config)
  cachedStrategy = strategy
  cachedStrategyConfig = config
  return strategy
}

function buildMessageOverridesStrategy(config: AppConfig): MessageOverridesStrategy {
  if (config.GOOGLECHATBOT_MESSAGE_OVERRIDES_STRATEGY !== 'llm') {
    return createFlagMessageOverridesStrategy()
  }
  const apiKey =
    config.GOOGLECHATBOT_MESSAGE_OVERRIDES_OPENAI_API_KEY || config.OPENAI_API_KEY
  if (!apiKey) {
    logWarn('googlechatbot_message_overrides_strategy_missing_api_key', {
      strategy: 'llm'
    })
    return async text => ({ cleanedText: text })
  }
  return createOpenAiMessageOverridesStrategy({
    apiKey,
    baseUrl: config.GOOGLECHATBOT_MESSAGE_OVERRIDES_OPENAI_BASE_URL,
    maxOutputTokens: config.GOOGLECHATBOT_MESSAGE_OVERRIDES_MAX_OUTPUT_TOKENS,
    model: config.GOOGLECHATBOT_MESSAGE_OVERRIDES_MODEL,
    timeoutMs: config.GOOGLECHATBOT_MESSAGE_OVERRIDES_TIMEOUT_MS
  })
}
