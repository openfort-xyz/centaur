import type { RustSessionStreamEvent } from '@centaur/harness-events'
import type { AppConfig } from './config'
import { centaurApiKey } from './config'
import { logWarn } from './logging'
import type { NormalizedChatEvent, NormalizedPart } from './chat/types'

// ---------------------------------------------------------------------------
// api-rs session contract
//
// This is the Google Chat analog of services/discordbot/src/session-api.ts and
// services/slackbotv2/src/session-api.ts. The legacy chatbot drove the deleted
// Python API via POST /workflows/runs plus an outbox poll; api-rs replaced that
// with a session lifecycle:
//
//   POST /api/session/{thread_key}            create the session
//   POST /api/session/{thread_key}/messages   append prior thread turns
//   POST /api/session/{thread_key}/execute    start an agent run for this turn
//   GET  /api/session/{thread_key}/events     SSE stream of the run's output
//
// The platform is opaque to api-rs (metadata.platform is advisory), so the
// only Google-Chat-specific bits are the metadata source/platform tags and the
// conversation display name.
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }
export type JsonObject = { [key: string]: JsonValue | undefined }

/** A single Google Chat turn flattened into the shape api-rs expects. */
export type GoogleChatTurnMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  parts: NormalizedPart[]
  isMention: boolean
  userId: string
  userName: string
  timestamp?: string
}

type CreateSessionRequest = {
  harness_type: string
  metadata: JsonObject
}

type AppendMessagesRequest = {
  messages: Array<{
    client_message_id?: string
    role: 'user' | 'assistant'
    parts: JsonValue[]
    metadata: JsonObject
  }>
}

type ExecuteSessionRequest = {
  idempotency_key?: string
  idle_timeout_ms?: number
  input_lines: string[]
  max_duration_ms?: number
  metadata: JsonObject
}

export type ExecuteSessionResponse = {
  execution_id: string
  ok: boolean
  status: string
  thread_key: string
}

export class SessionApiError extends Error {
  readonly action: string
  readonly body: string
  readonly retryable: boolean
  readonly status: number
  readonly statusText: string

  constructor(input: {
    action: string
    body: string
    retryable: boolean
    status: number
    statusText: string
  }) {
    // api-rs is internal and its error bodies can carry internals; the message
    // stays generic because it is surfaced verbatim into the Google Chat thread.
    super(`Centaur session ${input.action} failed: ${input.status} ${input.statusText}`)
    this.name = 'SessionApiError'
    this.action = input.action
    this.body = input.body
    this.retryable = input.retryable
    this.status = input.status
    this.statusText = input.statusText
  }
}

export function isRetryableSessionApiError(error: unknown): boolean {
  if (error instanceof SessionApiError) return error.retryable
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'TypeError'
}

/**
 * Build the turn message executed for a Google Chat event, plus the prior
 * thread turns appended as context.
 */
export function turnMessagesFromEvent(event: NormalizedChatEvent): {
  execute: GoogleChatTurnMessage
  history: GoogleChatTurnMessage[]
} {
  const history: GoogleChatTurnMessage[] = (event.history_messages ?? []).map((message, index) => ({
    id: message.message_id || `${event.thread_key}:history:${index}`,
    role: message.role === 'assistant' ? 'assistant' : 'user',
    text: textFromParts(message.parts),
    parts: message.parts,
    isMention: false,
    userId: message.user_id ?? '',
    userName: stringFromMetadata(message.metadata, 'user_name')
  }))

  const execute: GoogleChatTurnMessage = {
    id: event.message_id,
    role: 'user',
    text: textFromParts(event.parts),
    parts: event.parts,
    isMention: event.is_mention,
    userId: event.user_id,
    userName: event.user_name,
    timestamp: event.chat.event_time
  }

  return { execute, history }
}

export async function createSession(
  config: AppConfig,
  threadKey: string,
  conversationName?: string
): Promise<void> {
  const name = conversationName?.trim()
  const body: CreateSessionRequest = {
    harness_type: 'codex',
    metadata: {
      source: 'googlechatbot',
      platform: 'googlechat',
      thread_id: threadKey,
      // api-rs reads this as the session principal's display name.
      ...(name ? { googlechat_conversation_name: name } : {})
    }
  }
  const response = await fetch(apiSessionUrl(config, threadKey), {
    method: 'POST',
    headers: apiHeaders(config),
    body: JSON.stringify(body)
  })
  await ensureApiOk(response, 'create session')
}

export async function appendSessionMessages(
  config: AppConfig,
  threadKey: string,
  messages: GoogleChatTurnMessage[]
): Promise<void> {
  if (messages.length === 0) return
  const body: AppendMessagesRequest = {
    messages: messages.map(message => ({
      client_message_id: message.id,
      role: message.role,
      parts: sessionMessageParts(message),
      metadata: sessionMetadata(threadKey, message)
    }))
  }
  const response = await fetch(apiSessionUrl(config, threadKey, 'messages'), {
    method: 'POST',
    headers: apiHeaders(config),
    body: JSON.stringify(body)
  })
  await ensureApiOk(response, 'append session messages')
}

