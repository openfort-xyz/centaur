import type { AppConfig } from './config'
import {
  extractMessageOverrides,
  validateStrategyOverrides,
  STRATEGY_HARNESSES,
  STRATEGY_MODEL_HARNESSES,
  STRATEGY_PROVIDERS,
  STRATEGY_REASONING_EFFORTS,
  type MessageOverrides
} from './overrides'
import { logInfo, logWarn } from './logging'
import { stripTrailingSlashes } from './url'

const DEFAULT_TIMEOUT_MS = 2_000
const DEFAULT_MAX_OUTPUT_TOKENS = 300

const SYSTEM_PROMPT = [
  'Decide whether the Google Chat message asks to use a specific AI harness, model, provider, or reasoning effort.',
  'Return only canonical override values from the schema.',
  'Use null for every field when the message does not ask to change model selection.',
  'Allowed harness values: codex, claudecode, amp, nanocodex, hermes.',
  'Allowed provider values: responses, amazon-bedrock, openrouter.',
  'Allowed reasoning values: none, minimal, low, medium, high, xhigh, max.',
  'Treat inline flags such as "--claude", "--claude --model=fable", and "--fable" as model selection requests.',
  'In this Chat bot, a request to use Claude without another named Claude model means harness claudecode and model claude-opus-4-8. Examples: "--claude what model are you?" and "using claude:" select harness claudecode and model claude-opus-4-8. Explicit Fable requests such as "--claude --model=fable" and "using claude fable:" select harness claudecode and model claude-fable-5.',
  'Only return reasoning when the user explicitly asks to change model reasoning or effort. A reasoning word appearing incidentally, in quoted text, pasted model output, code, or task requirements is not a selection request.',
  'When the user explicitly requests a reasoning or effort change, map fuzzy magnitude words to the nearest reasoning value. Examples: tiny/cheap/fast -> low or minimal; normal/default -> medium; deep/strong/intense -> high or xhigh; maximum/superduper/biggest -> max.',
  'Return reasoning even when the requested model is not Codex; validation will ignore reasoning that cannot apply.',
  'Map OpenAI model aliases to canonical IDs: sol -> gpt-5.6-sol, terra -> gpt-5.6-terra, luna -> gpt-5.6-luna, 5.5 -> gpt-5.5, 5.5 pro -> gpt-5.5-pro, 5.4 -> gpt-5.4, 5.4 pro -> gpt-5.4-pro, 5.4 mini -> gpt-5.4-mini, 5.4 nano -> gpt-5.4-nano.',
  'Map Claude model aliases to canonical IDs: fable -> claude-fable-5, opus -> claude-opus-4-8, opus 4.7 -> claude-opus-4-7, opus 5 -> claude-opus-5, opus 5 fast -> claude-opus-5-fast, sonnet -> claude-sonnet-4-6, sonnet 5 -> claude-sonnet-5, haiku -> claude-haiku-4-5.',
  'Map Amp model aliases to canonical IDs: deep -> deep, fast -> fast. Select an Amp model only when the user explicitly names Amp or clearly asks for the deep or fast model/mode. Requests such as "use the deep model" and "switch to fast mode" select the corresponding Amp model. Do not infer Amp from superlatives, coined terms, or casual requests to be more intelligent, thorough, or fast.',
  'Words containing or merely evoking model aliases are not model requests. For example, "think deeply", "do a deep analysis", "use your strongest thinking", and "give me a fast answer" do not select Amp. Unless another explicit selector is present, return null for every field.',
  'For example, "use max effort and the sol model" should return model "gpt-5.6-sol" and reasoning "max".',
  'Do not treat ordinary discussion of model names as a selection request.'
].join('\n')

// Derived from the validation vocabulary in overrides.ts: a model the schema
// admits but validation rejects would be silently discarded after the round
// trip, so the two must come from the same source.
const MESSAGE_OVERRIDES_SCHEMA = {
  additionalProperties: false,
  properties: {
    harness: {
      enum: [...STRATEGY_HARNESSES, null],
      type: ['string', 'null']
    },
    model: {
      enum: [...Object.keys(STRATEGY_MODEL_HARNESSES), null],
      type: ['string', 'null']
    },
    provider: {
      enum: [...STRATEGY_PROVIDERS, null],
      type: ['string', 'null']
    },
    reasoning: {
      enum: [...STRATEGY_REASONING_EFFORTS, null],
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

export function createOpenAiMessageOverridesStrategy(
  options: OpenAiMessageOverridesStrategyOptions
): MessageOverridesStrategy {
  const responsesUrl = `${stripTrailingSlashes(options.baseUrl ?? 'https://api.openai.com/v1')}/responses`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const fetchFn = options.fetch ?? fetch

  return async text => {
    // Explicit flags are a deterministic user command, even when the deployment
    // enables the LLM strategy for natural-language model requests. Handle them
    // first so a strict strategy schema or model failure cannot discard the
    // selection, and so flags never leak into the harness prompt.
    const { cleanedText, ...explicitOverrides } = extractMessageOverrides(text)
    if (Object.values(explicitOverrides).some(value => value !== undefined)) {
      return { cleanedText, ...explicitOverrides }
    }

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

/**
 * Builds the message-overrides strategy a deployment is configured for. Called
 * once at startup (`createGooglechatbot`); the resulting strategy is threaded
 * down to each inbound message.
 */
export function messageOverridesStrategyFromConfig(config: AppConfig): MessageOverridesStrategy {
  if (config.GOOGLECHATBOT_MESSAGE_OVERRIDES_STRATEGY !== 'llm') {
    return createFlagMessageOverridesStrategy()
  }
  if (!config.OPENAI_API_KEY) {
    logWarn('googlechatbot_message_overrides_strategy_missing_api_key', {
      strategy: 'llm'
    })
    return async text => ({ cleanedText: text })
  }
  return createOpenAiMessageOverridesStrategy({
    apiKey: config.OPENAI_API_KEY,
    baseUrl: config.GOOGLECHATBOT_MESSAGE_OVERRIDES_OPENAI_BASE_URL,
    maxOutputTokens: config.GOOGLECHATBOT_MESSAGE_OVERRIDES_MAX_OUTPUT_TOKENS,
    model: config.GOOGLECHATBOT_MESSAGE_OVERRIDES_MODEL,
    timeoutMs: config.GOOGLECHATBOT_MESSAGE_OVERRIDES_TIMEOUT_MS
  })
}
