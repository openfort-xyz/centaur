import {
  CodexAppServerRendererEventMapper,
  type RendererEvent
} from '@centaur/rendering'
import type { RustSessionStreamEvent } from '@centaur/harness-events'
import { ChatApiError, type ChatEdgeClient } from './chat/client'
import {
  CARD_FALLBACK_TEXT,
  hasStandaloneImage,
  markdownToChatMessage,
  messageUtf8Bytes
} from './chat/render'
import { chatReplyLimits } from './constants'
import { logError, logWarn } from './logging'
import type {
  GoogleChatCard,
  GoogleChatCardWidget,
  GoogleChatMessage
} from './chat/types'

export const INITIAL_STATUS = '_Centaur is thinking…_'
const STATUS_FLUSH_INTERVAL_MS = 1_000
const WRITE_INTERVAL_MS = 1_000
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
// Cards remain for what the text surface genuinely cannot carry: standalone
// image embeds (`![alt](https://…)`) become image widgets. Long text remains on
// the text surface and is split into complete <=32,000-byte Messages.
// The final answer replaces the already-posted "thinking" ack. `fallbackText`
// is create-only, so PATCH omits it while updating both text and cardsV2.
export type RenderTarget = {
  spaceName: string
  /** Resource name of the pre-posted "thinking" message we PATCH with the answer. */
  ackMessageName: string
  /** Thread to fall back into if the ack no longer exists and we must post fresh. */
  threadName?: string
  /** Optional "Open chat in Console · MODEL · Harness" trailer widget, set on
   * the first assistant message of a thread (see console-session-link.ts). */
  consoleSessionWidget?: GoogleChatCardWidget
  /** Prompt asked for plain text — deliver via the `text` surface, no cards. */
  plainTextOnly?: boolean
  /** Stable custom message ID makes fallback creation retry-safe after crashes. */
  fallbackMessageId?: string
  /** Test seam; production uses one per-client, per-space write scheduler. */
  writeScheduler?: RendererWriteScheduler
}

type FinalMessageBody = Partial<GoogleChatMessage> & { fallbackText?: string }

export type RendererWriteScheduler = {
  run: <T>(spaceName: string, write: () => Promise<T>) => Promise<T>
}

/** Serialize writes per space and leave one full quota window between starts. */
export function createRendererWriteScheduler(opts: {
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  intervalMs?: number
} = {}): RendererWriteScheduler {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep
    ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const intervalMs = opts.intervalMs ?? WRITE_INTERVAL_MS
  const tails = new Map<string, Promise<void>>()
  const nextStart = new Map<string, number>()

  return {
    run<T>(spaceName: string, write: () => Promise<T>): Promise<T> {
      const previous = tails.get(spaceName) ?? Promise.resolve()
      const scheduled = previous.catch(() => undefined).then(async () => {
        const delay = Math.max(0, (nextStart.get(spaceName) ?? 0) - now())
        if (delay) await sleep(delay)
        const result = await write()
        nextStart.set(spaceName, now() + intervalMs)
        return result
      })
      const tail = scheduled.then(() => undefined, () => undefined)
      tails.set(spaceName, tail)
      void tail.finally(() => {
        if (tails.get(spaceName) === tail) tails.delete(spaceName)
      })
      return scheduled
    }
  }
}

const clientWriteSchedulers = new WeakMap<ChatEdgeClient, RendererWriteScheduler>()

/**
 * Consume the api-rs SSE stream for one turn and deliver the result to Google
 * Chat as a single message (the single-message UX from the legacy chatbot):
 * status pulses edit the "thinking" bubble live, then the final answer PATCHes
 * the same bubble. There is no streaming answer text — Google Chat lacks a
 * streaming primitive and rate-limits edits — so the canonical answer is only
 * written once, at the end.
 *
 * Drive it with createRenderState + consumeRenderStream + finalizeRender, which
 * lets the caller re-open a dropped stream between passes (see driveSession).
 */
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
): Promise<'updated' | 'created'> {
  await applyRendererEvents(client, target, state, state.mapper.flush())
  return deliverFinal(client, target, state)
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
 * Edit the "thinking" bubble with a single compact `_Centaur · <activity>…_`
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
  const text = `_Centaur · ${status}…_`
  if (text === state.lastSignature) return
  const now = Date.now()
  if (now - state.lastFlushAt < STATUS_FLUSH_INTERVAL_MS) return
  state.lastFlushAt = now
  state.lastSignature = text

  try {
    await rendererWrite(client, target).run(target.spaceName, () =>
      client.updateMessage(target.ackMessageName, { text })
    )
  } catch (error) {
    logWarn('googlechatbot_status_pulse_failed', error)
  }
}

async function deliverFinal(
  client: ChatEdgeClient,
  target: RenderTarget,
  state: RenderState
): Promise<'updated' | 'created'> {
  const text = finalText(state)
  const trailers = target.consoleSessionWidget ? [target.consoleSessionWidget] : []
  const bodies = finalMessageBodies(text, {
    plainTextOnly: target.plainTextOnly,
    threadName: target.threadName,
    trailers
  })
  let outcome: 'updated' | 'created' = 'created'

  for (let index = 0; index < bodies.length; index += 1) {
    const body = bodies[index]!
    assertMessageSize(
      body,
      index === 0 && target.ackMessageName ? undefined : target.threadName
    )
    if (index === 0 && target.ackMessageName) {
      const update = { text: body.text ?? '', cardsV2: body.cardsV2 ?? [] }
      try {
        await rendererWrite(client, target).run(target.spaceName, () =>
          client.updateMessage(target.ackMessageName, update)
        )
        outcome = 'updated'
        continue
      } catch (error) {
        if (!(error instanceof ChatApiError) || error.status !== 404) throw error
        logWarn('googlechatbot_final_ack_not_found_creating_replacement', error)
      }
    }
    await createFinalPart(client, target, body, index)
  }
  return outcome
}

