import { describe, expect, test } from 'bun:test'
import { isChatStopCommand } from './stop-command'

describe('Google Chat stop command detection', () => {
  test('matches a bare stop keyword (bot mention pre-stripped by argumentText)', () => {
    expect(isChatStopCommand('stop')).toBe(true)
    expect(isChatStopCommand('STOP now')).toBe(true)
    expect(isChatStopCommand('please stop')).toBe(true)
    expect(isChatStopCommand('stoppp')).toBe(true)
    expect(isChatStopCommand('could you stop the execution?')).toBe(true)
  })

  test('matches kill, end, cancel, and common variants', () => {
    for (const text of [
      'kill',
      'kill it',
      'killed',
      'killing',
      'end',
      'end it',
      'ended',
      'ending',
      'cancel',
      'cancels',
      'canceled',
      'cancelled',
      'canceling',
      'cancelling'
    ]) {
      expect(isChatStopCommand(text)).toBe(true)
    }
  })

  test('matches with residual mention tokens', () => {
    // normalize.ts rewrites other users' <users/{id}> tokens to @{id}; raw
    // tokens are handled defensively in case a payload skips normalization.
    expect(isChatStopCommand('<users/1234567890> stop')).toBe(true)
    expect(isChatStopCommand('@1234567890 stop')).toBe(true)
    expect(isChatStopCommand('@Centaur stop')).toBe(true)
    expect(isChatStopCommand('please @Centaur STOP now')).toBe(true)
    expect(isChatStopCommand('@Centaur could you stop the execution?')).toBe(true)
    expect(isChatStopCommand('@Centaur cancel')).toBe(true)
  })

  test('does not match unrelated messages', () => {
    expect(isChatStopCommand('')).toBe(false)
    expect(isChatStopCommand('status')).toBe(false)
    expect(isChatStopCommand('stopping by to ask')).toBe(false)
    expect(isChatStopCommand('run an end-to-end test')).toBe(false)
    expect(isChatStopCommand('cancellation policy')).toBe(false)
    expect(isChatStopCommand('if so, stop.')).toBe(false)
    expect(isChatStopCommand('please check the service; if it is broken, stop.')).toBe(false)
    expect(isChatStopCommand('cancel the invite for user@example.com')).toBe(false)
  })
})
