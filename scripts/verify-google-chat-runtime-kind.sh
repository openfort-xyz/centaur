#!/usr/bin/env bash
set -euo pipefail

context="${GOOGLE_CHAT_KIND_CONTEXT:-kind-centaur-gchat-parity}"
image="${GOOGLE_CHAT_KIND_IMAGE:-centaur-googlechatbot:parity}"
case "$context" in
  kind-*) ;;
  *)
    echo "refusing non-Kind context: $context" >&2
    exit 2
    ;;
esac

cluster="${context#kind-}"
kind get clusters | grep -Fxq "$cluster" || {
  echo "Kind cluster not found for context: $context" >&2
  exit 2
}
docker image inspect "$image" >/dev/null
kind load docker-image --name "$cluster" "$image"

namespace="centaur-gchat-runtime-${RANDOM}"
cleanup() {
  kubectl --context "$context" delete namespace "$namespace" --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

kubectl --context "$context" create namespace "$namespace"
kubectl --context "$context" -n "$namespace" create deployment parity-centaur-postgres \
  --image=postgres:16
kubectl --context "$context" -n "$namespace" set env deployment/parity-centaur-postgres \
  POSTGRES_PASSWORD=postgres
kubectl --context "$context" -n "$namespace" expose deployment parity-centaur-postgres \
  --port=5432 --target-port=5432
kubectl --context "$context" -n "$namespace" create secret generic centaur-infra-env \
  --from-literal=DATABASE_URL=postgresql://postgres:postgres@parity-centaur-postgres:5432/postgres \
  --from-literal=GOOGLE_SERVICE_ACCOUNT_JSON='{}' \
  --from-literal=GOOGLECHATBOT_INTERNAL_API_KEY=kind-test-internal-key

# Keep the recovery smoke credential-free and production-code-free. The preload
# rewrites only the fixed Google Chat origin and refuses to start if the test
# namespace is ever given a real service-account identity or key.
kubectl --context "$context" -n "$namespace" apply -f - <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: gchat-recovery-harness
data:
  preload.ts: |
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    if (raw) {
      const credential = JSON.parse(raw)
      if (credential.client_email || credential.private_key) {
        throw new Error('Kind recovery preload refuses real Google credentials')
      }
    }
    const realFetch = globalThis.fetch.bind(globalThis)
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const original = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (original.origin !== 'https://chat.googleapis.com') return realFetch(input, init)
      const rewritten = new URL(original.pathname + original.search, 'http://gchat-recovery-mock:3000')
      return realFetch(rewritten, init)
    }) as typeof fetch
  mock.ts: |
    const sentinel = 'KIND_RECOVERY_FINAL_SENTINEL'
    const messages = new Map<string, Record<string, unknown>>()
    const stats = {
      executeCalls: 0,
      streamCalls: 0,
      activeStreams: 0,
      chatCreates: 0,
      idempotentCreates: 0,
      patches: 0,
      deletes: 0,
      finished: false
    }
    const activeStreamIds = new Set<number>()
    let nextStreamId = 0
    const json = (body: unknown, status = 200) => Response.json(body, { status })
    const body = async (request: Request) => request.json().catch(() => ({})) as Record<string, unknown>
    Bun.serve({
      port: 3000,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/control/stats') {
          const visible = [...messages.values()]
          return json({
            ...stats,
            activeStreamIds: [...activeStreamIds],
            visibleMessages: visible.length,
            visibleFinal: visible.filter(message => message.text === sentinel).length,
            thinkingVisible: visible.filter(message => String(message.text ?? '').includes('thinking')).length
          })
        }
        if (url.pathname === '/control/finish' && request.method === 'POST') {
          stats.finished = true
          return json({ ok: true })
        }
        if (url.pathname.startsWith('/api/session/')) {
          if (url.pathname.endsWith('/execute') && request.method === 'POST') {
            stats.executeCalls += 1
            return json({ execution_id: 'exec-kind-recovery', status: 'queued' })
          }
          if (url.pathname.endsWith('/events') && request.method === 'GET') {
            stats.streamCalls += 1
            const streamId = ++nextStreamId
            const stream = new ReadableStream({
              async start(controller) {
                stats.activeStreams += 1
                activeStreamIds.add(streamId)
                try {
                  controller.enqueue(new TextEncoder().encode(': connected\n\n'))
                  while (!stats.finished && !request.signal.aborted) {
                    await Bun.sleep(100)
                  }
                  if (!request.signal.aborted) {
                    controller.enqueue(new TextEncoder().encode(
                      `id: 1\nevent: session.execution_completed\ndata: {"execution_id":"exec-kind-recovery","result_text":"${sentinel}"}\n\n`
                    ))
                  }
                } finally {
                  stats.activeStreams -= 1
                  activeStreamIds.delete(streamId)
                  controller.close()
                }
              }
            })
            return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
          }
          return json(url.pathname.endsWith('/messages') ? {} : { status: 'idle', harness_type: 'codex' })
        }
        if (url.pathname.startsWith('/v1/')) {
          const name = decodeURIComponent(url.pathname.slice('/v1/'.length))
          if (request.method === 'POST' && /spaces\/[^/]+\/messages$/.test(name)) {
            stats.chatCreates += 1
            if (url.searchParams.has('messageId')) stats.idempotentCreates += 1
            const messageName = url.searchParams.get('messageId')
              ? `spaces/AAAA/messages/${url.searchParams.get('messageId')}`
              : `spaces/AAAA/messages/ACK${stats.chatCreates}`
            const message = {
              ...(await body(request)),
              name: messageName,
              sender: { name: 'users/123456789', type: 'BOT' }
            }
            messages.set(messageName, message)
            return json(message)
          }
          if (request.method === 'PATCH') {
            stats.patches += 1
            const update = await body(request)
            messages.set(name, { ...(messages.get(name) ?? {}), ...update, name })
            return json(messages.get(name))
          }
          if (request.method === 'DELETE') {
            stats.deletes += 1
            messages.delete(name)
            return new Response(null, { status: 204 })
          }
          if (request.method === 'GET' && messages.has(name)) return json(messages.get(name))
          if (request.method === 'GET' && /\/messages$/.test(name)) return json({ messages: [] })
          if (request.method === 'GET' && /\/members\/app$/.test(name)) {
            return json({ member: { name: 'users/123456789', type: 'BOT' } })
          }
          return json({})
        }
        return json({ error: 'not found' }, 404)
      }
    })
