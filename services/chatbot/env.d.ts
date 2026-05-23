/// <reference types="bun" />

declare namespace NodeJS {
  interface ProcessEnv {
    PORT?: string
    NODE_ENV?: string
    GOOGLE_SERVICE_ACCOUNT_JSON?: string
    CHATBOT_API_KEY?: string
    CENTAUR_API_URL?: string
    CENTAUR_API_KEY?: string
    RUNTIME_ERROR_ALERT_SPACE?: string
    CHAT_EVENT_DEDUP_TTL_MS?: string
    CHAT_EVENT_MAX_AGE_SECONDS?: string
    CHATBOT_ALLOWED_DOMAIN?: string
    CHAT_FEEDBACK_COMMANDS?: string
    LINEAR_API_KEY?: string
    COMMIT_SHA?: string
  }
}