async function createFinalPart(
  client: ChatEdgeClient,
  target: RenderTarget,
  body: FinalMessageBody,
  index: number
): Promise<void> {
  const messageId = stablePartMessageId(target, index)
  try {
    await rendererWrite(client, target).run(target.spaceName, () =>
      client.createMessage(target.spaceName, body, {
        messageId,
        threadName: target.threadName
      })
    )
  } catch (error) {
    if (!(error instanceof ChatApiError) || error.status !== 409) throw error
  }
}

export function finalMessageBodies(
  markdown: string,
  opts: { plainTextOnly?: boolean; threadName?: string; trailers?: GoogleChatCardWidget[] } = {}
): FinalMessageBody[] {
  const rendered = markdownToChatMessage(markdown)
  const trailers = opts.trailers ?? []
  const needsCard = !opts.plainTextOnly && hasStandaloneImage(markdown)
  if (!needsCard) return textMessageBodies(rendered.text, trailers, opts.threadName)

  const cards = [...(rendered.cardsV2 ?? [])]
  if (trailers.length) cards.push(trailerCard(trailers))
  const bodies: FinalMessageBody[] = []
  let current: Array<{ cardId: string; card: GoogleChatCard }> = []
  for (const card of cards) {
    const candidate: FinalMessageBody = {
      fallbackText: CARD_FALLBACK_TEXT,
      cardsV2: [...current, card]
    }
    if (messageFits(candidate, opts.threadName)) {
      current.push(card)
      continue
    }
    if (!current.length) {
      // An extreme URL can make a single image card exceed the API envelope.
      // Preserve the source exactly by falling back to ordered text messages.
      return textMessageBodies(rendered.text, trailers, opts.threadName)
    }
    bodies.push({ fallbackText: CARD_FALLBACK_TEXT, cardsV2: current })
    current = [card]
    assertMessageSize({ fallbackText: CARD_FALLBACK_TEXT, cardsV2: current }, opts.threadName)
  }
  if (current.length) bodies.push({ fallbackText: CARD_FALLBACK_TEXT, cardsV2: current })
  return bodies.length ? bodies : textMessageBodies(rendered.text, trailers, opts.threadName)
}

function trailerCard(trailers: GoogleChatCardWidget[]): { cardId: string; card: GoogleChatCard } {
  return { cardId: 'actions', card: { sections: [{ widgets: trailers }] } }
}

function textMessageBodies(
  text: string,
  trailers: GoogleChatCardWidget[],
  threadName?: string
): FinalMessageBody[] {
  const trailerCards = trailers.length ? [trailerCard(trailers)] : []
  const codePoints = Array.from(text)
  const bodies: FinalMessageBody[] = []
  let start = 0
  while (start < codePoints.length) {
    const cardsV2 = bodies.length === 0 ? trailerCards : []
    let low = start + 1
    let high = codePoints.length
    let end = start
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const body: FinalMessageBody = {
        text: codePoints.slice(start, middle).join(''),
        ...(cardsV2.length ? { fallbackText: CARD_FALLBACK_TEXT } : {}),
        cardsV2
      }
      if (messageFits(body, threadName)) {
        end = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (end === start) {
      if (cardsV2.length) {
        const trailerOnly = { fallbackText: CARD_FALLBACK_TEXT, cardsV2 }
        assertMessageSize(trailerOnly, threadName)
        bodies.push(trailerOnly)
        continue
      }
      throw new Error('Google Chat message limit is too small for one Unicode code point')
    }
    bodies.push({
      text: codePoints.slice(start, end).join(''),
      ...(cardsV2.length ? { fallbackText: CARD_FALLBACK_TEXT } : {}),
      cardsV2
    })
    start = end
  }
  return bodies.length ? bodies : [{
    text: ' ',
    ...(trailerCards.length ? { fallbackText: CARD_FALLBACK_TEXT } : {}),
    cardsV2: trailerCards
  }]
}

function assertMessageSize(body: FinalMessageBody, threadName?: string): void {
  const bytes = messageUtf8Bytes(withThread(body, threadName))
  if (bytes > chatReplyLimits.message.maxBytes) {
    throw new Error(
      `Google Chat Message is ${bytes} bytes; maximum is ${chatReplyLimits.message.maxBytes}`
    )
  }
}

function messageFits(body: FinalMessageBody, threadName?: string): boolean {
  return messageUtf8Bytes(withThread(body, threadName)) <= chatReplyLimits.message.maxBytes
}

function withThread(body: FinalMessageBody, threadName?: string): FinalMessageBody {
  return threadName ? { ...body, thread: { name: threadName } } : body
}

function rendererWrite(client: ChatEdgeClient, target: RenderTarget): RendererWriteScheduler {
  if (target.writeScheduler) return target.writeScheduler
  let scheduler = clientWriteSchedulers.get(client)
  if (!scheduler) {
    scheduler = createRendererWriteScheduler()
    clientWriteSchedulers.set(client, scheduler)
  }
  return scheduler
}

function stablePartMessageId(target: RenderTarget, index: number): string {
  const base = target.fallbackMessageId ?? `client-centaur-${stableHash(
    target.ackMessageName || `${target.spaceName}:${target.threadName ?? ''}`
  )}`
  if (index === 0) return base
  const suffix = `-part-${index + 1}`
  return `${base.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
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
