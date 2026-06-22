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
  fetch: app.fetch
}
