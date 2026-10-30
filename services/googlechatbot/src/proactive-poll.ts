import { randomUUID } from 'node:crypto'
import type { StateAdapter } from 'chat'
import type { AppConfig } from './config'
import type { ChatEdgeClient } from './chat/client'
import { chatDedupKey, type EventDeduper } from './chat/dedup'
import { buildThreadKey } from './chat/normalize'
import type { ChatListMessage, GoogleChatEnvelope } from './chat/types'
import { verifyChatRequest } from './chat/verify'
import { logError, logInfo, logWarn } from './logging'
import { incr } from './metrics'
import { resolveSenderEmail } from './sender-lookup'
import {
  acceptWork,
  acquireLease,
  threadStateKey,
  type GoogleChatThreadState,
  type GoogleChatWorkObligation
} from './state'

/**
 * Google only pushes a MESSAGE event when the app is mentioned, slash-commanded,
 * or in a DM. Unmentioned replies in the exact spaces configured for
 * contextual participation are collected here instead, by polling
 * spaces.messages.list under the app's own admin-approved read scope. Nothing
 * outside the configured spaces is ever listed.
 *
 * Each message passes the same gates as a webhook delivery: a durable dedupe
 * key shared with the webhook (so an event delivered both ways is processed
 * once), bot and self suppression, the domain allowlist and timestamp checks,
 * and the directory-backed sender identity. Mentions are left to the webhook
 * entirely so the signed delivery stays the source of a mentioned turn.
 */

const PAGE_SIZE = 100
const MAX_PAGES_PER_TICK = 5

export type ProactivePollerDeps = {
  client: ChatEdgeClient
  config: AppConfig
  deduper: EventDeduper
  spaces: readonly string[]
  state: StateAdapter
  enqueue: (work: GoogleChatWorkObligation) => void
  /** Test seams. */
  now?: () => number
  intervalMs?: number
}

export function cursorKey(spaceName: string): string {
  return `googlechatbot:proactive:cursor:${spaceName}`
}

function pollLeaseKey(spaceName: string): string {
  return `googlechatbot:proactive:poll:${spaceName}`
}

/** Where listing resumes: the newest createTime handled and every message
 * name seen at exactly that time. The next list uses `>=` so messages that
 * share the cursor's timestamp across a page boundary are not skipped; the
 * names keep the ones already handled from being accepted twice after the
 * dedupe key expires. */
export type PollCursor = { createTime: string; names: string[] }

