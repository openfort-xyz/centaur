import type { AppConfig } from './config'
import {
  extractMessageOverrides,
  validateStrategyOverrides,
  STRATEGY_HARNESSES,
  STRATEGY_PROVIDERS,
  type MessageOverrides
} from './overrides'
import { logInfo, logWarn } from './logging'
import { stripTrailingSlashes } from './url'

const DEFAULT_TIMEOUT_MS = 2_000
// Minimum probability that the message asks for a selection at all. Below it,
// every per-field answer is ignored.
const SELECTION_PROBABILITY_THRESHOLD = 0.5
const UNSPECIFIED = 'unspecified'

const INSTRUCTIONS = [
  'You evaluate a Google Chat message sent to an AI coding bot and decide whether it asks to choose the AI harness, model, provider, or reasoning effort used to answer it.',
  'A selection is an explicit instruction to the bot about how to run, such as "use X", "switch to X", "run this on X", "retry with X", "with high effort", or a leading "using X:" prefix.',
  'A selection counts wherever it appears: at the start, mid-sentence, or at the end of a long request, after quoted text, or alongside other setup such as "Using the reviewer persona and claude fable...". Only the quoted or pasted material itself is excluded.',
  'Asking to use a feature of a specific harness, such as Codex\'s /goal, selects that harness.',
  '"using claude:" or "use claude" with no other Claude model named selects the default Claude model, Opus 5.5.',
  'Only explicit requests count. Words in quoted text, pasted output, code, config values like reasoning=high, task requirements, questions about the bot, or ordinary discussion of model names are not selection requests.',
  'Words merely evoking speed or depth, such as "think deeply", "deep analysis", "quick question", or "a fast answer", select neither a model nor a reasoning effort. "Fast mode", "deep mode", "the fast model", and "the deep model" are explicit Amp model selections.',
  'Reasoning effort is selected only when the user explicitly sets reasoning, effort, or a thinking level, such as "high effort" or "xhigh thinking"; then map magnitude words to the nearest level. Asking the bot to think hard or use its best or strongest thinking does not select a reasoning effort.',
  'A version number always selects that exact model and overrides the default for a family name: "5.6 sol" is gpt-5.6-sol, not the default sol model, and "codex 5.5" or "gpt 5.5" is gpt-5.5. An effort word after a family name, such as "fable xhigh", is not a version.'
].join('\n')

// Only messages that mention a model name or selection term can ask for an
// override, so other messages skip the classifier and its latency. The letter
// lookarounds keep version suffixes ("gpt5", "opus-4.7") and plurals matching
// while ignoring longer words such as "solve" or "terraform".
const SELECTOR_TERM_PATTERN =
  /(?<![a-z])(?:claude|claudecode|codex|amp|nanocodex|hermes|pi|omp|opus|sonnet|haiku|fable|gpt|astra|sol|luna|terra|model|harness|provider|reasoning|effort|mode|bedrock|openrouter|think|thinking)(?:s|es)?(?![a-z])/i

type Choice = { description?: string; value: string }

// Harness and provider vocabularies come from overrides.ts so the choices the
// model is offered and the validation they pass through cannot drift apart.
const HARNESS_CHOICES: Choice[] = [...STRATEGY_HARNESSES].map(value => ({ value }))

const PROVIDER_CHOICES: Choice[] = [...STRATEGY_PROVIDERS].map(value => ({ value }))

const REASONING_CHOICES: Choice[] = [
  { value: 'none', description: 'No reasoning.' },
  { value: 'minimal', description: 'Minimal; tiny.' },
  { value: 'low', description: 'Low; cheap, fast, quick.' },
  { value: 'medium', description: 'Medium; normal, default.' },
  { value: 'high', description: 'High; deep, strong, hard.' },
  { value: 'xhigh', description: 'Extra high; intense, very hard.' },
  { value: 'max', description: 'Max; maximum, superduper, biggest, hardest.' },
  { value: 'ultra', description: 'Ultra.' }
]

