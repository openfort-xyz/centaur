import { z } from 'zod'
import { STOP_CARD_FUNCTION } from './constants'
import { isHarnessEnabled, parseEnabledHarnesses } from './harness-routing'

const strictBoolean = z
  .enum(['true', 'false', '1', '0'])
  .default('true')
  .transform(value => value === 'true' || value === '1')

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3002),

  // Google service account key (raw JSON, not a file path). Used for the
  // outbound Chat REST client (JWT OAuth2) and to derive the bot's own user
  // resource name so we skip its own messages.
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // Harness for new threads when no explicit harness flag is given.
  // (HarnessType wire value: codex | amp | claudecode | nanocodex | hermes).
  CENTAUR_PI_MODEL: z.string().optional(),
  CENTAUR_OMP_MODEL: z.string().optional(),
  GOOGLECHATBOT_ENABLED_HARNESSES: z.string().optional().transform(parseEnabledHarnesses),
  GOOGLECHATBOT_DEFAULT_HARNESS: z.string().default('codex'),

  // api-rs (the Rust Centaur API) the bot drives sessions against.
  CENTAUR_API_URL: z.string().url().default('http://127.0.0.1:8080'),
  CENTAUR_API_KEY: z.string().optional(),
  // Preferred bearer token for api-rs; falls back to CENTAUR_API_KEY.
  GOOGLECHATBOT_API_KEY: z.string().optional(),

  // Durable webhook/dedupe/render state. The database URL follows the same
  // precedence as slackbotv2 so both bots can share the deployment Postgres.
  GOOGLECHATBOT_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  POSTGRES_URL: z.string().optional(),
  GOOGLECHATBOT_STATE_KEY_PREFIX: z.string().default('centaur-googlechatbot'),
  GOOGLECHATBOT_STATE_CONNECT_INITIAL_DELAY_MS: z.coerce.number().int().positive().default(250),
  GOOGLECHATBOT_STATE_CONNECT_MAX_DELAY_MS: z.coerce.number().int().positive().default(10_000),
  GOOGLECHATBOT_STATE_POOL_MAX: z.coerce.number().int().positive().default(10),
  GOOGLECHATBOT_STATE_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  GOOGLECHATBOT_STATE_POOL_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  GOOGLECHATBOT_RECOVERY_MAX_OBLIGATION_AGE_MS: z.coerce.number().int().positive().default(86_400_000),
  GOOGLECHATBOT_RECOVERY_FAILURE_BUDGET: z.coerce.number().int().positive().default(5),
  GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  // Shared only with api-rs. Agent tools never receive this credential: they
  // authenticate to api-rs, which authorizes an exact Google Chat resource and
  // operation before calling the internal /api/chat/* routes.
  GOOGLECHATBOT_INTERNAL_API_KEY: z.string().optional(),

  // Workspace user the service account impersonates for attachment uploads.
  // Google Chat's media.upload rejects app auth (chat.bot) — the official path
  // for a headless app is domain-wide delegation: an admin grants the SA's
  // client ID the chat.messages.create scope, and uploads run as this user.
  // Unset makes the space-scoped attachment upload route return 503.
  GOOGLECHATBOT_UPLOAD_USER: z.string().default(''),
  // Separate least-privilege DWD subjects. DM setup impersonates its validated
  // target directly; fixed subjects remain only for these shared capabilities.
  GOOGLECHATBOT_REACTION_READ_USER: z.string().default(''),
  GOOGLECHATBOT_DRIVE_DOWNLOAD_USER: z.string().default(''),
  // Workspace user the Admin SDK directory lookup runs as (scope
  // admin.directory.user.readonly, so this user needs the privilege to read
  // users). It turns a Google-signed Add-on event's sender `users/<id>` into
  // their primary email, which is the sender identity: Chat never sends the
  // Add-on `userIdToken` for a standalone HTTP Chat app. Unset leaves every
  // event anonymous — and so does a subject who is not an admin, which reads
  // as "only that one user is ever identified".
  GOOGLECHATBOT_DIRECTORY_LOOKUP_USER: z.string().default(''),

  CHAT_EVENTS_PATH: z.string().default('/api/chat/events'),
  CHAT_EVENT_DEDUP_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  CHAT_EVENT_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(60 * 5),

  // Bound Google API and token-exchange calls. Failed acknowledgement writes
  // remain work obligations; history failures can fall back to no context.
  GOOGLECHATBOT_CHAT_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // Comma/space-separated email-domain allowlist for verified inbound identity.
  // The bot is OPEN to all domains until set. Legacy Chat events have no signed
  // user email and therefore fail closed when this allowlist is configured.
  GOOGLECHATBOT_ALLOWED_DOMAIN: z
    .string()
    .default('')
    .transform(value =>
      value
        .split(/[\s,]+/)
        .map(part => part.trim())
        .filter(Boolean)
    ),

  // Verify the bearer using the selected ingress mode's issuer and audience.
  // Disable only for local fixtures. Production rollback must disable ingress.
  GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS: strictBoolean,

  // Inbound authentication contracts are not interchangeable. Keep the
  // issuer, audience, key set, and signer identity paired to the configured
  // Google surface. The project-number Chat API model remains the default for
  // existing deployments.
  GOOGLECHATBOT_INGRESS_MODE: z
    .enum(['chat_api_project', 'chat_api_url', 'workspace_addon'])
    .default('chat_api_project'),

  // Reject validly signed replay tokens minted more than this many seconds ago.
  GOOGLECHATBOT_SIGNED_REQUEST_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),

  // Exact audience for the selected ingress mode.
  GOOGLECHATBOT_PROJECT_NUMBER: z.string().optional(),
  GOOGLECHATBOT_WEBHOOK_AUDIENCE: z.string().optional(),
  // Workspace Add-ons use the deployment's per-project service account, not
  // chat@system.gserviceaccount.com.
  GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  // Audience used to verify authorizationEventObject.userIdToken when an
  // Add-on supplies one. The verified email, never the token, becomes identity.
  GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID: z.string().optional(),

  // Overrides for the execution and idle limits defined in session-api.ts.
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  SESSION_MAX_DURATION_MS: z.coerce.number().int().positive().optional(),
  GOOGLECHATBOT_SESSION_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  GOOGLECHATBOT_SESSION_STREAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Append model, harness, and reasoning metadata to the first response,
  // every response, or no responses.
  GOOGLECHATBOT_RESPONSE_METADATA_MODE: z.enum(['first', 'always', 'never']).default('first'),
  // Include the baked Codex service tier when response metadata is rendered.
  GOOGLECHATBOT_RESPONSE_SERVICE_TIER_ENABLED: z
    .string()
    .default('false')
    .transform(value => value === 'true' || value === '1'),

  // Deployment defaults for the harness models (mirrored from sandbox.extraEnv
  // by the chart, same as slackbotv2) so the response footer names the model
  // sandboxes actually run instead of the repo-baked default.
  CLAUDE_MODEL: z.string().optional(),
  CODEX_MODEL: z.string().optional(),
  // Deployment default effort for the Codex-family harnesses (Nanocodex shares
  // Codex's policy), so the response footer names the effort that actually runs.
  CODEX_MODEL_REASONING_EFFORT: z.string().optional(),

  // Opt-in: continue a thread on a plain reply (no re-@mention), like Slack's
  // subscribed-thread mode. OFF by default — only enable when the app is
  // configured to receive all messages in the space, or it will not see replies.
  GOOGLECHATBOT_FOLLOW_UP_THREADS: z
    .string()
    .default('false')
    .transform(value => value === 'true' || value === '1'),
  GOOGLECHATBOT_THREAD_HISTORY_LIMIT: z.coerce.number().int().positive().max(1000).default(50),
  GOOGLECHATBOT_ATTACHMENT_AGGREGATE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),

  // How inline harness/model/provider/reasoning overrides are resolved from a
  // message: "flags" (default) parses literal --flags; "llm" additionally asks
  // the OpenAI Decisions API (gpt-6-luna) to interpret natural-language
  // requests ("use max effort and the sol model"), matching slackbotv2's
  // SLACKBOTV2_MESSAGE_OVERRIDES_STRATEGY.
  GOOGLECHATBOT_MESSAGE_OVERRIDES_STRATEGY: z
    .enum(['flags', 'llm'])
    .default('flags'),
  // Required for the "llm" strategy; the strategy no-ops (no overrides) when
  // unset. Wired by the chart from the same secret key slackbotv2 reads.
  OPENAI_API_KEY: z.string().optional(),
  GOOGLECHATBOT_MESSAGE_OVERRIDES_OPENAI_BASE_URL: z.string().optional(),
  GOOGLECHATBOT_MESSAGE_OVERRIDES_MODEL: z.string().default('gpt-6-luna'),
  GOOGLECHATBOT_MESSAGE_OVERRIDES_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

  // Contextual replies: a mention makes its thread eligible until a stop; later
  // unmentioned messages in the exact listed spaces are classified and answered
  // when the classifier says the bot should respond. Off by default, and never
  // for every space: the space list is required when enabled. Unmentioned
  // messages are collected by a bounded poller over spaces.messages.list, so
  // the Chat app does not need the "receive all messages" configuration.
  GOOGLECHATBOT_PROACTIVITY_ENABLED: z
    .string()
    .default('false')
    .transform(value => value === 'true' || value === '1'),
  GOOGLECHATBOT_PROACTIVITY_CLASSIFIER: z.enum(['openai']).default('openai'),
  GOOGLECHATBOT_PROACTIVITY_MODEL: z.string().default('gpt-6-luna'),
  GOOGLECHATBOT_PROACTIVITY_OPENAI_API_KEY: z.string().optional(),
  GOOGLECHATBOT_PROACTIVITY_OPENAI_BASE_URL: z.string().optional(),
  GOOGLECHATBOT_PROACTIVITY_SPACES: z.string().default('').transform(parseSpaceList),
  GOOGLECHATBOT_PROACTIVITY_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  GOOGLECHATBOT_PROACTIVITY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),

  // Optional reaction on the message that starts a turn, removed when the
  // answer is posted. Google's reactions.create/delete reject app auth, so the
  // reaction is authored by this delegated Workspace user (DWD scope
  // chat.messages.reactions), never by the Chat app. Empty keeps the thinking
  // acknowledgement as the only turn-start signal.
  GOOGLECHATBOT_REACTION_ACTOR_USER: z.string().default(''),
  GOOGLECHATBOT_ACK_REACTION: z.string().default('👀'),

  // SIGTERM waits this long for in-flight turns before exiting; a turn still
  // running is recovered by the next process from its durable obligation.
  GOOGLECHATBOT_SHUTDOWN_DRAIN_MS: z.coerce.number().int().positive().default(20_000),

  // Per-space default harness/model/provider/reasoning, JSON keyed by Google
  // Chat space id. Mirrors slackbotv2's SLACKBOTV2_CHANNEL_DEFAULTS. See
  // space-defaults.ts for the shape and precedence (per-thread flag, then
  // space default, then GOOGLECHATBOT_DEFAULT_HARNESS).
  GOOGLECHATBOT_SPACE_DEFAULTS: z.string().optional()
})