EOF
kubectl --context "$context" -n "$namespace" create deployment gchat-recovery-mock \
  --image="$image"
kubectl --context "$context" -n "$namespace" patch deployment/gchat-recovery-mock \
  --type=strategic -p \
  '{"spec":{"template":{"spec":{"volumes":[{"name":"recovery-harness","configMap":{"name":"gchat-recovery-harness"}}],"containers":[{"name":"centaur-googlechatbot","command":["bun","/kind/mock.ts"],"volumeMounts":[{"name":"recovery-harness","mountPath":"/kind","readOnly":true}]}]}}}}'
kubectl --context "$context" -n "$namespace" expose deployment gchat-recovery-mock \
  --port=3000 --target-port=3000

helm template parity contrib/chart \
  --show-only templates/googlechatbot.yaml \
  --set googlechatbot.enabled=true \
  --set googlechatbot.requireSignedRequests=false \
  --set googlechatbot.replicaCount=2 \
  --set "googlechatbot.image.repository=${image%:*}" \
  --set "googlechatbot.image.tag=${image##*:}" \
  --set googlechatbot.image.pullPolicy=IfNotPresent \
  | kubectl --context "$context" -n "$namespace" apply -f -

kubectl --context "$context" -n "$namespace" set env \
  deployment/parity-centaur-googlechatbot \
  CENTAUR_API_URL=http://gchat-recovery-mock:3000 \
  GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS=1000
kubectl --context "$context" -n "$namespace" patch \
  deployment/parity-centaur-googlechatbot --type=strategic -p \
  '{"spec":{"template":{"spec":{"volumes":[{"name":"recovery-harness","configMap":{"name":"gchat-recovery-harness"}}],"containers":[{"name":"googlechatbot","command":["bun","--preload","/kind/preload.ts","src/server.ts"],"volumeMounts":[{"name":"recovery-harness","mountPath":"/kind","readOnly":true}]}]}}}}'

kubectl --context "$context" -n "$namespace" rollout status \
  deployment/parity-centaur-postgres --timeout=120s
kubectl --context "$context" -n "$namespace" rollout status \
  deployment/gchat-recovery-mock --timeout=120s
kubectl --context "$context" -n "$namespace" rollout status \
  deployment/parity-centaur-googlechatbot --timeout=180s

deployment="$(kubectl --context "$context" -n "$namespace" get deployment \
  parity-centaur-googlechatbot -o json)"
