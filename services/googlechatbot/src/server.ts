import { loadConfig } from './config'
import { createGooglechatbot } from './index'
import { logInfo } from './logging'

const config = loadConfig()
const { app } = createGooglechatbot(config)

logInfo('googlechatbot_starting', {
  port: config.PORT,
  centaur_api_url: config.CENTAUR_API_URL,
  events_path: config.CHAT_EVENTS_PATH,
  allowed_domains: config.GOOGLECHATBOT_ALLOWED_DOMAIN
})

export default {
  port: config.PORT,
  fetch: app.fetch,
  // A 100MB attachment arrives ~133MB as base64 inside a JSON body; Bun's default
  // 128MB request-body cap would reject valid max-size uploads before the handler
  // and its clean 413. Lift it above the inflated ceiling.
  maxRequestBodySize: 160 * 1024 * 1024
}
