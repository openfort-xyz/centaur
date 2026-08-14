// Lightweight, dependency-free counters exposed at /metrics in Prometheus text
// format. Mirrors the observability slackbotv2 gets from its metrics module, so
// Google Chat runs are no longer a blind spot (webhook outcomes, run results,
// and stream resumes).

type Labels = Record<string, string>

type CounterSpec = {
  name: string
  help: string
}

const COUNTERS: CounterSpec[] = [
  { name: 'googlechatbot_events_total', help: 'Inbound Chat events by outcome.' },
  { name: 'googlechatbot_runs_total', help: 'Agent runs by outcome.' },
  { name: 'googlechatbot_render_resumes_total', help: 'Resumed SSE render passes after a stream drop.' },
  { name: 'googlechatbot_stop_commands_total', help: 'Stop-command mentions by outcome.' },
  {
    name: 'googlechatbot_session_identity_total',
    help: 'Session-metadata identity claims by outcome and suppression reason.'
  },
  {
    name: 'googlechatbot_session_api_operations_total',
    help: 'api-rs session API calls by operation and outcome.'
  },
  {
    // Shared with slackbotv2 so cross-bot delivery dashboards aggregate both.
    name: 'centaur_session_delivery_total',
    help: 'User-visible delivery outcome of an agent run.'
  },
  { name: 'googlechatbot_dedupe_total', help: 'Durable event dedupe outcomes.' },
  { name: 'googlechatbot_recovery_total', help: 'Durable work recovery outcomes.' },
  { name: 'googlechatbot_upstream_timeouts_total', help: 'Upstream timeouts by operation.' },
  { name: 'googlechatbot_delivery_total', help: 'Google Chat delivery attempts by outcome.' }
]

const GAUGES: CounterSpec[] = [
  { name: 'googlechatbot_state_connected', help: 'Whether durable state is connected.' },
  { name: 'googlechatbot_open_sse_connections', help: 'Open api-rs SSE connections.' },
  { name: 'googlechatbot_pending_render_obligations', help: 'Pending durable render obligations.' }
]

const values = new Map<string, number>()

export function setGauge(name: string, value: number, labels: Labels = {}): void {
  values.set(key(name, labels), value)
}

export function addGauge(name: string, by: number, labels: Labels = {}): void {
  const k = key(name, labels)
  values.set(k, Math.max(0, (values.get(k) ?? 0) + by))
}

function renderMetric(lines: string[], metric: CounterSpec, type: 'counter' | 'gauge'): void {
  lines.push(`# HELP ${metric.name} ${metric.help}`)
  lines.push(`# TYPE ${metric.name} ${type}`)
  let emitted = false
  for (const [k, v] of values) {
    if (k === metric.name || k.startsWith(`${metric.name}{`)) {
      lines.push(`${k} ${v}`)
      emitted = true
    }
  }
  if (!emitted) lines.push(`${metric.name} 0`)
}

function key(name: string, labels: Labels): string {
  const label = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(',')
  return label ? `${name}{${label}}` : name
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

export function incr(name: string, labels: Labels = {}, by = 1): void {
  const k = key(name, labels)
  values.set(k, (values.get(k) ?? 0) + by)
}

/** Render the current counters in Prometheus exposition format. */
export function renderMetrics(): string {
  const lines: string[] = []
  for (const counter of COUNTERS) renderMetric(lines, counter, 'counter')
  for (const gauge of GAUGES) renderMetric(lines, gauge, 'gauge')
  return lines.join('\n') + '\n'
}

/** Test-only reset. */
export function resetMetrics(): void {
  values.clear()
}