ruby -rjson -e '
  deployment = JSON.parse(STDIN.read)
  spec = deployment.fetch("spec")
  status = deployment.fetch("status")
  pod = spec.dig("template", "spec", "containers", 0)
  abort "expected two replicas" unless spec["replicas"] == 2 && status["readyReplicas"] == 2
  abort "Prometheus annotation missing" unless spec.dig("template", "metadata", "annotations", "prometheus.io/scrape") == "true"
  abort "readiness path mismatch" unless pod.dig("readinessProbe", "httpGet", "path") == "/health/ready"
  abort "liveness path mismatch" unless pod.dig("livenessProbe", "httpGet", "path") == "/health/live"
' <<<"$deployment"

# Variables in this single-quoted command intentionally expand inside the probe pod.
# shellcheck disable=SC2016
kubectl --context "$context" -n "$namespace" run gchat-probe \
  --rm -i --restart=Never --image=busybox:1.36 -- sh -c '
    assert_status() {
      expected="$1"
      shift
      wget -S -O /dev/null "$@" 2>/tmp/response || true
      grep -Eq "HTTP/[0-9.]+ ${expected} " /tmp/response
    }
    wget -qO- http://parity-centaur-googlechatbot:3002/health/live | grep -q "ok.*true"
    wget -qO- http://parity-centaur-googlechatbot:3002/health/ready | grep -q "database_connected.*true"
    wget -qO- http://parity-centaur-googlechatbot:3002/metrics | grep -q "googlechatbot_state_connected 1"
    assert_status 401 http://parity-centaur-googlechatbot:3002/api/chat/spaces
    assert_status 401 --header "Authorization: Bearer wrong-key" \
      http://parity-centaur-googlechatbot:3002/api/chat/spaces
    assert_status 400 --header "Authorization: Bearer kind-test-internal-key" \
      --post-data "" \
      "http://parity-centaur-googlechatbot:3002/api/chat/dms/setup?target_identity=%20"
  '

mock_stats() {
  kubectl --context "$context" -n "$namespace" exec "$(mock_pod)" -- \
    bun -e "fetch('http://127.0.0.1:3000/control/stats').then(r => r.text()).then(console.log)"
}

mock_pod() {
  kubectl --context "$context" -n "$namespace" get pods \
    -l app=gchat-recovery-mock --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}'
}

postgres_value() {
  kubectl --context "$context" -n "$namespace" exec deployment/parity-centaur-postgres -- \
    psql -U postgres -Atc "$1"
}

# Address one replica directly so the exact process owning the live lease is
# known before it is hard-killed. The shared mock preserves Chat/session state.
processing_pod="$(kubectl --context "$context" -n "$namespace" get pods \
  -l app.kubernetes.io/component=googlechatbot \
  -o jsonpath='{.items[0].metadata.name}')"