// Descriptions carry the user-facing aliases. Each states exactly when it
// applies so a bare family name ("sol") resolves to its default generation.
// Every value must be a STRATEGY_MODEL_HARNESSES key or validation drops it.
export const MODEL_CHOICES: Choice[] = [
  { value: 'claude-fable-5', description: 'Only when the user says "fable 5" (not 5.1).' },
  { value: 'claude-fable-5-1', description: 'Fable: plain "fable", "claude fable", or "fable 5.1".' },
  { value: 'claude-haiku-4-5', description: 'Only when the user says "haiku 4.5".' },
  { value: 'claude-haiku-5-5', description: 'Haiku: plain "haiku" or "haiku 5.5".' },
  { value: 'claude-opus-4-7', description: 'Only when the user says "opus 4.7".' },
  { value: 'claude-opus-4-8', description: 'Only when the user says "opus 4.8".' },
  { value: 'claude-opus-5', description: 'Only when the user says "opus 5" (not 5.5, not fast).' },
  { value: 'claude-opus-5-fast', description: 'Only when the user says "opus 5 fast".' },
  {
    value: 'claude-opus-5-5',
    description:
      'Default Claude model: plain "opus", "opus 5.5", or "claude" / "using claude:" with no other Claude model named.'
  },
  { value: 'claude-sonnet-4-6', description: 'Only when the user says "sonnet 4.6".' },
  { value: 'claude-sonnet-5', description: 'Only when the user says "sonnet 5" (not 5.5).' },
  { value: 'claude-sonnet-5-5', description: 'Sonnet: plain "sonnet" or "sonnet 5.5".' },
  {
    value: 'deep',
    description: 'Amp deep model. Only when the user asks for "the deep model" or "deep mode"; naming Amp alone does not select it.'
  },
  {
    value: 'fast',
    description: 'Amp fast model. Only when the user asks for "the fast model" or "fast mode"; naming Amp alone does not select it.'
  },
  { value: 'gpt-5.4', description: 'Only when the user says "5.4", "gpt 5.4", or "codex 5.4" with no suffix.' },
  { value: 'gpt-5.4-mini', description: 'Only when the user says "5.4 mini".' },
  { value: 'gpt-5.4-nano', description: 'Only when the user says "5.4 nano".' },
  { value: 'gpt-5.4-pro', description: 'Only when the user says "5.4 pro".' },
  { value: 'gpt-5.5', description: 'Only when the user says "5.5", "gpt 5.5", or "codex 5.5" with no suffix.' },
  { value: 'gpt-5.5-pro', description: 'Only when the user says "5.5 pro".' },
  { value: 'gpt-5.6-luna', description: 'Only when the user says "5.6 luna".' },
  { value: 'gpt-5.6-sol', description: 'Only when the user says "5.6 sol".' },
  { value: 'gpt-5.6-terra', description: 'Only when the user says "5.6 terra".' },
  { value: 'gpt-6-astra', description: 'Astra: plain "astra".' },
  { value: 'gpt-6-sol', description: 'Only when the user says "6 sol" (not 6.1).' },
  { value: 'gpt-6.1-sol', description: 'Sol: plain "sol", "the sol model", or "6.1 sol".' },
  { value: 'gpt-6.1-terra', description: 'Terra: plain "terra" or "6.1 terra".' },
  { value: 'gpt-6-luna', description: 'Luna: plain "luna" or "6 luna".' }
]

function choiceQuestion(name: string, instructions: string, choices: Choice[]) {
  return {
    choices: [
      { value: UNSPECIFIED, description: 'The message does not explicitly request this.' },
      ...choices
    ],
    instructions,
    name,
    type: 'choice'
  }
}

export const DECISION_QUESTIONS = [
  {
    instructions:
      'Does the message explicitly ask to change the AI harness, model, provider, or reasoning effort used to answer it?',
    name: 'selection_request',
    type: 'predicate'
  },
  choiceQuestion('harness', 'Which AI harness does the message explicitly request?', HARNESS_CHOICES),
  choiceQuestion(
    'model',
    'Which AI model does the message explicitly request? Preserve the requested generation.',
    MODEL_CHOICES
  ),
  choiceQuestion(
    'provider',
    'Which inference provider does the message explicitly request?',
    PROVIDER_CHOICES
  ),
  choiceQuestion(
    'reasoning',
    'Which reasoning effort does the message explicitly request? Map magnitude words to the nearest level.',
    REASONING_CHOICES
  )
]

/**
 * Resolves harness/model/provider/reasoning overrides (and any text cleanup
 * they imply) from a raw user message. `createFlagMessageOverridesStrategy`
 * (the default) parses literal `--flags`; `createOpenAiMessageOverridesStrategy`
 * asks the OpenAI Decisions API to interpret natural-language requests instead.
 */
