import {
  CodexAppServerRendererEventMapper,
  type RendererEvent
} from '@centaur/rendering'
import type { RustSessionStreamEvent } from '@centaur/harness-events'
import type { ChatEdgeClient } from './chat/client'
import { markdownToChatMessage } from './chat/render'
import { chatReplyLimits } from './constants'
import { logError, logWarn } from './logging'
import type { GoogleChatCard, GoogleChatCardWidget, GoogleChatMessage } from './chat/types'

export const INITIAL_STATUS = '_Condor is thinking…_'
const STATUS_FLUSH_INTERVAL_MS = 1_000
const EMPTY_ANSWER_TEXT = 'Execution completed, but no final text was captured.'

// A message with both `text` and `cardsV2` renders the text as a bubble ABOVE
// the card (Google Chat: "cards are displayed below the plain-text body"), so
// putting answer content in both shows it twice. We therefore pick ONE surface.
//
// The plain `text` field is the DEFAULT surface, cards the exception. Card
// textParagraphs fragment top-level paragraphs around EVERY inline span —
// mid-sentence **bold**, *italic*, and `code` each get pushed onto their own
// line — regardless of markup form (`**b**`, `*b*`, `<b>`, all with textSyntax
// MARKDOWN and with the default syntax alike; probe cards posted to a live
// space, 2026-07-06). Only list items render their inline spans correctly.
// The plain `text` field renders Chat markup (*bold*, _italic_, `code`,
// ```fences```) inline and intact, so answers read correctly only there;
// toChatTextMarkup translates the agent's GFM (**bold**, [label](url),
// # headings) into that markup.
//
// Cards remain for what the text surface genuinely cannot carry:
//   - standalone image embeds (`![alt](https://…)`) → image widgets;
//   - answers over the 4096-char `text` cap (the card envelope is ~32 KB).
// Notification preview is not a factor: the answer is delivered by PATCHing the
// already-posted "thinking" ack, and the ack's create already fired the push.
const NEEDS_CARD_RE = /(^|\n)\s*!\[[^\]]*\]\(https?:\/\/[^\s)]+\)\s*(?=\n|$)/

export type RenderTarget = {
  spaceName: string
  /** Resource name of the pre-posted "thinking" message we PATCH with the answer. */
  ackMessageName: string
  /** Thread to fall back into if the ack PATCH fails and we must post fresh. */
  threadName?: string
  /** Optional deep link rendered as a "View session" button on the final answer. */
  sessionUrl?: string
  /** Optional "Open chat in Console · MODEL · Harness" trailer widget, set on
   * the first assistant message of a thread (see console-session-link.ts). */
  consoleSessionWidget?: GoogleChatCardWidget
  /** Prompt asked for plain text — deliver via the `text` surface, no cards. */
  plainTextOnly?: boolean
}

/**
 * Consume the api-rs SSE stream for one turn and deliver the result to Google
 * Chat as a single message (the single-message UX from the legacy chatbot):
 * status pulses edit the "thinking" bubble live, then the final answer PATCHes
 * the same bubble. There is no streaming answer text — Google Chat lacks a
 * streaming primitive and rate-limits edits — so the canonical answer is only
 * written once, at the end.
 *
 * Single-shot helper; callers that need resume-on-drop use createRenderState +
 * consumeRenderStream + finalizeRender directly (see driveSession).
 */
export async function renderSessionToChat(
  client: ChatEdgeClient,
  stream: AsyncIterable<RustSessionStreamEvent>,
  target: RenderTarget
): Promise<void> {
  const state = createRenderState()
  await consumeRenderStream(client, stream, target, state)
  await finalizeRender(client, target, state)
}

export type RenderState = {
  answer: string
  error: string | undefined
  /** Short label for the current activity, shown in the `text` line. */
  statusLine: string
  lastSignature: string
  lastFlushAt: number
  /** True once a definitive end (completed/failed/cancelled) was seen. */
  terminal: boolean
  /** Persisted across resume passes so the answer keeps accumulating. */
  mapper: CodexAppServerRendererEventMapper
}

