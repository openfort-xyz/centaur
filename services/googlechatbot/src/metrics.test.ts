import { test, expect, describe, beforeEach } from 'bun:test'
import { addGauge, incr, renderMetrics, resetMetrics, setGauge } from './metrics'

describe('metrics', () => {
  beforeEach(() => resetMetrics())

  test('renders zero series when nothing recorded', () => {
    const out = renderMetrics()
    expect(out).toContain('# TYPE googlechatbot_events_total counter')
    expect(out).toContain('googlechatbot_events_total 0')
  })

  test('aggregates labelled counters in Prometheus format', () => {
    incr('googlechatbot_events_total', { outcome: 'accepted' })
    incr('googlechatbot_events_total', { outcome: 'accepted' })
    incr('googlechatbot_events_total', { outcome: 'duplicate' })
    const out = renderMetrics()
    expect(out).toContain('googlechatbot_events_total{outcome="accepted"} 2')
    expect(out).toContain('googlechatbot_events_total{outcome="duplicate"} 1')
  })

  test('counts unlabelled counters', () => {
    incr('googlechatbot_render_resumes_total')
    expect(renderMetrics()).toContain('googlechatbot_render_resumes_total 1')
  })

  test('registers state, SSE, and obligation gauges once and updates them', () => {
    setGauge('googlechatbot_state_connected', 1)
    addGauge('googlechatbot_open_sse_connections', 1)
    addGauge('googlechatbot_pending_render_obligations', 2)
    const output = renderMetrics()
    expect(output.match(/# TYPE googlechatbot_state_connected gauge/g)).toHaveLength(1)
    expect(output).toContain('googlechatbot_state_connected 1')
    expect(output).toContain('googlechatbot_open_sse_connections 1')
    expect(output).toContain('googlechatbot_pending_render_obligations 2')
  })

  test('records dedupe, recovery, timeout, and delivery outcomes', () => {
    incr('googlechatbot_dedupe_total', { outcome: 'duplicate' })
    incr('googlechatbot_recovery_total', { outcome: 'failed', source: 'recovery' })
    incr('googlechatbot_upstream_timeouts_total', { operation: 'create_session' })
    incr('googlechatbot_delivery_total', { outcome: 'updated', source: 'live' })
    const output = renderMetrics()
    expect(output).toContain('googlechatbot_dedupe_total{outcome="duplicate"} 1')
    expect(output).toContain(
      'googlechatbot_recovery_total{outcome="failed",source="recovery"} 1'
    )
    expect(output).toContain(
      'googlechatbot_upstream_timeouts_total{operation="create_session"} 1'
    )
    expect(output).toContain(
      'googlechatbot_delivery_total{outcome="updated",source="live"} 1'
    )
  })
})