/** Start the recurring poll; returns a function that stops it. */
export function startProactivePoller(deps: ProactivePollerDeps): () => void {
  const intervalMs = deps.intervalMs ?? deps.config.GOOGLECHATBOT_PROACTIVITY_POLL_INTERVAL_MS
  let running = false
  let stopped = false
  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      for (const spaceName of deps.spaces) {
        if (stopped) return
        await pollSpace(deps, spaceName, intervalMs).catch(error => {
          incr('googlechatbot_proactive_poll_total', { outcome: 'error' })
          logError('googlechatbot_proactive_poll_failed', error, { space_name: spaceName })
        })
      }
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/** One bounded pass over a space. Exported for tests. */
export async function pollSpace(
  deps: ProactivePollerDeps,
  spaceName: string,
  intervalMs: number
): Promise<void> {
  const { client, state } = deps
  const now = deps.now ?? Date.now
  // With several replicas, one polls a space at a time; the cursor is shared.
  const lease = await acquireLease(state, pollLeaseKey(spaceName), Math.max(intervalMs * 3, 15_000), intervalMs)
  if (!lease) return
  try {
    const space = await client.getSpace(spaceName)
    const spaceType = typeof space.spaceType === 'string' ? space.spaceType : undefined
    if (spaceType === 'DIRECT_MESSAGE') {
      incr('googlechatbot_proactive_poll_total', { outcome: 'skip_dm' })
      return
    }
    // A fresh cursor starts now: the bot never answers messages from before
    // it was configured to listen.
    let cursor = await state.get<PollCursor>(cursorKey(spaceName))
    if (!cursor?.createTime) {
      cursor = { createTime: new Date(now()).toISOString(), names: [] }
      await state.set(cursorKey(spaceName), cursor)
    }
    const botUserName = await client.getBotUserName(spaceName).catch(() => undefined)
    let pageToken: string | undefined
    // Advances only past messages that were fully handled, in order: a
    // message the bot could not durably accept stays ahead of the cursor and
    // is listed again next pass instead of being dropped.
    let handled: PollCursor = { ...cursor, names: [...cursor.names] }
    let halted = false
    for (let page = 0; page < MAX_PAGES_PER_TICK && !halted; page += 1) {
      const listed = await client.listMessages(spaceName, {
        pageSize: PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
        // Google accepts only `>` here (`>=` is INVALID_ARGUMENT, verified
        // live), so look back one nanosecond and let the seen names at the
        // cursor's own timestamp keep the boundary inclusive without repeats.
        filter: `createTime > "${oneNanosecondBefore(cursor.createTime)}"`,
        orderBy: 'createTime ASC'
      })
      for (const message of listed.messages ?? []) {
        if (!message.name || !message.createTime) continue
        const order = compareRfc3339(message.createTime, handled.createTime)
        if (order < 0 || (order === 0 && handled.names.includes(message.name))) continue
        if (lease.lost.aborted) {
          halted = true
          break
        }
        const outcome = await considerMessage(deps, spaceName, spaceType ?? 'SPACE', message, botUserName)
        if (outcome === 'failed') {
          halted = true
          break
        }
        handled = order > 0
          ? { createTime: message.createTime, names: [message.name] }
          : { createTime: handled.createTime, names: [...handled.names, message.name] }
      }
      pageToken = listed.nextPageToken
      if (!pageToken) break
    }
    if (lease.lost.aborted) return
    if (handled.createTime !== cursor.createTime || handled.names.length !== cursor.names.length) {
      await state.set(cursorKey(spaceName), handled)
    }
    incr('googlechatbot_proactive_poll_total', { outcome: halted ? 'halted' : 'ok' })
  } finally {
    await lease.release()
  }
}

/** Order two RFC 3339 timestamps regardless of fractional precision: Google
 * emits up to nanoseconds, while a cursor seeded locally has milliseconds. */
export function compareRfc3339(a: string, b: string): number {
  const [secondsA, fractionA] = splitFraction(a)
  const [secondsB, fractionB] = splitFraction(b)
  if (secondsA !== secondsB) return secondsA < secondsB ? -1 : 1
  return fractionA === fractionB ? 0 : fractionA < fractionB ? -1 : 1
}

/** The RFC 3339 instant one nanosecond earlier, at nanosecond precision. */
export function oneNanosecondBefore(value: string): string {
  const [seconds, fraction] = splitFraction(value)
  const nanos = Number.parseInt(fraction, 10)
  const base = nanos > 0 ? seconds : seconds - 1000
  const previous = nanos > 0 ? nanos - 1 : 999_999_999
  return `${new Date(base).toISOString().slice(0, 19)}.${String(previous).padStart(9, '0')}Z`
}

function splitFraction(value: string): [number, string] {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return [Date.parse(value), '000000000']
  const seconds = Date.parse(`${match[1]}${match[3]}`)
  return [seconds, (match[2] ?? '').padEnd(9, '0').slice(0, 9)]
}

type Disposition = 'handled' | 'failed'

async function considerMessage(
  deps: ProactivePollerDeps,
  spaceName: string,
  spaceType: string,
  message: ChatListMessage,
  botUserName: string | undefined
): Promise<Disposition> {
  const { client, config, deduper, state } = deps
  const record = (outcome: string): Disposition => {
    incr('googlechatbot_proactive_collected_total', { outcome })
    return 'handled'
  }
  const sender = message.sender
  if (!message.name || !sender?.name || !message.createTime) return record('malformed')
  if (sender.type === 'BOT' || (botUserName && sender.name === botUserName)) return record('bot')
  if (mentionsApp(message, botUserName) || message.slashCommand) return record('mention')
  if (!(message.text ?? message.argumentText ?? '').trim()) return record('empty')
  // Cheap durable pre-checks: a thread the bot was never mentioned in gets no
  // dedupe write and no obligation at all, and a message seen while a run is
  // active is that run's context, never a later unsolicited turn.
  const threadKey = buildThreadKey(spaceName, message.thread?.name ?? message.name)
  const threadState = await state.get<GoogleChatThreadState>(threadStateKey(threadKey))
  if (threadState?.proactiveEligible !== true) return record('not_eligible')
  if (threadState.activeExecution === true) return record('active_execution')

  const envelope: GoogleChatEnvelope = {
    type: 'MESSAGE',
    eventTime: message.createTime,
    space: { name: spaceName, spaceType },
    message: {
      name: message.name,
      text: message.text,
      ...(message.formattedText ? { formattedText: message.formattedText } : {}),
      ...(message.argumentText ? { argumentText: message.argumentText } : {}),
      ...(message.thread ? { thread: message.thread } : {}),
      ...(typeof message.threadReply === 'boolean' ? { threadReply: message.threadReply } : {}),
      sender,
      ...(message.annotations ? { annotations: message.annotations } : {}),
      ...(message.attachment ? { attachment: message.attachment } : {})
    },
    user: sender
  }
  // The listing came back over the app's own authenticated call, so the
  // sender id is Google's claim, exactly as a signed webhook's is.
  const userEmail = await resolveSenderEmail({
    lookup: userName => client.lookupSenderEmail(userName),
    verified: true,
    ingressMode: config.GOOGLECHATBOT_INGRESS_MODE,
    envelope
  })
  const verification = verifyChatRequest({ config, envelope, userEmail })
  if (!verification.ok) {
    logInfo('googlechatbot_proactive_collected_rejected', { reason: verification.reason, space_name: spaceName })
    return record(`rejected_${verification.reason}`)
  }
  const key = chatDedupKey({ eventTime: message.createTime, spaceName, messageName: message.name })
  const token = randomUUID()
  if (!(await deduper.acquire(key, token))) return record('duplicate')
  try {
    const work: GoogleChatWorkObligation = {
      acceptedAt: new Date().toISOString(),
      dedupeKey: key,
      envelope,
      eventType: 'MESSAGE',
      failures: 0,
      identityVerified: true,
      ...(userEmail ? { identityUserEmail: userEmail } : {}),
      lastEventId: 0,
      stage: 'accepted',
      workId: randomUUID()
    }
    await acceptWork(state, work)
    await deduper.complete(key)
    deps.enqueue(work)
    return record('accepted')
  } catch (error) {
    await deduper.release(key, token).catch(() => undefined)
    logWarn('googlechatbot_proactive_accept_failed', error, { space_name: spaceName })
    incr('googlechatbot_proactive_collected_total', { outcome: 'accept_failed' })
    return 'failed'
  }
}

function mentionsApp(message: ChatListMessage, botUserName: string | undefined): boolean {
  for (const annotation of message.annotations ?? []) {
    const user = annotation.userMention?.user
    if (annotation.type !== 'USER_MENTION' || !user) continue
    if (user.type === 'BOT' || (botUserName && user.name === botUserName)) return true
  }
  return Boolean(botUserName && (message.text ?? '').includes(`<${botUserName}>`))
}
