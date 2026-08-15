import { describe, expect, test } from 'bun:test'
import { loadConfig } from './config'

describe('googlechatbot config', () => {
  test('requires signed requests by default with a five-minute token age limit', () => {
    const config = loadConfig({})
    expect(config.GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS).toBe(true)
    expect(config.GOOGLECHATBOT_SIGNED_REQUEST_MAX_AGE_SECONDS).toBe(300)
    expect(config.GOOGLECHATBOT_INGRESS_MODE).toBe('chat_api_project')
  })

  test('accepts first-class Workspace Add-on authentication settings', () => {
    const config = loadConfig({
      GOOGLECHATBOT_INGRESS_MODE: 'workspace_addon',
      GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL: 'addon@example.iam.gserviceaccount.com',
      GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID: '123.apps.googleusercontent.com'
    })
    expect(config.GOOGLECHATBOT_INGRESS_MODE).toBe('workspace_addon')
    expect(config.GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL).toContain('addon@')
    expect(config.GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID).toBe('123.apps.googleusercontent.com')
  })

  test('allows an explicit local-development signature opt-out', () => {
    expect(loadConfig({ GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'false' })
      .GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS).toBe(false)
  })

  test('rejects a typo instead of silently disabling request signatures', () => {
    expect(() => loadConfig({ GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: 'tru' })).toThrow()
  })

  test('defaults the Chat API timeout to 30s so handoff calls stay bounded', () => {
    const config = loadConfig({})
    expect(config.GOOGLECHATBOT_CHAT_API_TIMEOUT_MS).toBe(30_000)
  })

  test('honours an explicit Chat API timeout override', () => {
    const config = loadConfig({ GOOGLECHATBOT_CHAT_API_TIMEOUT_MS: '5000' })
    expect(config.GOOGLECHATBOT_CHAT_API_TIMEOUT_MS).toBe(5_000)
  })

  test('uses 30s control and 10s stream-connect session deadlines', () => {
    const config = loadConfig({})
    expect(config.GOOGLECHATBOT_SESSION_API_TIMEOUT_MS).toBe(30_000)
    expect(config.GOOGLECHATBOT_SESSION_STREAM_CONNECT_TIMEOUT_MS).toBe(10_000)
  })

  test('bounds thread history and aggregate inbound attachments', () => {
    const defaults = loadConfig({})
    expect(defaults.GOOGLECHATBOT_THREAD_HISTORY_LIMIT).toBe(50)
    expect(defaults.GOOGLECHATBOT_ATTACHMENT_AGGREGATE_MAX_BYTES).toBe(100 * 1024 * 1024)
  })

  test('defaults response metadata to the first response without service tier', () => {
    const config = loadConfig({})
    expect(config.GOOGLECHATBOT_RESPONSE_METADATA_MODE).toBe('first')
    expect(config.GOOGLECHATBOT_RESPONSE_SERVICE_TIER_ENABLED).toBe(false)
  })

  test('accepts response metadata controls', () => {
    const config = loadConfig({
      GOOGLECHATBOT_RESPONSE_METADATA_MODE: 'always',
      GOOGLECHATBOT_RESPONSE_SERVICE_TIER_ENABLED: 'true'
    })
    expect(config.GOOGLECHATBOT_RESPONSE_METADATA_MODE).toBe('always')
    expect(config.GOOGLECHATBOT_RESPONSE_SERVICE_TIER_ENABLED).toBe(true)
  })

  test('keeps delegated subjects separate and empty by default', () => {
    const defaults = loadConfig({})
    expect(defaults.GOOGLECHATBOT_UPLOAD_USER).toBe('')
    expect(defaults.GOOGLECHATBOT_REACTION_READ_USER).toBe('')
    expect(defaults.GOOGLECHATBOT_DRIVE_DOWNLOAD_USER).toBe('')
    const configured = loadConfig({
      GOOGLECHATBOT_UPLOAD_USER: 'upload@example.com',
      GOOGLECHATBOT_REACTION_READ_USER: 'reactions@example.com',
      GOOGLECHATBOT_DRIVE_DOWNLOAD_USER: 'drive@example.com'
    })
    expect(configured.GOOGLECHATBOT_REACTION_READ_USER).toBe('reactions@example.com')
    expect(configured.GOOGLECHATBOT_DRIVE_DOWNLOAD_USER).toBe('drive@example.com')
  })
})