export type MessageOverridesStrategy = (text: string) => Promise<MessageOverrides>

/** Structured log sink; the evals provider swaps it to observe silent fallbacks. */
export type StrategyLogger = {
  info: (event: string, fields: Record<string, unknown>) => void
  warn: (event: string, fields: Record<string, unknown>) => void
}

export type OpenAiMessageOverridesStrategyOptions = {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
  logger?: StrategyLogger
  model: string
  timeoutMs?: number
}

export function createFlagMessageOverridesStrategy(): MessageOverridesStrategy {
  return async text => extractMessageOverrides(text)
}

/** Classifies natural-language model selection with the OpenAI Decisions API. */
export function createOpenAiMessageOverridesStrategy(
  options: OpenAiMessageOverridesStrategyOptions
): MessageOverridesStrategy {
  const decisionsUrl = `${stripTrailingSlashes(options.baseUrl ?? 'https://api.openai.com/v1')}/decisions`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn = options.fetch ?? fetch
  const logger = options.logger ?? { info: logInfo, warn: logWarn }

  return async text => {
    // Explicit flags are a deterministic user command, even when the deployment
    // enables the LLM strategy for natural-language model requests. Handle them
    // first so a model failure cannot discard the selection, and so flags never
    // leak into the harness prompt. A persona flag on its own still lets the
    // classifier read the rest of the message.
    const { cleanedText, personaId, ...explicitOverrides } = extractMessageOverrides(text)
    const persona = personaId ? { personaId } : {}
    if (Object.values(explicitOverrides).some(value => value !== undefined)) {
      return { cleanedText, ...persona, ...explicitOverrides }
    }

    if (!SELECTOR_TERM_PATTERN.test(cleanedText)) return { cleanedText, ...persona }

    const startedAt = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchFn(decisionsUrl, {
        body: JSON.stringify({
          input: [
            { content: INSTRUCTIONS, role: 'developer' },
            { content: cleanedText, role: 'user' }
          ],
          model: options.model,
          questions: DECISION_QUESTIONS
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
      const answers = decisionAnswers(await response.json())
      const selectionProbability = answers.selection_request?.probability
      const selection = {
        harness: chosenValue(answers.harness),
        model: chosenValue(answers.model),
        provider: chosenValue(answers.provider),
        reasoning: chosenValue(answers.reasoning)
      }
      logger.info('googlechatbot_message_overrides_strategy_response_received', {
        elapsed_ms: Date.now() - startedAt,
        model: options.model,
        selected_harness: selection.harness,
        selected_model: selection.model,
        selected_provider: selection.provider,
        selected_reasoning: selection.reasoning,
        selection_probability: selectionProbability
      })
      if (
        typeof selectionProbability !== 'number'
        || selectionProbability < SELECTION_PROBABILITY_THRESHOLD
      ) {
        return { cleanedText, ...persona }
      }
      return { cleanedText, ...persona, ...validateStrategyOverrides(selection) }
    } catch (error) {
      logger.warn('googlechatbot_message_overrides_strategy_request_failed', {
        elapsed_ms: Date.now() - startedAt,
        error: errorMessage(error),
        model: options.model,
        timeout_ms: timeoutMs
      })
      return { cleanedText, ...persona }
    } finally {
      clearTimeout(timeout)
    }
  }
}

type DecisionAnswer = { choice?: unknown; probability?: unknown; type?: unknown }

function decisionAnswers(value: unknown): Record<string, DecisionAnswer> {
  const answers = isJsonObject(value) && Array.isArray(value.answers) ? value.answers : []
  return Object.fromEntries(
    answers.flatMap(answer =>
      isJsonObject(answer) && typeof answer.name === 'string' ? [[answer.name, answer]] : []
    )
  )
}

// Refusals and the unspecified sentinel both mean "no selection" for a field.
function chosenValue(answer: DecisionAnswer | undefined): string | null {
  return answer?.type === 'choice'
    && typeof answer.choice === 'string'
    && answer.choice !== UNSPECIFIED
    ? answer.choice
    : null
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
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
    model: config.GOOGLECHATBOT_MESSAGE_OVERRIDES_MODEL,
    timeoutMs: config.GOOGLECHATBOT_MESSAGE_OVERRIDES_TIMEOUT_MS
  })
}