event_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
kubectl --context "$context" -n "$namespace" exec "$processing_pod" -- \
  env EVENT_TIME="$event_time" bun -e '
    const event = {
      type: "MESSAGE",
      eventTime: process.env.EVENT_TIME,
      space: { name: "spaces/AAAA", spaceType: "DIRECT_MESSAGE", singleUserBotDm: true },
      message: {
        name: "spaces/AAAA/messages/KIND1",
        text: "/centaur return the Kind recovery sentinel",
        argumentText: "return the Kind recovery sentinel",
        slashCommand: { commandId: "1" },
        sender: { name: "users/U1", displayName: "Kind User" }
      },
      user: { name: "users/U1", displayName: "Kind User" }
    }
    const response = await fetch("http://127.0.0.1:3002/api/chat/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    })
    if (response.status !== 200 || await response.text() !== "{}") process.exit(1)
  '

render_deadline=$((SECONDS + 60))
while :; do
  stats="$(mock_stats)"
  rendering="$(postgres_value \
    "SELECT count(*) FROM chat_state_cache WHERE key_prefix = 'centaur-googlechatbot' AND cache_key LIKE 'googlechatbot:work:%' AND cache_key NOT LIKE 'googlechatbot:work:lease:%' AND value::jsonb->>'stage' = 'rendering'")"
  if ruby -rjson -e 's=JSON.parse(STDIN.read); exit(s["executeCalls"] == 1 && s["streamCalls"] >= 1 ? 0 : 1)' <<<"$stats" \
    && test "$rendering" = "1"; then
    processing_stream_id="$(ruby -rjson -e '
      ids = JSON.parse(STDIN.read).fetch("activeStreamIds")
      abort "expected exactly one processing stream" unless ids.length == 1
      puts ids.first
    ' <<<"$stats")"
    break
  fi
  test "$SECONDS" -lt "$render_deadline" || {
    echo "turn did not reach durable rendering: stats=$stats rendering=$rendering" >&2
    exit 1
  }
  sleep 1
done

lease_expiry="$(postgres_value \
  "SELECT floor(extract(epoch FROM max(expires_at)))::bigint FROM chat_state_cache WHERE key_prefix = 'centaur-googlechatbot' AND cache_key LIKE 'googlechatbot:work:lease:%'")"
test -n "$lease_expiry"
kubectl --context "$context" -n "$namespace" delete pod "$processing_pod" \
  --grace-period=0 --force --wait=false
# `--force --wait=false` removes the API object before the container necessarily
# stops. Do not release the mock result until the replacement is ready AND the
# original SSE socket has closed, or the dying process can finalize the work.
kubectl --context "$context" -n "$namespace" wait --for=delete \
  "pod/$processing_pod" --timeout=30s
kubectl --context "$context" -n "$namespace" rollout status \
  deployment/parity-centaur-googlechatbot --timeout=120s
disconnect_deadline=$((SECONDS + 30))
while :; do
  stats="$(mock_stats)"
  if ruby -rjson -e '
      original = Integer(ARGV.fetch(0))
      active = JSON.parse(STDIN.read).fetch("activeStreamIds")
      exit(active.include?(original) ? 1 : 0)
    ' "$processing_stream_id" <<<"$stats"; then
    break
  fi
  test "$SECONDS" -lt "$disconnect_deadline" || {
    echo "deleted processing pod retained its SSE connection: stats=$stats" >&2
    exit 1
  }
  sleep 1
done
kubectl --context "$context" -n "$namespace" exec "$(mock_pod)" -- \
  bun -e "fetch('http://127.0.0.1:3000/control/finish',{method:'POST'}).then(r => { if (!r.ok) process.exit(1) })"

recovery_deadline=$((lease_expiry + 90))
while :; do
  stats="$(mock_stats)"
  obligations="$(postgres_value \
    "SELECT count(*) FROM chat_state_cache WHERE key_prefix = 'centaur-googlechatbot' AND cache_key LIKE 'googlechatbot:work:%' AND cache_key NOT LIKE 'googlechatbot:work:lease:%'")"
  ready="$(kubectl --context "$context" -n "$namespace" get deployment \
    parity-centaur-googlechatbot -o jsonpath='{.status.readyReplicas}')"
  if ruby -rjson -e '
      s=JSON.parse(STDIN.read)
      # This credential-free harness cannot prove app ownership, so recovery
      # must use the production fallback: create one stable final, then delete
      # the original status. Live app-auth tests cover the PATCH path.
      ok=s["executeCalls"] == 1 && s["streamCalls"] >= 2 && s["chatCreates"] == 2 &&
        s["idempotentCreates"] == 2 && s["patches"] == 0 && s["deletes"] == 1 &&
        s["visibleMessages"] == 1 && s["visibleFinal"] == 1 && s["thinkingVisible"] == 0
      exit(ok ? 0 : 1)
    ' <<<"$stats" && test "$obligations" = "0" && test "$ready" = "2"; then
    break
  fi
  test "$(date +%s)" -lt "$recovery_deadline" || {
    echo "active-turn recovery did not converge: stats=$stats obligations=$obligations ready=$ready" >&2
    exit 1
  }
  sleep 2
done

recovery_metrics=""
for recovered_pod in $(kubectl --context "$context" -n "$namespace" get pods \
  -l app.kubernetes.io/component=googlechatbot -o jsonpath='{.items[*].metadata.name}'); do
  recovery_metrics+="$(kubectl --context "$context" -n "$namespace" exec "$recovered_pod" -- \
    bun -e "fetch('http://127.0.0.1:3002/metrics').then(r => r.text()).then(console.log)")"
done
grep -q 'googlechatbot_recovery_total{outcome="completed",source="recovery"}' \
  <<<"$recovery_metrics"

pod="$(kubectl --context "$context" -n "$namespace" get pods \
  -l app.kubernetes.io/component=googlechatbot -o jsonpath='{.items[0].metadata.name}')"
kubectl --context "$context" -n "$namespace" delete pod "$pod" --wait=false
kubectl --context "$context" -n "$namespace" rollout status \
  deployment/parity-centaur-googlechatbot --timeout=120s

ready="$(kubectl --context "$context" -n "$namespace" get deployment \
  parity-centaur-googlechatbot -o jsonpath='{.status.readyReplicas}')"
test "$ready" = "2"

echo "verified live Kind runtime: auth/probes, exact active-turn recovery, one final, obligation cleanup, two replicas, pod replacement"
