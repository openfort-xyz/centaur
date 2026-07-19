/**
 * Per-space default harness / model / provider / reasoning. Loaded from the
 * `GOOGLECHATBOT_SPACE_DEFAULTS` env var: JSON keyed by Google Chat space id
 * (the `AAAA` in `spaces/AAAA`), each value an object normalized like the
 * inline flags (see `normalizeHarnessOverrides`). Mirrors slackbotv2's
 * per-channel defaults (`channel-defaults.ts`).
 *
 *   GOOGLECHATBOT_SPACE_DEFAULTS='{
 *     "AAAAeng":     {"harness": "claude", "model": "opus", "reasoning": "high"},
 *     "AAAAtriage":  {"reasoning": "low"},
 *     "AAAAbedrock": {"provider": "bedrock", "model": "gpt-5.2"}
 *   }'
 *
 * Fields are independent. Precedence (in index.ts): per-thread override, then
 * space default, then deployment default. Setting `harness` restarts a thread
 * onto it like `--claude`/`--codex`; `reasoning` only affects codex.
 */

import type { AppConfig } from './config'
import { logWarn } from './logging'
import { normalizeHarnessOverrides, type HarnessOverrides } from './overrides'

export type SpaceDefaults = Record<string, HarnessOverrides>

/**
 * Parses `GOOGLECHATBOT_SPACE_DEFAULTS` into a space→overrides map (empty for
 * unset input). Never throws — bad JSON or entries are skipped and reported via
 * `onError`.
 */
export function parseSpaceDefaults(
  raw: string | undefined,
  onError?: (message: string) => void
): SpaceDefaults {
  const trimmed = raw?.trim()
  if (!trimmed) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    onError?.(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
  if (!isPlainObject(parsed)) {
    onError?.('expected a JSON object keyed by space id')
    return {}
  }
  const result: SpaceDefaults = {}
  for (const [spaceId, rawEntry] of Object.entries(parsed)) {
    const key = spaceId.trim()
    if (!key) continue
    if (!isPlainObject(rawEntry)) {
      onError?.(`space ${key}: expected an object of harness/model/provider/reasoning fields`)
      continue
    }
    const overrides = normalizeHarnessOverrides(rawEntry, message => onError?.(`space ${key}: ${message}`))
    if (!overrides.harnessType && !overrides.model && !overrides.provider && !overrides.reasoning) {
      onError?.(`space ${key}: no usable harness/model/provider/reasoning fields`)
      continue
    }
    result[key] = overrides
  }
  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extracts the Google Chat space id from a thread key of the shape
 * `chat:spaces:AAAA:spaces:AAAA:threads:BBBB` (the googlechatbot's own
 * encoding — see `google_chat_thread_context` in api-rs), or undefined for
 * any other thread key shape (Slack, DM adapter, etc.).
 */
export function spaceIdFromThreadId(threadId: string): string | undefined {
  const rest = threadId.startsWith('chat:spaces:') ? threadId.slice('chat:spaces:'.length) : undefined
  if (!rest) return undefined
  const spaceId = rest.split(':')[0]
  return spaceId ? spaceId : undefined
}

/** Resolves the space default for a thread, or undefined when none applies. */
export function resolveSpaceDefault(
  defaults: SpaceDefaults | undefined,
  threadId: string
): HarnessOverrides | undefined {
  if (!defaults) return undefined
  const spaceId = spaceIdFromThreadId(threadId)
  if (!spaceId) return undefined
  return defaults[spaceId]
}

let cachedDefaults: SpaceDefaults | undefined
let cachedDefaultsConfig: AppConfig | undefined

/**
 * Parse (and memoize, per config identity) GOOGLECHATBOT_SPACE_DEFAULTS.
 * Parse errors are logged once per config rather than raised, so a typo in
 * one space's entry never blocks the deployment default for every other
 * thread.
 */
export function spaceDefaultsFromConfig(config: AppConfig): SpaceDefaults {
  if (cachedDefaults && cachedDefaultsConfig === config) return cachedDefaults
  const defaults = parseSpaceDefaults(config.GOOGLECHATBOT_SPACE_DEFAULTS, message =>
    logWarn('googlechatbot_space_defaults_invalid', { error: message })
  )
  cachedDefaults = defaults
  cachedDefaultsConfig = config
  return defaults
}
