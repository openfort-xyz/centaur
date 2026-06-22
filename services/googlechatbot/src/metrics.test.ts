import { test, expect, describe, beforeEach } from 'bun:test'
import { incr, renderMetrics, resetMetrics } from './metrics'

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
})
