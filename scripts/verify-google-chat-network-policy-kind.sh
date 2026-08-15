#!/usr/bin/env bash
set -euo pipefail

context="${GOOGLE_CHAT_KIND_CONTEXT:-kind-centaur-gchat-parity}"
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
kubectl config get-contexts "$context" >/dev/null

namespace="centaur-gchat-network-${RANDOM}"
rendered="$(mktemp)"
cleanup() {
  kubectl --context "$context" delete namespace "$namespace" --wait=false >/dev/null 2>&1 || true
  rm -f "$rendered"
}
trap cleanup EXIT

helm template parity contrib/chart \
  --set googlechatbot.enabled=true \
  --set googlechatbot.requireSignedRequests=false \
  --set networkPolicy.enabled=true \
  | ruby -ryaml -e '
      policy = YAML.load_stream(STDIN.read).compact.find do |doc|
        doc["kind"] == "NetworkPolicy" &&
          doc.dig("spec", "podSelector", "matchLabels", "app.kubernetes.io/component") == "googlechatbot"
      end or abort "googlechatbot NetworkPolicy not rendered"
      puts YAML.dump(policy)
    ' >"$rendered"

kubectl --context "$context" create namespace "$namespace"
kubectl --context "$context" -n "$namespace" run googlechatbot \
  --image=registry.k8s.io/e2e-test-images/agnhost:2.53 \
  --restart=Never \
  --labels=app.kubernetes.io/name=centaur,app.kubernetes.io/instance=parity,app.kubernetes.io/component=googlechatbot \
  -- netexec --http-port=3002
kubectl --context "$context" -n "$namespace" expose pod googlechatbot \
  --name=googlechatbot --port=3002 --target-port=3002

for component in api-rs sandbox workflow-run; do
  kubectl --context "$context" -n "$namespace" run "$component" \
    --image=busybox:1.36 \
    --restart=Never \
    --labels="app.kubernetes.io/name=centaur,app.kubernetes.io/instance=parity,app.kubernetes.io/component=$component" \
    -- sleep 3600
done

kubectl --context "$context" -n "$namespace" wait --for=condition=Ready \
  pod/googlechatbot pod/api-rs pod/sandbox pod/workflow-run --timeout=120s

for source in api-rs sandbox workflow-run; do
  kubectl --context "$context" -n "$namespace" exec "$source" -- \
    wget -qO- -T 5 http://googlechatbot:3002/hostname >/dev/null
done

kubectl --context "$context" -n "$namespace" apply -f "$rendered"
sleep 2

kubectl --context "$context" -n "$namespace" exec api-rs -- \
  wget -qO- -T 5 http://googlechatbot:3002/hostname >/dev/null

for source in sandbox workflow-run; do
  if kubectl --context "$context" -n "$namespace" exec "$source" -- \
    wget -qO- -T 3 http://googlechatbot:3002/hostname >/dev/null 2>&1; then
    echo "$source unexpectedly reached googlechatbot" >&2
    exit 1
  fi
done

echo "verified live Kind policy: api-rs allowed; sandbox and workflow-run denied"
