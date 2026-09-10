import { describe, expect, test } from 'bun:test'
import { loadConfig } from './config'
import { wantsUserIdentity } from './identity-request'
import type { GoogleChatEnvelope } from './chat/types'

const on = loadConfig({ GOOGLECHATBOT_REQUEST_USER_IDENTITY: 'true' })
const off = loadConfig({})

const message = (tokens: GoogleChatEnvelope['authorizationEventObject']): GoogleChatEnvelope =>
  ({
    type: 'MESSAGE',
    authorizationEventObject: tokens,
    user: { name: 'users/U1', type: 'HUMAN' },
    space: { name: 'spaces/AAAA', spaceType: 'SPACE' },
    message: { name: 'spaces/AAAA/messages/M1', sender: { name: 'users/U1', type: 'HUMAN' } }
  }) as unknown as GoogleChatEnvelope

describe('wantsUserIdentity', () => {
  test('asks when an add-on event from a human carries no user token and no consent record', () => {
    expect(wantsUserIdentity(on, message({ systemIdToken: 'sys' }))).toBe(true)
  })

  test('is off by default', () => {
    expect(wantsUserIdentity(off, message({ systemIdToken: 'sys' }))).toBe(false)
  })

  test('never asks when the token is already there, or the sender already answered', () => {
    expect(wantsUserIdentity(on, message({ systemIdToken: 'sys', userIdToken: 'user' }))).toBe(false)
    expect(wantsUserIdentity(on, message({ systemIdToken: 'sys', authorizedScopes: [] }))).toBe(false)
  })

  test('ignores non add-on envelopes, non-message events, and bots', () => {
    expect(wantsUserIdentity(on, message(undefined))).toBe(false)
    const added = { ...message({ systemIdToken: 'sys' }), type: 'ADDED_TO_SPACE' } as GoogleChatEnvelope
    expect(wantsUserIdentity(on, added)).toBe(false)
    const bot = message({ systemIdToken: 'sys' })
    bot.message!.sender!.type = 'BOT'
    expect(wantsUserIdentity(on, bot)).toBe(false)
  })
})
