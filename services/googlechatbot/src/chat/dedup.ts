import type { GoogleChatActionPayload } from './types'
import type { StateAdapter } from 'chat'

export class EventDeduper {
  readonly ttlMs: number
  private readonly state: StateAdapter

  constructor(state: StateAdapter, ttlMs: number) {
    this.state = state
    this.ttlMs = ttlMs
  }

  async acquire(key: string, token: string): Promise<boolean> {
    return this.state.setIfNotExists(`googlechatbot:dedupe:${key}`, token, this.ttlMs)
  }

  async complete(key: string): Promise<void> {
    await this.state.set(`googlechatbot:dedupe:${key}`, 'completed', this.ttlMs)
  }

  async release(key: string, token: string): Promise<void> {
    const stateKey = `googlechatbot:dedupe:${key}`
    if ((await this.state.get<string>(stateKey)) === token) {
      await this.state.delete(stateKey)
    }
  }
}

export function chatDedupKey(opts: {
  eventTime?: string
  spaceName?: string
  messageName?: string
  action?: GoogleChatActionPayload
}): string {
  if (opts.action) {
    return `action:${canonicalJson([
      opts.eventTime ?? '',
      opts.spaceName ?? '',
      opts.messageName ?? '',
      opts.action.user_id ?? '',
      opts.action.invoked_function,
      opts.action.parameters ?? {},
      opts.action.form_inputs ?? {}
    ])}`
  }
  if (opts.messageName) return `message:${opts.spaceName ?? 'unknown'}:${opts.messageName}`
  if (opts.eventTime) return `event:${opts.spaceName ?? 'unknown'}:${opts.eventTime}`
  return `event:unknown:${Date.now()}`
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => [key, sortValue(nested)])
  )
}
