import { test, expect, describe } from 'bun:test'
import { normalizeChatEnvelope, normalizeChatText } from './normalize'
import type { GoogleChatEnvelope } from './types'

const BOT_USER = 'users/bot-account'

function messageEnvelope(overrides: Partial<GoogleChatEnvelope> = {}): GoogleChatEnvelope {
  return {
    type: 'MESSAGE',
    eventTime: '2026-01-01T00:00:00Z',
    space: { name: 'spaces/AAAA', type: 'SPACE' },
    message: {
      name: 'spaces/AAAA/messages/M1',
      text: '<users/bot-account> hello',
      sender: { name: 'users/U1', displayName: 'Alice' }
    },
    ...overrides
  }
}

describe('normalizeChatEnvelope', () => {
  test('produces a NormalizedChatEvent for a MESSAGE in a space', async () => {
    const normalized = await normalizeChatEnvelope(messageEnvelope(), BOT_USER)
    expect(normalized).not.toBeNull()
    expect(normalized!.thread_key).toBe('chat:spaces:AAAA:spaces:AAAA:messages:M1')
    expect(normalized!.message_id).toBe('spaces/AAAA/messages/M1')
    expect(normalized!.user_id).toBe('users/U1')
    expect(normalized!.user_name).toBe('Alice')
    expect(normalized!.is_mention).toBe(true)
    expect(normalized!.space_type).toBe('SPACE')
    expect(normalized!.parts).toHaveLength(1)
    expect(normalized!.parts[0]).toMatchObject({ type: 'text' })
  })

  test('does not include the dropped vaporware fields', async () => {
    const normalized = await normalizeChatEnvelope(messageEnvelope(), BOT_USER)
    expect(normalized).not.toBeNull()
    // is_command and command_id were shipped by PR #2 but never read by the
    // workflow; ensure they stay stripped so we don't drift back into them.
    expect(normalized).not.toHaveProperty('is_command')
    expect(normalized).not.toHaveProperty('command_id')
  })

  test('drops APP_COMMAND and CARD_CLICKED events instead of forwarding garbage', async () => {
    const appCmd = await normalizeChatEnvelope(
      {
        type: 'APP_COMMAND',
        space: { name: 'spaces/AAAA', type: 'SPACE' },
        appCommandMetadata: { appCommandId: 42, appCommandType: 'SLASH_COMMAND' }
      },
      BOT_USER
    )
    expect(appCmd).toBeNull()

    const cardClick = await normalizeChatEnvelope(
      { type: 'CARD_CLICKED', space: { name: 'spaces/AAAA', type: 'SPACE' } },
      BOT_USER
    )
    expect(cardClick).toBeNull()
  })

  test('emits a synthetic event for ADDED_TO_SPACE', async () => {
    const added = await normalizeChatEnvelope(
      { type: 'ADDED_TO_SPACE', space: { name: 'spaces/BBBB', type: 'SPACE' } },
      BOT_USER
    )
    expect(added).not.toBeNull()
    expect(added!.message_id).toBe('chat:spaces/BBBB:added_to_space')
    expect(added!.is_mention).toBe(true)
  })

  test('returns null for REMOVED_FROM_SPACE', async () => {
    const removed = await normalizeChatEnvelope(
      { type: 'REMOVED_FROM_SPACE', space: { name: 'spaces/BBBB', type: 'SPACE' } },
      BOT_USER
    )
    expect(removed).toBeNull()
  })

  test('skips the bot’s own messages', async () => {
    const own = await normalizeChatEnvelope(
      messageEnvelope({
        message: {
          name: 'spaces/AAAA/messages/M2',
          text: 'echo',
          sender: { name: BOT_USER, displayName: 'Bot' }
        }
      }),
      BOT_USER
    )
    expect(own).toBeNull()
  })
})

describe('normalizeChatText', () => {
  test('strips the bot mention and HTML-decodes content', () => {
    const out = normalizeChatText('<users/bot-account> hello &amp; world', 'bot-account')
    expect(out).toBe('hello & world')
  })

  test('rewrites user mentions to a friendly @handle form', () => {
    const out = normalizeChatText('hello <users/u-1>', undefined)
    expect(out).toBe('hello @u-1')
  })

  test('preserves links and decodes HTML entities', () => {
    const out = normalizeChatText('see <https://example.com|the docs> &lt;here&gt;', undefined)
    expect(out).toBe('see the docs (https://example.com) <here>')
  })
})
