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
  {
    name: 'googlechatbot_session_api_operations_total',
    help: 'api-rs session API calls by operation and outcome.'
  },
  {
    // Shared with slackbotv2 so cross-bot delivery dashboards aggregate both.
    name: 'centaur_session_delivery_total',
    help: 'User-visible delivery outcome of an agent run.'
  }
]

const values = new Map<string, number>()

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
  for (const counter of COUNTERS) {
    lines.push(`# HELP ${counter.name} ${counter.help}`)
    lines.push(`# TYPE ${counter.name} counter`)
    const prefix = counter.name
    let emitted = false
    for (const [k, v] of values) {
      if (k === prefix || k.startsWith(`${prefix}{`)) {
        lines.push(`${k} ${v}`)
        emitted = true
      }
    }
    if (!emitted) lines.push(`${prefix} 0`)
  }
  return lines.join('\n') + '\n'
}

/** Test-only reset. */
export function resetMetrics(): void {
  values.clear()
}
