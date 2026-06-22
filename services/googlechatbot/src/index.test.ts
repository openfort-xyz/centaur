import { test, expect, describe } from 'bun:test'
import { parseFeedbackClick, parseChatBody } from './index'

describe('parseFeedbackClick', () => {
  test('returns null for a normal message body', () => {
    expect(parseFeedbackClick(JSON.stringify({ type: 'MESSAGE', message: { text: 'hi' } }))).toBeNull()
  })

  test('extracts an up rating from a v1 CARD_CLICKED payload', () => {
    const body = JSON.stringify({
      type: 'CARD_CLICKED',
      action: {
        actionMethodName: 'centaur_feedback',
        parameters: [{ key: 'rating', value: 'up' }]
      }
    })
    expect(parseFeedbackClick(body)).toBe('up')
  })

  test('extracts a down rating from a v2 commonEventObject payload', () => {
    const body = JSON.stringify({
      chat: {
        buttonClickedPayload: {
          commonEventObject: {
            invokedFunction: 'centaur_feedback',
            parameters: { rating: 'down' }
          }
        }
      }
    })
    expect(parseFeedbackClick(body)).toBe('down')
  })

  test('falls back to unknown when the function fires without a parseable rating', () => {
    expect(parseFeedbackClick('{"f":"centaur_feedback"}')).toBe('unknown')
  })
})

describe('parseChatBody', () => {
  test('unwraps a v2 messagePayload envelope', () => {
    const body = JSON.stringify({
      chat: {
        eventTime: '2026-01-01T00:00:00Z',
        messagePayload: {
          space: { name: 'spaces/AAAA', type: 'SPACE' },
          message: { name: 'spaces/AAAA/messages/M1', text: 'hi' }
        }
      }
    })
    const env = parseChatBody(body)
    expect(env?.type).toBe('MESSAGE')
    expect(env?.space?.name).toBe('spaces/AAAA')
  })
})