export type AppConfig = z.infer<typeof EnvSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = EnvSchema.parse(env)
  if (!isHarnessEnabled(config.GOOGLECHATBOT_DEFAULT_HARNESS, config.GOOGLECHATBOT_ENABLED_HARNESSES)) {
    throw new Error('GOOGLECHATBOT_DEFAULT_HARNESS must be enabled in GOOGLECHATBOT_ENABLED_HARNESSES')
  }
  if (config.GOOGLECHATBOT_INGRESS_MODE === 'workspace_addon' && !addonCallbackUrl(config)) {
    throw new Error(
      'GOOGLECHATBOT_WEBHOOK_AUDIENCE must be the Add-on endpoint as an absolute https URL in '
      + 'workspace_addon mode; Add-on card callbacks are addressed to it'
    )
  }
  if (config.GOOGLECHATBOT_PROACTIVITY_ENABLED) {
    if (config.GOOGLECHATBOT_PROACTIVITY_SPACES.length === 0) {
      throw new Error(
        'GOOGLECHATBOT_PROACTIVITY_SPACES must list the exact spaces/<id> names when proactivity is enabled'
      )
    }
    if (!proactivityApiKey(config)) {
      throw new Error(
        'GOOGLECHATBOT_PROACTIVITY_OPENAI_API_KEY or OPENAI_API_KEY is required for the openai proactivity classifier'
      )
    }
  }
  return config
}

