import { describe, expect, test } from 'bun:test'
import { loadConfig } from './config'

describe('googlechatbot config', () => {
  test('defaults the Chat API timeout to 30s so handoff calls stay bounded', () => {
    const config = loadConfig({})
    expect(config.GOOGLECHATBOT_CHAT_API_TIMEOUT_MS).toBe(30_000)
  })

  test('honours an explicit Chat API timeout override', () => {
    const config = loadConfig({ GOOGLECHATBOT_CHAT_API_TIMEOUT_MS: '5000' })
    expect(config.GOOGLECHATBOT_CHAT_API_TIMEOUT_MS).toBe(5_000)
  })
})
