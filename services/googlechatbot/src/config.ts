import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3002),

  // Google service account key (raw JSON, not a file path). Used for the
  // outbound Chat REST client (JWT OAuth2) and to derive the bot's own user
  // resource name so we skip its own messages.
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // Harness for new threads when no --claude/--amp/--codex flag is given
  // (HarnessType wire value: codex | amp | claudecode). Defaults to codex.
  GOOGLECHATBOT_DEFAULT_HARNESS: z.string().default('codex'),

  // api-rs (the Rust Centaur API) the bot drives sessions against.
  CENTAUR_API_URL: z.string().url().default('http://127.0.0.1:8080'),
  CENTAUR_API_KEY: z.string().optional(),
  // Preferred bearer token for api-rs; falls back to CENTAUR_API_KEY.
  GOOGLECHATBOT_API_KEY: z.string().optional(),

  CHAT_EVENTS_PATH: z.string().default('/api/chat/events'),
  CHAT_EVENT_DEDUP_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  CHAT_EVENT_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(60 * 5),

  // Comma/space-separated email-domain allowlist for inbound events. The bot is
  // OPEN to all domains until set; set it (e.g. "openfort.xyz") to fail closed.
  GOOGLECHATBOT_ALLOWED_DOMAIN: z
    .string()
    .default('')
    .transform(value =>
      value
        .split(/[\s,]+/)
        .map(part => part.trim())
        .filter(Boolean)
    ),

  // Optional per-run guards forwarded to api-rs.
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  SESSION_MAX_DURATION_MS: z.coerce.number().int().positive().optional(),

  // Optional deep-link template for the final answer's "View session" button.
  // `{thread}` and `{execution}` are substituted, e.g.
  // "https://centaur.example/sessions/{thread}". Button is omitted if unset.
  GOOGLECHATBOT_SESSION_URL_TEMPLATE: z.string().optional(),

  // Opt-in: continue a thread on a plain reply (no re-@mention), like Slack's
  // subscribed-thread mode. OFF by default — only enable when the app is
  // configured to receive all messages in the space, or it will not see replies.
  GOOGLECHATBOT_FOLLOW_UP_THREADS: z
    .string()
    .default('false')
    .transform(value => value === 'true' || value === '1')
})

export type AppConfig = z.infer<typeof EnvSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env)
}

export function centaurApiKey(config: AppConfig): string | undefined {
  return config.GOOGLECHATBOT_API_KEY || config.CENTAUR_API_KEY || undefined
}