export async function executeSession(
  config: AppConfig,
  threadKey: string,
  message: GoogleChatTurnMessage,
  opts: { idleTimeoutMs?: number; maxDurationMs?: number } = {}
): Promise<ExecuteSessionResponse> {
  const body: ExecuteSessionRequest = {
    idempotency_key: message.id,
    metadata: sessionMetadata(threadKey, message, { action: 'execute' }),
    input_lines: [toCodexInputLine(threadKey, message)],
    ...(opts.idleTimeoutMs === undefined ? {} : { idle_timeout_ms: opts.idleTimeoutMs }),
    ...(opts.maxDurationMs === undefined ? {} : { max_duration_ms: opts.maxDurationMs })
  }
  const response = await fetch(apiSessionUrl(config, threadKey, 'execute'), {
    method: 'POST',
    headers: apiHeaders(config),
    body: JSON.stringify(body)
  })
  await ensureApiOk(response, 'execute session')
  return (await response.json()) as ExecuteSessionResponse
}

export async function openSessionEventStream(
  config: AppConfig,
  threadKey: string,
  afterEventId: number,
  executionId: string | undefined,
  onEventId: (eventId: number) => void
): Promise<AsyncIterable<RustSessionStreamEvent>> {
  const url = new URL(apiSessionUrl(config, threadKey, 'events'))
  url.searchParams.set('after_event_id', String(afterEventId))
  if (executionId) url.searchParams.set('execution_id', executionId)
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: apiHeaders(config, false)
  })
  await ensureApiOk(response, 'stream events')
  if (!response.body) return emptyStream()
  return parseSessionEventStream(response.body, onEventId)
}

