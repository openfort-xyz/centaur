import {
  CodexAppServerRendererEventMapper,
  type RendererEvent
} from '@centaur/rendering'
import type { RustSessionStreamEvent } from '@centaur/harness-events'
import type { ChatEdgeClient } from './chat/client'
import { markdownToChatMessage } from './chat/render'
import { logError, logWarn } from './logging'
import type { GoogleChatMessage } from './chat/types'

export const INITIAL_STATUS = '_Centaur is thinking…_'
const STATUS_FLUSH_INTERVAL_MS = 1_000
const EMPTY_ANSWER_TEXT = 'Execution completed, but no final text was captured.'

// Google Chat renders the text fallback AND a card. For a plain-text answer we
// drop the card so the user does not see the reply twice; rich markdown
// (headers, lists, code, tables) is worth the card layout.
const LOOKS_RICH_RE =
  /(^|\n)\s*#{1,6}\s|```|(^|\n)\s*[-*+]\s|(^|\n)\s*\d+\.\s|\|.*\|/

export type RenderTarget = {
  spaceName: string
  /** Resource name of the pre-posted "thinking" message we PATCH with the answer. */
  ackMessageName: string
  /** Thread to fall back into if the ack PATCH fails and we must post fresh. */
  threadName?: string
}

/**
 * Consume the api-rs SSE stream for one turn and deliver the result to Google
 * Chat as a single message (the single-message UX from the legacy chatbot):
 * status pulses edit the "thinking" bubble live, then the final answer PATCHes
 * the same bubble. There is no streaming answer text — Google Chat lacks a
 * streaming primitive and rate-limits edits — so the canonical answer is only
 * written once, at the end.
 */
export async function renderSessionToChat(
  client: ChatEdgeClient,
  stream: AsyncIterable<RustSessionStreamEvent>,
  target: RenderTarget
): Promise<void> {
  const mapper = new CodexAppServerRendererEventMapper()
  const state: RenderState = {
    answer: '',
    error: undefined,
    lastStatus: INITIAL_STATUS,
    lastStatusFlushAt: 0
  }

  try {
    for await (const event of stream) {
      captureStreamError(event, state)
      await applyRendererEvents(client, target, state, mapper.process(event))
    }
    await applyRendererEvents(client, target, state, mapper.flush())
  } catch (error) {
    state.error = state.error ?? errorText(error)
    logError('googlechatbot_render_stream_failed', error)
  }

  await deliverFinal(client, target, state)
}

type RenderState = {
  answer: string
  error: string | undefined
  lastStatus: string
  lastStatusFlushAt: number
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
        await pulseStatus(client, target, state, event.status)
        break
      case 'renderer.task.update':
        await pulseStatus(client, target, state, event.task.title)
        break
      case 'renderer.done':
        if (typeof event.answerMarkdown === 'string' && event.answerMarkdown.trim()) {
          state.answer = event.answerMarkdown
        }
        if (event.error) state.error = state.error ?? event.error
        break
      default:
        break
    }
  }
}

/**
 * Edit the "thinking" bubble with a short `_Centaur · <task>…_` pulse, deduped
 * and rate-limited to 1 Hz so we don't spam Google Chat's edit endpoint.
 */
async function pulseStatus(
  client: ChatEdgeClient,
  target: RenderTarget,
  state: RenderState,
  rawTitle: string
): Promise<void> {
  if (!target.ackMessageName) return
  const title = rawTitle.trim().slice(0, 80)
  if (!title) return
  const status = `_Centaur · ${title}…_`
  if (status === state.lastStatus) return
  const now = Date.now()
  if (now - state.lastStatusFlushAt < STATUS_FLUSH_INTERVAL_MS) return
  state.lastStatusFlushAt = now
  state.lastStatus = status
  try {
    await client.updateMessage(target.ackMessageName, { text: status })
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
  const looksRich = LOOKS_RICH_RE.test(text)
  const body: Partial<GoogleChatMessage> = looksRich
    ? { text: rendered.fallbackText, cardsV2: rendered.cardsV2 }
    : { text: rendered.fallbackText, cardsV2: [] }

  if (target.ackMessageName) {
    try {
      await client.updateMessage(target.ackMessageName, body)
      return
    } catch (error) {
      logError('googlechatbot_final_patch_failed_falling_back_to_create', error)
    }
  }

  try {
    const createBody: Partial<GoogleChatMessage> = looksRich
      ? body
      : { text: rendered.fallbackText }
    await client.createMessage(target.spaceName, createBody, { threadName: target.threadName })
  } catch (error) {
    logError('googlechatbot_final_create_failed', error)
  }
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
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