export function createRenderState(): RenderState {
  return {
    answer: '',
    error: undefined,
    statusLine: 'thinking',
    lastSignature: INITIAL_STATUS,
    lastFlushAt: 0,
    terminal: false,
    mapper: new CodexAppServerRendererEventMapper()
  }
}

/**
 * Process one SSE pass into the render state, pulsing the live bubble. Does NOT
 * flush or deliver — a stream that drops mid-run leaves state.terminal false so
 * the caller can re-open from the last event id and continue.
 */
export async function consumeRenderStream(
  client: ChatEdgeClient,
  stream: AsyncIterable<RustSessionStreamEvent>,
  target: RenderTarget,
  state: RenderState
): Promise<void> {
  try {
    for await (const event of stream) {
      captureStreamError(event, state)
      await applyRendererEvents(client, target, state, state.mapper.process(event))
    }
  } catch (error) {
    // A transport drop is recoverable: leave terminal false so we resume.
    state.error = state.error ?? errorText(error)
    logError('googlechatbot_render_stream_failed', error)
  }
}

/** Flush any buffered renderer state and write the canonical final answer once. */
export async function finalizeRender(
  client: ChatEdgeClient,
  target: RenderTarget,
  state: RenderState
): Promise<void> {
  await applyRendererEvents(client, target, state, state.mapper.flush())
  await deliverFinal(client, target, state)
}

async function applyRendererEvents(
  client: ChatEdgeClient,
  target: RenderTarget,
  state: RenderState,
  events: RendererEvent[]
): Promise<void> {
  for (const event of events) {
    switch (event.type) {
      case 'renderer.message.delta':
        state.answer += event.delta
        break
      case 'renderer.message.snapshot':
        state.answer = event.markdown
        break
      case 'renderer.status':
        if (event.status.trim()) state.statusLine = event.status.trim()
        await pulse(client, target, state)
        break
      case 'renderer.plan.update':
        if (event.title.trim()) state.statusLine = event.title.trim()
        await pulse(client, target, state)
        break
      case 'renderer.task.update':
        if (event.task.title.trim()) state.statusLine = event.task.title.trim()
        await pulse(client, target, state)
        break
      case 'renderer.done':
        if (typeof event.answerMarkdown === 'string' && event.answerMarkdown.trim()) {
          state.answer = event.answerMarkdown
        }
        if (event.error) state.error = state.error ?? event.error
        state.terminal = true
        break
      default:
        break
    }
  }
}

/**
 * Edit the "thinking" bubble with a single compact `_Condor · <activity>…_`
 * line. The agent's reasoning and tool calls arrive as task updates; we DON'T
 * render them — they're noise that eats space — and only surface the current
 * activity. Deduped and rate-limited to 1 Hz for the 1-write/second-per-space cap.
 */
async function pulse(
  client: ChatEdgeClient,
  target: RenderTarget,
  state: RenderState
): Promise<void> {
  if (!target.ackMessageName) return
  // Strip `_`/`*` from the agent-supplied status so a token like `test_foo`
  // doesn't prematurely close the `_…_` italic wrapper.
  const status = state.statusLine.slice(0, 80).replace(/[_*]/g, '')
  const text = `_Condor · ${status}…_`
  if (text === state.lastSignature) return
  const now = Date.now()
  if (now - state.lastFlushAt < STATUS_FLUSH_INTERVAL_MS) return
  state.lastFlushAt = now
  state.lastSignature = text

  try {
    await client.updateMessage(target.ackMessageName, { text })
  } catch (error) {
    logWarn('googlechatbot_status_pulse_failed', error)
  }
}

