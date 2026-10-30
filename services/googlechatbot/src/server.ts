import { loadConfig } from './config'
import { createGooglechatbot } from './index'
import { logInfo } from './logging'

const config = loadConfig()
const { app, stateConnected, shutdown } = createGooglechatbot(config)

// Do not bind the webhook port before durable state is available. Kubernetes
// readiness also reports state status after startup/reconnect.
await stateConnected

logInfo('googlechatbot_starting', {
  port: config.PORT,
  centaur_api_url: config.CENTAUR_API_URL,
  events_path: config.CHAT_EVENTS_PATH,
  allowed_domains: config.GOOGLECHATBOT_ALLOWED_DOMAIN,
  proactivity_enabled: config.GOOGLECHATBOT_PROACTIVITY_ENABLED,
  proactivity_spaces: config.GOOGLECHATBOT_PROACTIVITY_SPACES.length,
  ack_reaction_enabled: Boolean(config.GOOGLECHATBOT_REACTION_ACTOR_USER),
  shutdown_drain_ms: config.GOOGLECHATBOT_SHUTDOWN_DRAIN_MS
})

const server = Bun.serve({
  port: config.PORT,
  fetch: app.fetch,
  // A 100MB attachment arrives ~133MB as base64 inside a JSON body; Bun's default
  // 128MB request-body cap would reject valid max-size uploads before the handler
  // and its clean 413. Lift it above the inflated ceiling.
  maxRequestBodySize: 160 * 1024 * 1024
})

// Kubernetes removes a terminating pod from its Service while SIGTERM is
// delivered; readiness fails at once and the webhook keeps answering for a
// moment so an in-flight delivery is not lost. Then wait, bounded, for live
// turns. Linger plus drain must stay under the pod's termination grace period;
// a turn still running afterwards is recovered from its durable obligation.
const SHUTDOWN_LINGER_MS = 3_000
let shuttingDown = false
const stop = async (signal: string): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  logInfo('googlechatbot_shutdown_started', {
    signal,
    drain_ms: config.GOOGLECHATBOT_SHUTDOWN_DRAIN_MS
  })
  const draining = shutdown(config.GOOGLECHATBOT_SHUTDOWN_DRAIN_MS)
  await new Promise(resolve => setTimeout(resolve, SHUTDOWN_LINGER_MS))
  const unfinished = await draining
  // Lets requests still in progress send their responses.
  await server.stop()
  logInfo('googlechatbot_shutdown_complete', { signal, unfinished })
  process.exit(0)
}
// As PID 1 the process would otherwise ignore SIGTERM until the kubelet's SIGKILL.
process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))
