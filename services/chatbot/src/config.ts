import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3002),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  CHATBOT_API_KEY: z.string().optional(),
  CENTAUR_API_URL: z.string().url().default('http://localhost:8000'),
  CENTAUR_API_KEY: z.string().optional(),
  CHAT_EVENTS_PATH: z.string().default('/api/chat/events'),
  RUNTIME_ERROR_ALERT_SPACE: z.string().default(''),
  CHAT_EVENT_DEDUP_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  CHAT_EVENT_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(60 * 5),
  CHATBOT_ALLOWED_DOMAIN: z
    .string()
    .default('')
    .transform(value =>
      value
        .split(/[\s,]+/)
        .map(part => part.trim())
        .filter(Boolean)
    ),
  CHAT_FEEDBACK_COMMANDS: z
    .string()
    .default('')
    .transform(value =>
      value
        .split(/[\s,]+/)
        .map(part => part.trim())
        .filter(Boolean)
    ),
  CHAT_FEEDBACK_LINEAR_TEAM_ID: z.string().default(''),
  CHAT_FEEDBACK_LINEAR_PROJECT_ID: z.string().default(''),
  CHAT_FEEDBACK_ALLOWED_SPACES: z
    .string()
    .default('')
    .transform(value =>
      value
        .split(/[\s,]+/)
        .map(part => part.trim())
        .filter(Boolean)
    ),
  LINEAR_API_KEY: z.string().optional()
})

export type AppConfig = z.infer<typeof EnvSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env)
}

export function centaurApiKey(config: AppConfig): string | undefined {
  return config.CHATBOT_API_KEY || config.CENTAUR_API_KEY || undefined
}
