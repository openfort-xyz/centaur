import type { ChatEdgeClient } from './client'

// Live = ack pulse, outbox = canonical answer writer.
//
// open() posts ONE compact "_Centaur is thinking…_" placeholder. The returned
// messageName is round-tripped via API metadata into the final-delivery outbox
// row; the outbox poller PATCHes that same message with the final answer when
// the agent run terminates. The live path itself never writes the canonical
// answer text — it only emits short status pulses based on step events so the
// user sees the bot is working.
//
// This sidesteps several structural problems with mirroring the Slack
// "evolving message" model on Google Chat: no streaming primitive, full-message
// PATCHes are rate-limited, codex emits deltas (stateful reconcile would have
// to live somewhere), and writing both the ack and the answer leads to
// duplicate-bubble bugs. Picking a single writer per content type makes those
// go away by construction.

type AgentSession = {
  id: string
  spaceName: string
  messageName: string
  threadName?: string
  createdAt: number
  lastFlushAt: number
  lastStatus: string
}

const sessions = new Map<string, AgentSession>()
const sessionLocks = new Map<string, Promise<void>>()

const INITIAL_STATUS = '_Centaur is thinking…_'
const FLUSH_INTERVAL_MS = 1000

export function getAgentSession(sessionId: string): AgentSession | undefined {
  return sessions.get(sessionId)
}

export async function withAgentSessionLock<T>(
  sessionId: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve()
  let release: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  sessionLocks.set(sessionId, prev.then(() => current))
  await prev
  try {
    return await fn()
  } finally {
    release!()
  }
}

export class AgentSessionRenderer {
  private readonly client: ChatEdgeClient

  constructor(client: ChatEdgeClient) {
    this.client = client
  }

  async open(opts: {
    spaceName: string
    threadName?: string
  }): Promise<{ sessionId: string; messageName: string }> {
    const sessionId = `chat-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const message = await this.client.createMessage(
      opts.spaceName,
      { text: INITIAL_STATUS },
      { threadName: opts.threadName }
    )

    const session: AgentSession = {
      id: sessionId,
      spaceName: opts.spaceName,
      messageName: message.name ?? '',
      threadName: opts.threadName,
      createdAt: Date.now(),
      lastFlushAt: Date.now(),
      lastStatus: INITIAL_STATUS
    }

    sessions.set(sessionId, session)
    return { sessionId, messageName: session.messageName }
  }

  // No-op: intermediate agent text is never displayed live. The outbox poller
  // is the sole writer of the canonical answer.
  async text(sessionId: string, _markdown: string): Promise<void> {
    if (!sessions.has(sessionId)) {
      throw new Error(`Agent session not found: ${sessionId}`)
    }
  }

  // Emit a short "Centaur · <task title>" pulse so the user sees progress.
  // Rate-limited to 1 Hz per session and deduped against the previous status
  // so unchanged-event spam doesn't burn through Google Chat edit quota.
  async step(
    sessionId: string,
    task: { id: string; title: string; status?: string; details?: string; output?: string }
  ): Promise<void> {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Agent session not found: ${sessionId}`)

    const title = (task.title ?? '').trim().slice(0, 80)
    if (!title) return
    const newStatus = `_Centaur · ${title}…_`
    if (newStatus === session.lastStatus) return

    const now = Date.now()
    if (now - session.lastFlushAt < FLUSH_INTERVAL_MS) return
    session.lastFlushAt = now
    session.lastStatus = newStatus

    if (!session.messageName) return

    try {
      await this.client.updateMessage(session.messageName, { text: newStatus })
    } catch (error) {
      console.warn('agent_session_status_pulse_failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // No-op. The outbox poller will PATCH the ack message with the final answer
  // within ~1-2s of terminal. Session state is reaped here; the message name
  // travels to the poller via the outbox row's final_payload.
  async done(sessionId: string): Promise<void> {
    sessions.delete(sessionId)
    sessionLocks.delete(sessionId)
  }
}