export function sessionStreamError(error: unknown): RustSessionStreamEvent {
  return {
    data: { error: error instanceof Error ? error.message : String(error) },
    event: 'session.stream_error',
    eventKind: 'session.stream_error'
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function textFromParts(parts: NormalizedPart[]): string {
  return parts
    .filter((part): part is Extract<NormalizedPart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim()
}

function stringFromMetadata(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key]
  return typeof value === 'string' ? value : ''
}

function sessionMessageParts(message: GoogleChatTurnMessage): JsonValue[] {
  const parts: JsonValue[] = []
  if (message.text.trim()) parts.push({ type: 'text', text: message.text })
  for (const part of message.parts) {
    if (part.type === 'text') continue
    parts.push({
      type: 'attachment',
      attachment_type: part.type === 'image' ? 'image' : 'file',
      name: part.name,
      mime_type: part.mime_type,
      size: part.size
    })
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }]
}

function sessionMetadata(
  threadKey: string,
  message: GoogleChatTurnMessage,
  extra: JsonObject = {}
): JsonObject {
  return {
    source: 'googlechatbot',
    platform: 'googlechat',
    message_id: message.id,
    thread_id: threadKey,
    is_mention: message.isMention,
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    user_id: message.userId,
    user_name: message.userName,
    ...extra
  }
}

function toCodexInputLine(threadKey: string, message: GoogleChatTurnMessage): string {
  return JSON.stringify({
    type: 'user',
    thread_key: threadKey,
    trace_metadata: sessionMetadata(threadKey, message, { action: 'execute' }),
    message: {
      role: 'user',
      content: codexInputContent(message)
    }
  })
}

function codexInputContent(message: GoogleChatTurnMessage): JsonValue[] {
  const content: JsonValue[] = []
  if (message.text.trim()) content.push({ type: 'text', text: message.text })
  for (const part of message.parts) {
    if (part.type === 'text') continue
    if (part.type === 'image' && part.source?.data && part.mime_type) {
      content.push({
        type: 'image',
        url: `data:${part.mime_type};base64,${part.source.data}`,
        detail: 'auto',
        name: part.name
      })
      continue
    }
    content.push({
      type: 'text',
      text: `[Google Chat attachment: name=${part.name} type=${part.type} mime=${part.mime_type}]`
    })
  }
  return content.length > 0 ? content : [{ type: 'text', text: 'continue' }]
}

function apiSessionUrl(
  config: AppConfig,
  threadKey: string,
  suffix?: 'messages' | 'execute' | 'events'
): string {
  const path = `/api/session/${encodeURIComponent(threadKey)}${suffix ? `/${suffix}` : ''}`
  return new URL(path, ensureTrailingSlash(config.CENTAUR_API_URL)).toString()
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function apiHeaders(config: AppConfig, jsonBody = true): HeadersInit {
  const apiKey = centaurApiKey(config)
  return {
    ...(jsonBody ? { 'content-type': 'application/json' } : {}),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  }
}

async function ensureApiOk(response: Response, action: string): Promise<void> {
  if (response.ok) return
  let body = ''
  try {
    body = await response.text()
  } catch {
    body = ''
  }
  if (body) {
    logWarn('googlechatbot_session_api_error', {
      action,
      status: response.status,
      status_text: response.statusText,
      body
    })
  }
  throw new SessionApiError({
    action,
    body,
    retryable: isRetryableApiStatus(response.status),
    status: response.status,
    statusText: response.statusText
  })
}

function isRetryableApiStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

// ---------------------------------------------------------------------------
// SSE parsing (mirrors discordbot/slackbotv2 session-api stream handling)
// ---------------------------------------------------------------------------

type ParsedSessionEvent = {
  data: string
  event?: string
  id?: number
}

async function* parseSessionEventStream(
  stream: ReadableStream<Uint8Array>,
  onEventId: (eventId: number) => void
): AsyncIterable<RustSessionStreamEvent> {
  for await (const event of parseSseEvents(stream)) {
    if (typeof event.id === 'number') onEventId(event.id)
    if (event.event === 'session.output.line') {
      yield {
        data: event.data,
        event: event.event,
        eventId: event.id,
        eventKind: event.event
      }
      if (isTerminalCodexOutputLine(event.data)) return
      continue
    }
    if (event.event === 'session.execution_failed' || event.event === 'session.stream_error') {
      yield {
        data: { error: sessionErrorMessage(event) },
        event: event.event,
        eventId: event.id,
        eventKind: event.event
      }
      return
    }
    if (event.event === 'session.execution_cancelled') {
      yield {
        data: { error: sessionErrorMessage(event, 'Execution cancelled') },
        event: event.event,
        eventId: event.id,
        eventKind: event.event
      }
      return
    }
    if (event.event === 'session.execution_completed') {
      yield {
        data: sessionEventData(event),
        event: event.event,
        eventId: event.id,
        eventKind: event.event
      }
      return
    }
  }
}

async function* parseSseEvents(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<ParsedSessionEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let eventId: number | undefined
  let data: string[] = []

  // The consumer returns early on terminal events, abandoning this generator at
  // a yield point. Without the finally the reader lock is never released and the
  // SSE connection leaks on every completed run.
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const emitted = parseSseLine(line, { data, eventId, eventName })
        data = emitted.state.data
        eventId = emitted.state.eventId
        eventName = emitted.state.eventName
        if (emitted.event) yield emitted.event
      }
    }

    buffer += decoder.decode()
    if (buffer) {
      const emitted = parseSseLine(buffer, { data, eventId, eventName })
      data = emitted.state.data
      eventId = emitted.state.eventId
      eventName = emitted.state.eventName
      if (emitted.event) yield emitted.event
    }
    if (data.length > 0) {
      yield { data: data.join('\n'), event: eventName, id: eventId }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function parseSseLine(
  line: string,
  state: { data: string[]; eventId?: number; eventName?: string }
): {
  event?: ParsedSessionEvent
  state: { data: string[]; eventId?: number; eventName?: string }
} {
  if (!line.trim()) {
    const event =
      state.data.length > 0
        ? { data: state.data.join('\n'), event: state.eventName, id: state.eventId }
        : undefined
    return { event, state: { data: [] } }
  }
  if (line.startsWith(':')) return { state }

  const separator = line.indexOf(':')
  const field = separator >= 0 ? line.slice(0, separator) : line
  const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : ''
  if (field === 'event') return { state: { ...state, eventName: value } }
  if (field === 'id') {
    const id = Number.parseInt(value, 10)
    return { state: { ...state, eventId: Number.isFinite(id) ? id : undefined } }
  }
  if (field === 'data' && value !== '[DONE]') {
    return { state: { ...state, data: [...state.data, value] } }
  }
  return { state }
}

function isTerminalCodexOutputLine(line: string): boolean {
  let payload: unknown
  try {
    payload = JSON.parse(line)
  } catch {
    // Non-JSON stdout lines (sandbox bootstrap notices) are noise, not a signal
    // that the turn finished; treating them as terminal drops the answer.
    return false
  }
  if (typeof payload !== 'object' || payload === null) return false
  const record = payload as Record<string, unknown>
  return (
    record.type === 'turn.completed' ||
    record.type === 'turn.failed' ||
    record.type === 'turn.done' ||
    record.method === 'error' ||
    record.method === 'turn/completed'
  )
}

function sessionEventData(event: ParsedSessionEvent): unknown {
  try {
    return JSON.parse(event.data)
  } catch {
    return event.data
  }
}

function sessionErrorMessage(event: ParsedSessionEvent, fallback?: string): string {
  let message = fallback ?? `${event.event ?? 'session error'}`
  try {
    const payload = JSON.parse(event.data)
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>
      if (typeof record.error === 'string') message = record.error
      else if (typeof record.message === 'string') message = record.message
    }
  } catch {
    if (event.data.trim()) message = event.data.trim()
  }
  return message
}

function emptyStream(): AsyncIterable<RustSessionStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      // no events
    }
  }
}
