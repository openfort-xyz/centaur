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

  // Bearer token the `google-chat` workflow tool presents to the outbound
  // /api/chat/messages routes (send/list/update/delete a Chat message on behalf
  // of a scheduled digest workflow). The tool reads the same value from its own
  // CHATBOT_API_KEY secret. When unset, those routes fail closed (503).
  CHATBOT_API_KEY: z.string().optional(),

  // Workspace user the service account impersonates for attachment uploads.
  // Google Chat's media.upload rejects app auth (chat.bot) — the official path
  // for a headless app is domain-wide delegation: an admin grants the SA's
  // client ID the chat.messages.create scope, and uploads run as this user.
  // Unset = the /api/chat/attachments route fails closed (503).
  GOOGLECHATBOT_UPLOAD_USER: z.string().default(''),

  CHAT_EVENTS_PATH: z.string().default('/api/chat/events'),
  CHAT_EVENT_DEDUP_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  CHAT_EVENT_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(60 * 5),

  // Hard ceiling on every outbound Google Chat REST call (OAuth token exchange,
  // message create/patch/list, attachment upload). A hung Chat backend on the
  // ack or thread-history fetch must never stall the handoff to api-rs — these
  // calls are best-effort and bounded, mirroring slackbotv2's slackApiTimeoutMs.
  GOOGLECHATBOT_CHAT_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // Comma/space-separated email-domain allowlist for inbound events. The bot is
  // OPEN to all domains until set; set it (e.g. "openfort.xyz") to fail closed.
  // NOTE: this is a coarse filter on the (attacker-controllable) event body, not
  // an authentication control — enable GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS for
  // that.
  GOOGLECHATBOT_ALLOWED_DOMAIN: z
    .string()
    .default('')
    .transform(value =>
      value
        .split(/[\s,]+/)
        .map(part => part.trim())
        .filter(Boolean)
    ),

  // Authenticate inbound webhook requests by verifying Google Chat's signed
  // bearer JWT (issuer chat@system.gserviceaccount.com). OFF by default so the
  // rollout can gate the code independently of the edge; flip to `true`/`1` to
  // fail closed. Requires at least one audience below or every request 401s.
  GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: z
    .string()
    .default('false')
    .transform(value => value === 'true' || value === '1'),

  // Accepted `aud` claim(s) for the signed request token. Google Chat mints the
  // token with either the app's Cloud project number or the endpoint URL as the
  // audience depending on the app config; set whichever the app uses (both may
  // be set — a token matching either is accepted).
  GOOGLECHATBOT_PROJECT_NUMBER: z.string().optional(),
  GOOGLECHATBOT_WEBHOOK_AUDIENCE: z.string().optional(),

  // Optional per-run guards forwarded to api-rs.
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  SESSION_MAX_DURATION_MS: z.coerce.number().int().positive().optional(),

  // Optional deep-link template for the final answer's "View session" button.
  // `{thread}` and `{execution}` are substituted, e.g.
  // "https://centaur.example/sessions/{thread}". Button is omitted if unset.
  GOOGLECHATBOT_SESSION_URL_TEMPLATE: z.string().optional(),

  // Public origin of the Console UI (same env name the Console and slackbotv2
  // use). When set, the first assistant message in a Chat thread carries an
  // "Open chat in Console · MODEL · Harness" line linking to the Console
  // thread view. Unset = no line (matches slackbotv2).
  CENTAUR_CONSOLE_PUBLIC_URL: z.string().optional(),

  // Deployment defaults for the harness models (mirrored from sandbox.extraEnv
  // by the chart, same as slackbotv2) so the Console-link line names the model
  // sandboxes actually run instead of the repo-baked default.
  CLAUDE_MODEL: z.string().optional(),
  CODEX_MODEL: z.string().optional(),

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