/** Comma/space-separated `spaces/<id>` names; bare ids are normalized. */
function parseSpaceList(value: string): string[] {
  const spaces = value
    .split(/[\s,]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => (part.startsWith('spaces/') ? part : `spaces/${part}`))
  if (spaces.some(space => !/^spaces\/[A-Za-z0-9._-]{1,256}$/.test(space))) {
    throw new Error('GOOGLECHATBOT_PROACTIVITY_SPACES must contain spaces/<id> resource names')
  }
  return [...new Set(spaces)]
}

export function proactivityApiKey(config: AppConfig): string | undefined {
  return config.GOOGLECHATBOT_PROACTIVITY_OPENAI_API_KEY || config.OPENAI_API_KEY || undefined
}

export function centaurApiKey(config: AppConfig): string | undefined {
  return config.GOOGLECHATBOT_API_KEY || config.CENTAUR_API_KEY || undefined
}

function addonCallbackUrl(config: AppConfig): string | undefined {
  const raw = config.GOOGLECHATBOT_WEBHOOK_AUDIENCE?.trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.hostname ? raw : undefined
  } catch {
    return undefined
  }
}

/**
 * The Stop button's callback for this deployment's ingress contract. Chat API
 * apps (project-number and URL modes) use the bare function name; a Workspace
 * Add-on must address its own HTTP endpoint and carry the name as the
 * `actionName` parameter, otherwise Google never delivers the click.
 */
export function stopCardAction(config: AppConfig): {
  function: string
  parameters?: Array<{ key: string; value: string }>
} {
  if (config.GOOGLECHATBOT_INGRESS_MODE !== 'workspace_addon') return { function: STOP_CARD_FUNCTION }
  const url = addonCallbackUrl(config)
  if (!url) throw new Error('workspace_addon Stop card requires a validated GOOGLECHATBOT_WEBHOOK_AUDIENCE')
  return { function: url, parameters: [{ key: 'actionName', value: STOP_CARD_FUNCTION }] }
}