async function deliverFinal(
  client: ChatEdgeClient,
  target: RenderTarget,
  state: RenderState
): Promise<void> {
  const text = finalText(state)
  const rendered = markdownToChatMessage(text)
  const button = sessionButtonWidget(target.sessionUrl)
  // Trailer widgets appended after the answer: the optional "View session"
  // button and the first-message "Open chat in Console · …" line.
  const trailers = [button, target.consoleSessionWidget].filter(
    (widget): widget is GoogleChatCardWidget => widget !== undefined
  )
  // Use the card (no `text`) only when the text surface cannot carry the
  // answer: image embeds (need image widgets) or overflow past Google Chat's
  // 4096-char `text` cap — the card envelope is ~32 KB, so routing long answers
  // there avoids a 400 (and a silent truncation). Everything else goes plain:
  // the whole answer in `text`, no card (plus a button-only card for the link)
  // — cards fragment inline formatting (see NEEDS_CARD_RE above).
  // `rendered.text` is clamped to the 4096 cap; hitting it means the plain answer
  // overflowed and must go to the (larger) card to avoid truncation / a 400.
  const plainOverflows = rendered.text.length >= chatReplyLimits.message.maxPlainTextChars
  // A "plain text only" prompt (same phrases slackbotv2 honors) forces the
  // `text` surface even for image embeds — unless the answer overflows the
  // 4096-char cap, where the card is the only surface that fits it whole.
  const needsCard = plainOverflows || (!target.plainTextOnly && NEEDS_CARD_RE.test(text))
  const body: Partial<GoogleChatMessage> = needsCard
    ? { cardsV2: withTrailers(rendered.cardsV2, trailers) }
    : { text: rendered.text, cardsV2: trailers.length ? [trailerCard(trailers)] : [] }

  if (target.ackMessageName) {
    try {
      await client.updateMessage(target.ackMessageName, body)
      return
    } catch (error) {
      logError('googlechatbot_final_patch_failed_falling_back_to_create', error)
    }
  }

  try {
    await client.createMessage(target.spaceName, body, { threadName: target.threadName })
  } catch (error) {
    logError('googlechatbot_final_create_failed', error)
  }
}

/**
 * Optional "View session" deep link on the final answer. A plain openLink — no
 * callback, so it can't error like an action button. Omitted when no URL is set.
 */
function sessionButtonWidget(sessionUrl?: string): GoogleChatCardWidget | undefined {
  if (!sessionUrl) return undefined
  return { buttonList: { buttons: [{ text: 'View session', onClick: { openLink: { url: sessionUrl } } }] } }
}

/** Append trailer widgets to the last card's sections, or make a card if there are none. */
function withTrailers(
  cards: Array<{ cardId: string; card: GoogleChatCard }> | undefined,
  trailers: GoogleChatCardWidget[]
): Array<{ cardId: string; card: GoogleChatCard }> {
  if (trailers.length === 0) return cards ?? []
  if (!cards || cards.length === 0) return [trailerCard(trailers)]
  const last = cards[cards.length - 1]!
  const sections = [...(last.card.sections ?? []), { widgets: trailers }]
  const updated = { cardId: last.cardId, card: { ...last.card, sections } }
  return [...cards.slice(0, -1), updated]
}

function trailerCard(trailers: GoogleChatCardWidget[]): { cardId: string; card: GoogleChatCard } {
  return { cardId: 'actions', card: { sections: [{ widgets: trailers }] } }
}

function finalText(state: RenderState): string {
  if (state.error) {
    const detail = state.answer.trim()
    return detail
      ? `⚠️ Centaur hit an error: ${state.error}\n\n${detail}`
      : `⚠️ Centaur hit an error: ${state.error}`
  }
  return state.answer.trim() || EMPTY_ANSWER_TEXT
}

function captureStreamError(event: RustSessionStreamEvent, state: RenderState): void {
  const kind = event.eventKind ?? event.event
  if (
    kind === 'session.stream_error' ||
    kind === 'session.execution_failed' ||
    kind === 'session.execution_cancelled'
  ) {
    const data = event.data
    if (data && typeof data === 'object' && 'error' in data) {
      const error = (data as { error?: unknown }).error
      if (typeof error === 'string') state.error = state.error ?? error
    }
    // A real failure/cancellation is final — don't resume. A bare stream_error
    // is treated as transport noise and left resumable.
    if (kind === 'session.execution_failed' || kind === 'session.execution_cancelled') {
      state.terminal = true
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
