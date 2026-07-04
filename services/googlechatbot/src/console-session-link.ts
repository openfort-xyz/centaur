/**
 * Google Chat "Open chat in Console" context line — the Chat-side port of
 * slackbotv2's console-session-link (upstream #843, renamed in #889).
 *
 * On the first assistant message in a Chat thread, googlechatbot appends a
 * card `textParagraph` widget — `Open chat in Console · {MODEL} · {Harness}` —
 * to the final answer. Chat has no Slack-style `context` block appended at
 * stop-stream time; the single-write render (see renderer.ts) instead carries
 * the widget on the answer card (or on the button-only card for plain-text
 * answers), which is the same "muted trailer line" placement.
 */

import claudeSettings from '../../../harness/claude/settings.json'
import codexConfig from '../../../harness/codex/config.toml'

const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  amp: 'Amp',
  claudecode: 'Claude Code',
  codex: 'Codex'
}

// Default model each harness runs when no --model/--opus/... override is set,
// read from the same harness config files the sandbox images bake in
// (harness/claude/settings.json, harness/codex/config.toml; the googlechatbot
// Dockerfile copies harness/ so these imports resolve in the image too).
// Deployers who override the sandbox model via CLAUDE_MODEL / CODEX_MODEL
// (sandbox.extraEnv) get the same values mirrored into googlechatbot by the
// chart and passed here through AppConfig, which takes precedence. Amp has no
// fixed default model (deep/fast modes), so it is intentionally absent.
const BAKED_DEFAULT_MODELS: Record<string, string | undefined> = {
  claudecode: typeof claudeSettings.model === 'string' ? claudeSettings.model : undefined,
  codex:
    typeof (codexConfig as { model?: unknown }).model === 'string'
      ? ((codexConfig as { model: string }).model)
      : undefined
}

/** Card textParagraph text is HTML-flavoured: `&`, `<`, `>` must be escaped. */
function escapeChatHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Maps a harness wire value (codex | claudecode | amp) to a human display name.
 * Unknown harnesses fall back to a title-cased form of the raw value. Returns
 * undefined when no harness is provided.
 */
export function harnessDisplayName(harnessType: string | null | undefined): string | undefined {
  if (!harnessType) return undefined
  const key = harnessType.trim().toLowerCase()
  if (!key) return undefined
  return HARNESS_DISPLAY_NAMES[key] ?? titleCase(key)
}

/**
 * Returns the model a harness runs by default (no explicit override):
 * the deployment-configured value (CLAUDE_MODEL / CODEX_MODEL via the chart,
 * keyed by harness wire value) when set, else the model pinned in this repo's
 * harness config files. Undefined for harnesses without a fixed default (amp,
 * unknown harnesses).
 */
export function defaultModelForHarness(
  harnessType: string | null | undefined,
  configured?: Record<string, string>
): string | undefined {
  if (!harnessType) return undefined
  const key = harnessType.trim().toLowerCase()
  return configured?.[key]?.trim() || BAKED_DEFAULT_MODELS[key]
}

/**
 * Builds the Console session URL for a Chat thread key, or undefined when no
 * Console base URL is configured (in which case no line should render). The
 * thread key is the exact value googlechatbot sends as `thread_key` to the
 * session API, URL-encoded into the `thread` query parameter the Console reads.
 */
export function consoleSessionUrl(
  consoleBaseUrl: string | null | undefined,
  threadKey: string
): string | undefined {
  const base = consoleBaseUrl?.trim()
  if (!base) return undefined
  // Trailing-slash strip without a `/+$/` regex (polynomial-ReDoS lint).
  let normalized = base
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return `${normalized}/console/threads?thread=${encodeURIComponent(threadKey)}`
}

export type ChatTextParagraphWidget = {
  textParagraph: { text: string }
}

/**
 * Builds the "Open chat in Console · {MODEL} · {Harness}" widget, or undefined
 * when no Console base URL is configured (a bare "Open chat in Console" with
 * no link is pointless, so the whole widget is skipped). The model id is
 * uppercased for display, matching slackbotv2.
 */
export function buildConsoleSessionWidget(params: {
  consoleBaseUrl: string | null | undefined
  threadKey: string
  harnessType?: string | null
  model?: string | null
}): ChatTextParagraphWidget | undefined {
  const url = consoleSessionUrl(params.consoleBaseUrl, params.threadKey)
  if (!url) return undefined
  const segments = [`<a href="${url}">Open chat in Console</a>`]
  const model = params.model?.trim()
  if (model) segments.push(escapeChatHtml(model.toUpperCase()))
  const harness = harnessDisplayName(params.harnessType)
  if (harness) segments.push(escapeChatHtml(harness))
  // Middot (U+00B7) with a space on each side, matching slackbotv2's trailer.
  return { textParagraph: { text: segments.join(' · ') } }
}
