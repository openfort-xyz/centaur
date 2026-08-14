#!/usr/bin/env bash
set -euo pipefail

readonly CONTROL_NAMESPACE=centaur
readonly CONTROL_RELEASE=centaur
readonly CONTROL_SHA=bb37a15396bcc2e823b95ea26c523be993bf167d
readonly REQUIRED_CANARY=centaur-gchat-parity-canary
readonly REPO_CACHE_PATH=/var/lib/centaur/repos-gchat-parity-canary

usage() {
  cat <<'EOF'
Usage:
  scripts/verify-google-chat-vps-canary.sh verify COMMON_ARGS --values FILE
  scripts/verify-google-chat-vps-canary.sh guard COMMON_ARGS [--guard-seconds N]
  scripts/verify-google-chat-vps-canary.sh cleanup COMMON_ARGS --cleanup-candidate

COMMON_ARGS (all required):
  --kubeconfig /home/jaume/.kube/config
  --context CONTEXT
  --namespace centaur-gchat-parity-canary
  --release centaur-gchat-parity-canary
  --candidate-sha 40_HEX_COMMIT
  --digest googlechatbot=REGISTRY/IMAGE:sha-COMMIT@sha256:64_HEX
  --digest api-rs=REGISTRY/IMAGE:sha-COMMIT@sha256:64_HEX
  --digest console=REGISTRY/IMAGE:sha-COMMIT@sha256:64_HEX
  --digest agent=REGISTRY/IMAGE:sha-COMMIT@sha256:64_HEX
  --digest iron-proxy=REGISTRY/IMAGE:sha-COMMIT@sha256:64_HEX
  --output-dir DIRECTORY

The script never reads Secrets, logs, events, or message payloads. It never
mutates the production namespace or release. Cleanup removes only the exact
candidate release and namespace and requires --cleanup-candidate.
EOF
}

die() { echo "ERROR: $*" >&2; exit 2; }
note() { echo "$*" >&2; }
require_command() { command -v "$1" >/dev/null || die "missing command: $1"; }

action="${1:-}"
[[ -n "$action" ]] || { usage; exit 2; }
[[ "$action" != -h && "$action" != --help ]] || { usage; exit 0; }
shift

kubeconfig=""
context=""
namespace=""
release=""
candidate_sha=""
output_dir=""
values_file=""
guard_seconds=86400
cleanup_candidate=false
runtime_tmp=""
digest_googlechatbot=""
digest_api_rs=""
digest_console=""
digest_agent=""
digest_iron_proxy=""

digest_for() {
  case "$1" in
    googlechatbot) echo "$digest_googlechatbot" ;;
    api-rs) echo "$digest_api_rs" ;;
    console) echo "$digest_console" ;;
    agent) echo "$digest_agent" ;;
    iron-proxy) echo "$digest_iron_proxy" ;;
    *) die "unknown digest component: $1" ;;
  esac
}

while (($#)); do
  case "$1" in
    --kubeconfig|--context|--namespace|--release|--candidate-sha|--output-dir|--values|--guard-seconds|--digest)
      (($# >= 2)) || die "$1 requires a value"
      key="$1" value="$2"; shift 2
      case "$key" in
        --kubeconfig) kubeconfig="$value" ;;
        --context) context="$value" ;;
        --namespace) namespace="$value" ;;
        --release) release="$value" ;;
        --candidate-sha) candidate_sha="$value" ;;
        --output-dir) output_dir="$value" ;;
        --values) values_file="$value" ;;
        --guard-seconds) guard_seconds="$value" ;;
        --digest)
          [[ "$value" == *=* ]] || die "--digest must be component=image@sha256:digest"
          component="${value%%=*}"; image="${value#*=}"
          [[ -z "$(digest_for "$component")" ]] || die "duplicate digest component: $component"
          case "$component" in
            googlechatbot) digest_googlechatbot="$image" ;;
            api-rs) digest_api_rs="$image" ;;
            console) digest_console="$image" ;;
            agent) digest_agent="$image" ;;
            iron-proxy) digest_iron_proxy="$image" ;;
          esac
          ;;
      esac
      ;;
    --cleanup-candidate) cleanup_candidate=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

validate_inputs() {
  require_command kubectl
  require_command helm
  require_command jq
  require_command ruby
  require_command sha256sum

  [[ "$(id -un)" == jaume ]] || die "run on centaur-vps as jaume"
  [[ -n "$kubeconfig" && -f "$kubeconfig" ]] || die "explicit readable --kubeconfig is required"
  [[ "$kubeconfig" == "$HOME/.kube/config" ]] || die "kubeconfig must be jaume's \$HOME/.kube/config"
  [[ -n "$context" ]] || die "explicit --context is required"
  [[ "$namespace" == "$REQUIRED_CANARY" && "$namespace" != "$CONTROL_NAMESPACE" ]] ||
    die "namespace must be $REQUIRED_CANARY (never $CONTROL_NAMESPACE)"
  [[ "$release" == "$REQUIRED_CANARY" && "$release" != "$CONTROL_RELEASE" ]] ||
    die "release must be $REQUIRED_CANARY (never $CONTROL_RELEASE)"
  [[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] || die "candidate SHA must be 40 lowercase hex characters"
  [[ "$candidate_sha" != "$CONTROL_SHA" ]] || die "candidate SHA must differ from the control SHA"
  [[ -n "$output_dir" ]] || die "explicit --output-dir is required"
  if ! [[ "$guard_seconds" =~ ^[0-9]+$ ]] || ((guard_seconds == 0 || guard_seconds > 86400)); then
    die "guard duration must be 1..86400 seconds"
  fi

  local component image
  for component in googlechatbot api-rs console agent iron-proxy; do
    image="$(digest_for "$component")"
    [[ "$image" =~ :sha-${candidate_sha}@sha256:[0-9a-f]{64}$ ]] ||
      die "missing/invalid $component digest; require an immutable sha-$candidate_sha tag and sha256 digest"
  done

  mkdir -p "$output_dir"
  output_dir="$(cd "$output_dir" && pwd -P)"
  [[ "$output_dir" != / && "$output_dir" != "$HOME" ]] || die "unsafe output directory"
  runtime_tmp="$(mktemp -d)"

  K=(kubectl --kubeconfig "$kubeconfig" --context "$context")
  H=(helm --kubeconfig "$kubeconfig" --kube-context "$context")
  "${K[@]}" config get-contexts "$context" -o name | grep -Fxq "$context" || die "context not found"
}

workloads_json() {
  local ns="$1"
  "${K[@]}" -n "$ns" get deployment,statefulset,daemonset -o json
}

pods_json() {
  local ns="$1"
  "${K[@]}" -n "$ns" get pods -o json
}

sanitized_snapshot() {
  local ns="$1" out="$2" workloads pods routes claims
  workloads="$runtime_tmp/workloads.json"; pods="$runtime_tmp/pods.json"
  routes="$runtime_tmp/routes.json"; claims="$runtime_tmp/claims.json"
  workloads_json "$ns" >"$workloads"
  pods_json "$ns" >"$pods"
  "${K[@]}" -n "$ns" get service,ingress,networkpolicy -o json >"$routes"
  "${K[@]}" -n "$ns" get pvc -o json >"$claims"
  jq -n --arg namespace "$ns" --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --slurpfile workloads "$workloads" --slurpfile pods "$pods" \
    --slurpfile routes "$routes" --slurpfile claims "$claims" '
    def containers: ((.spec.template.spec.initContainers // []) + (.spec.template.spec.containers // []));
    {
      namespace: $namespace,
      captured_at: $captured_at,
      workloads: [$workloads[0].items[] | {
        kind, name: .metadata.name, generation: .metadata.generation,
        component: .metadata.labels["app.kubernetes.io/component"],
        instance: .metadata.labels["app.kubernetes.io/instance"],
        desired: (.spec.replicas // .status.desiredNumberScheduled // 0),
        ready: (.status.readyReplicas // .status.numberReady // 0),
        available: (.status.availableReplicas // .status.numberAvailable // 0),
        selector: .spec.selector,
        metrics: {
          scrape: .spec.template.metadata.annotations["prometheus.io/scrape"],
          path: .spec.template.metadata.annotations["prometheus.io/path"],
          port: .spec.template.metadata.annotations["prometheus.io/port"]
        },
        containers: [containers | .[] | {
          name, image,
          readiness_path: .readinessProbe.httpGet.path,
          liveness_path: .livenessProbe.httpGet.path
        }],
        secret_refs: ([containers | .[] |
          ((.env // [])[]?.valueFrom.secretKeyRef.name),
          ((.envFrom // [])[]?.secretRef.name)] +
          [(.spec.template.spec.volumes // [])[]?.secret.secretName] |
          map(select(. != null)) | unique),
        host_paths: [(.spec.template.spec.volumes // [])[]?.hostPath.path] | map(select(. != null)),
        pvc_claims: [(.spec.template.spec.volumes // [])[]?.persistentVolumeClaim.claimName] | map(select(. != null))
      }],
      pods: [$pods[0].items[] | {
        name: .metadata.name,
        component: .metadata.labels["app.kubernetes.io/component"],
        start_time: .status.startTime,
        phase: .status.phase,
        containers: [(.status.initContainerStatuses // [])[]?, (.status.containerStatuses // [])[]? | {
          name, image, image_id: .imageID, ready, restart_count: .restartCount
        }]
      }],
      image_counts: ([$pods[0].items[] |
        (.status.initContainerStatuses // [])[], (.status.containerStatuses // [])[] |
        {image, image_id: .imageID}] | sort_by(.image, .image_id) | group_by([.image, .image_id]) |
        map({image: .[0].image, image_id: .[0].image_id, count: length})),
      routes: [$routes[0].items[] | {
        kind, name: .metadata.name,
        selector: .spec.selector,
        ingress_hosts: [.spec.rules[]?.host] | map(select(. != null)),
        ingress_backends: [.spec.rules[]?.http.paths[]?.backend.service.name] | map(select(. != null))
      }],
      claims: [$claims[0].items[] | {
        name: .metadata.name, phase: .status.phase,
        storage_class: .spec.storageClassName, access_modes: .spec.accessModes
      }]
    }' >"$out"
  sha256sum "$out" >"$out.sha256"
}

release_snapshot() {
  local ns="$1" name="$2" out="$3"
  "${H[@]}" status "$name" -n "$ns" -o json |
    jq '{name, namespace, revision: .version, status: .info.status, last_deployed: .info.last_deployed}' >"$out"
  sha256sum "$out" >"$out.sha256"
}

assert_control() {
  local json="$1" component
  for component in googlechatbot api-rs console; do
    jq -e --arg c "$component" --arg sha "$CONTROL_SHA" '
      [.workloads[] | select(.component == $c and .desired > 0 and .ready == .desired and
        any(.containers[]; .image | contains("sha-" + $sha)))] | length > 0
    ' "$json" >/dev/null || die "control $component is not Ready on sha-$CONTROL_SHA"
  done
  jq -e --arg sha "$CONTROL_SHA" '
    any(.pods[]; any(.containers[]; .name == "iron-proxy" and (.image | contains("sha-" + $sha))))
  ' "$json" >/dev/null || die "control iron-proxy pod is not on sha-$CONTROL_SHA"
  jq -e 'all(.pods[].containers[]; (.image_id // "") | contains("@sha256:"))' "$json" >/dev/null ||
    die "control has a running container without an immutable image ID"
}

validate_render() {
  [[ -n "$values_file" && -f "$values_file" ]] || die "verify requires --values FILE"
  local rendered
  rendered="$runtime_tmp/rendered.yaml"
  "${H[@]}" template "$release" contrib/chart --namespace "$namespace" -f "$values_file" >"$rendered"

  grep -Eq 'CANDIDATE_|latest(["[:space:]]|$)' "$rendered" &&
    die "render contains an unresolved placeholder or mutable latest tag"
  grep -Eq '(^|[[:space:]])namespace:[[:space:]]*centaur[[:space:]]*$|/var/lib/centaur/repos(["[:space:]]|$)' "$rendered" &&
    die "render references the production namespace or repository cache"
  grep -Fq "$REPO_CACHE_PATH" "$rendered" || die "candidate repository cache mount path missing"

  local component image
  for component in googlechatbot api-rs console; do
    image="$(digest_for "$component")"
    jq -Rse --arg image "$image" 'contains($image)' <"$rendered" >/dev/null ||
      die "render does not contain pinned $component image"
  done
  jq -Rse --arg image "$digest_agent" 'contains($image)' <"$rendered" >/dev/null ||
    die "render does not pin the candidate agent image"
  jq -Rse --arg image "$digest_iron_proxy" 'contains($image)' <"$rendered" >/dev/null ||
    die "render does not pin the candidate iron-proxy image"

  ruby -ryaml -e '
    docs = YAML.load_stream(File.read(ARGV.fetch(0))).compact
    prefix, repo_path = ARGV.fetch(1), ARGV.fetch(2)
    abort "rendered a Secret" if docs.any? { |d| d["kind"] == "Secret" }
    docs.each do |doc|
      name = doc.dig("metadata", "name").to_s
      abort "non-canary resource name: #{doc["kind"]}/#{name}" unless name.empty? || name.start_with?(prefix)
    end
    bot = docs.find { |d| d["kind"] == "Deployment" && d.dig("metadata", "labels", "app.kubernetes.io/component") == "googlechatbot" } or abort "bot missing"
    abort "bot replica count is not two" unless bot.dig("spec", "replicas") == 2
    paths = docs.flat_map { |d| d.dig("spec", "template", "spec", "volumes") || [] }.filter_map { |v| v.dig("hostPath", "path") }
    abort "canary must not use node hostPath storage" unless paths.empty?
    mounts = docs.flat_map { |d| d.dig("spec", "template", "spec", "containers") || [] }
      .flat_map { |c| c["volumeMounts"] || [] }.filter_map { |v| v["mountPath"] }
    abort "candidate repo mount path mismatch" unless mounts.include?(repo_path)
    claims = docs.select { |d| d["kind"] == "PersistentVolumeClaim" }
    abort "candidate repo and Postgres PVCs required" unless claims.length >= 2
    abort "candidate PVC must use local-path" unless claims.all? { |p| p.dig("spec", "storageClassName") == "local-path" }
    ingresses = docs.select { |d| d["kind"] == "Ingress" }
    abort "centaur-vps canary must not render Kubernetes Ingress" unless ingresses.empty?
  ' "$rendered" "$REQUIRED_CANARY" "$REPO_CACHE_PATH"
}

assert_candidate() {
  local json="$1" live="$2" component image expected
  jq -e --arg release "$release" --arg prefix "$REQUIRED_CANARY" '
    all(.workloads[]; .instance == $release and (.name | startswith($prefix))) and
    all(.routes[]; (.name | startswith($prefix))) and
    all(.claims[]; (.name | contains($prefix))) and
    all(.workloads[]; .desired == .ready)
  ' "$json" >/dev/null || die "candidate naming, ownership, or readiness assertion failed"

  jq -e --arg prefix "$REQUIRED_CANARY" '
    all(.workloads[].host_paths[]?; . != "/var/lib/centaur/repos") and
    any(.workloads[].pvc_claims[]?; contains($prefix)) and
    all(.workloads[].secret_refs[]?; startswith("centaur-gchat-parity-canary"))
  ' "$json" >/dev/null || die "candidate PVC or Secret isolation assertion failed"

  jq -e '
    [.workloads[] | select(.component == "googlechatbot" and .desired == 2 and .ready == 2 and
      .metrics.scrape == "true" and .metrics.path == "/metrics" and
      any(.containers[]; .readiness_path == "/health/ready" and .liveness_path == "/health/live"))] | length == 1
  ' "$json" >/dev/null || die "candidate bot replicas, probes, or metrics annotations are invalid"

  for component in googlechatbot api-rs console; do
    image="$(digest_for "$component")"
    expected="${image##*@}"
    jq -e --arg c "$component" --arg spec "$image" --arg digest "$expected" '
      any(.workloads[]; .component == $c and any(.containers[]; .image == $spec)) and
      any(.pods[]; .component == $c and any(.containers[]; (.image_id // "") | endswith("@" + $digest)))
    ' "$json" >/dev/null || die "candidate $component spec/runtime digest mismatch"
  done

  image="$(jq -r '.items[] | select(.metadata.labels["app.kubernetes.io/component"] == "api-rs") |
    .spec.template.spec.containers[] | select(.name == "api-rs") | .env[] |
    select(.name == "SESSION_SANDBOX_IMAGE") | .value' <<<"$live")"
  [[ "$image" == "$digest_agent" ]] || die "api-rs does not pin the candidate agent image"
  image="$(jq -r '.items[] | select(.metadata.labels["app.kubernetes.io/component"] == "api-rs") |
    .spec.template.spec.containers[] | select(.name == "api-rs") | .env[] |
    select(.name == "KUBERNETES_IRON_PROXY_IMAGE") | .value' <<<"$live")"
  [[ "$image" == "$digest_iron_proxy" ]] || die "api-rs does not pin the candidate iron-proxy image"
}

assert_no_cross_namespace_collision() {
  "${K[@]}" get deployment,statefulset,daemonset,service,ingress --all-namespaces \
    -l "app.kubernetes.io/instance=$release" -o json |
    jq -e --arg ns "$namespace" 'all(.items[]; .metadata.namespace == $ns)' >/dev/null ||
    die "candidate release label exists outside candidate namespace"

  local candidate_workloads service
  candidate_workloads="$(workloads_json "$namespace")"
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    if jq -r '.. | strings' <<<"$candidate_workloads" | grep -Fq "http://$service:"; then
      die "candidate workload references production service: $service"
    fi
  done < <("${K[@]}" -n "$CONTROL_NAMESPACE" get service -o json | jq -r '.items[].metadata.name')
}

probe_candidate() {
  local pods pod base health ready metrics
  pods="$("${K[@]}" -n "$namespace" get pods -l app.kubernetes.io/component=googlechatbot -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')"
  [[ "$(grep -c . <<<"$pods")" == 2 ]] || die "expected exactly two candidate bot pods"
  while IFS= read -r pod; do
    [[ -n "$pod" ]] || continue
    base="/api/v1/namespaces/$namespace/pods/$pod:3002/proxy"
    health="$("${K[@]}" get --raw "$base/health/live")"
    ready="$("${K[@]}" get --raw "$base/health/ready")"
    metrics="$("${K[@]}" get --raw "$base/metrics")"
    jq -e '.ok == true' <<<"$health" >/dev/null || die "$pod liveness failed"
    jq -e '.ok == true and .database_connected == true' <<<"$ready" >/dev/null || die "$pod readiness/state failed"
    grep -Eq '^googlechatbot_state_connected(\{[^}]*\})?[[:space:]]+1([.]0+)?$' <<<"$metrics" ||
      die "$pod durable state metric is not connected"
  done <<<"$pods"
}

production_counts() {
  local workload pods restarts desired ready pod base metrics bad=0
  workload="$(workloads_json "$CONTROL_NAMESPACE")"
  desired="$(jq '[.items[] | select(.metadata.labels["app.kubernetes.io/component"] == "googlechatbot") | .spec.replicas] | add // 0' <<<"$workload")"
  ready="$(jq '[.items[] | select(.metadata.labels["app.kubernetes.io/component"] == "googlechatbot") | .status.readyReplicas // 0] | add // 0' <<<"$workload")"
  pods="$(pods_json "$CONTROL_NAMESPACE")"
  restarts="$(jq '[.items[] | (.status.initContainerStatuses // [])[], (.status.containerStatuses // [])[] | .restartCount] | add // 0' <<<"$pods")"
  while IFS= read -r pod; do
    [[ -n "$pod" ]] || continue
    base="/api/v1/namespaces/$CONTROL_NAMESPACE/pods/$pod:3002/proxy/metrics"
    metrics="$("${K[@]}" get --raw "$base")" || die "cannot read production bot metrics"
    bad=$((bad + $(awk '
      /^googlechatbot_events_total\{.*outcome="rejected"/ ||
      /^googlechatbot_runs_total\{.*outcome="failed"/ ||
      /^googlechatbot_delivery_total\{.*outcome="(failed|error_[^"]+)"/ { sum += $NF }
      END { printf "%d", sum + 0 }
    ' <<<"$metrics")))
  done < <(jq -r '.items[] | select(.metadata.labels["app.kubernetes.io/component"] == "googlechatbot") | .metadata.name' <<<"$pods")
  jq -cn --argjson desired "$desired" --argjson ready "$ready" --argjson restarts "$restarts" --argjson failures "$bad" \
    '{desired:$desired,ready:$ready,restarts:$restarts,failures:$failures}'
}

verify_action() {
  validate_render
  "${H[@]}" status "$CONTROL_RELEASE" -n "$CONTROL_NAMESPACE" >/dev/null || die "control Helm release missing"
  "${H[@]}" status "$release" -n "$namespace" >/dev/null || die "candidate Helm release missing"
  release_snapshot "$CONTROL_NAMESPACE" "$CONTROL_RELEASE" "$output_dir/control-release.json"
  release_snapshot "$namespace" "$release" "$output_dir/candidate-release.json"
  sanitized_snapshot "$CONTROL_NAMESPACE" "$output_dir/control.json"
  sanitized_snapshot "$namespace" "$output_dir/candidate.json"
  assert_control "$output_dir/control.json"
  assert_no_cross_namespace_collision
  local live
  live="$(workloads_json "$namespace")"
  assert_candidate "$output_dir/candidate.json" "$live"
  probe_candidate
  jq -cn --arg status pass --arg sha "$candidate_sha" --arg control_sha "$CONTROL_SHA" \
    --arg googlechatbot "$digest_googlechatbot" --arg api_rs "$digest_api_rs" \
    --arg console "$digest_console" --arg agent "$digest_agent" \
    --arg iron_proxy "$digest_iron_proxy" \
    --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{test:"TEST-001/012/013",status:$status,candidate_sha:$sha,control_sha:$control_sha,
      digests:{googlechatbot:$googlechatbot,"api-rs":$api_rs,console:$console,agent:$agent,"iron-proxy":$iron_proxy},
      completed_at:$completed_at}' \
    >"$output_dir/verify-result.json"
  sha256sum "$output_dir/verify-result.json" >"$output_dir/verify-result.json.sha256"
  note "PASS: sanitized control/candidate snapshots and isolation/readiness checks"
}

guard_action() {
  local baseline sample started deadline unready_since=0 now
  baseline="$(production_counts)"
  started="$(date +%s)"; deadline=$((started + guard_seconds))
  jq -cn --arg type metadata --arg candidate_sha "$candidate_sha" \
    --arg googlechatbot "$digest_googlechatbot" --arg api_rs "$digest_api_rs" \
    --arg console "$digest_console" --arg agent "$digest_agent" \
    --arg iron_proxy "$digest_iron_proxy" \
    '{type:$type,candidate_sha:$candidate_sha,
      digests:{googlechatbot:$googlechatbot,"api-rs":$api_rs,console:$console,agent:$agent,"iron-proxy":$iron_proxy}}' \
    >"$output_dir/production-guard.jsonl"
  while (( $(date +%s) < deadline )); do
    now="$(date +%s)"
    sample="$(production_counts)"
    jq -cn --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson counts "$sample" \
      '{at:$at} + $counts' >>"$output_dir/production-guard.jsonl"
    if [[ "$(jq -r '.ready == .desired' <<<"$sample")" == true ]]; then
      unready_since=0
    else
      ((unready_since == 0)) && unready_since=$now
      ((now - unready_since <= 60)) || die "production readiness loss exceeded 60 seconds"
    fi
    (( $(jq -r '.restarts' <<<"$sample") <= $(jq -r '.restarts' <<<"$baseline") )) ||
      die "production restart count increased"
    (( $(jq -r '.failures' <<<"$sample") <= $(jq -r '.failures' <<<"$baseline") )) ||
      die "production Google Chat rejection/failure counters increased"
    sleep 15
  done
  sha256sum "$output_dir/production-guard.jsonl" >"$output_dir/production-guard.jsonl.sha256"
  note "PASS: production guard stayed within thresholds for $guard_seconds seconds"
}

cleanup_action() {
  [[ "$cleanup_candidate" == true ]] || die "cleanup requires explicit --cleanup-candidate"
  "${H[@]}" status "$CONTROL_RELEASE" -n "$CONTROL_NAMESPACE" >/dev/null || die "control release check failed; refusing cleanup"
  "${H[@]}" status "$release" -n "$namespace" >/dev/null || die "candidate release not found"
  sanitized_snapshot "$CONTROL_NAMESPACE" "$output_dir/control-before-cleanup.json"
  "${H[@]}" uninstall "$release" -n "$namespace" --wait
  "${K[@]}" delete namespace "$namespace" --wait=true
  sanitized_snapshot "$CONTROL_NAMESPACE" "$output_dir/control-after-cleanup.json"
  jq 'del(.captured_at)' "$output_dir/control-before-cleanup.json" >"$output_dir/.before.json"
  jq 'del(.captured_at)' "$output_dir/control-after-cleanup.json" >"$output_dir/.after.json"
  cmp -s "$output_dir/.before.json" "$output_dir/.after.json" || die "protected production snapshot changed during cleanup"
  rm -f "$output_dir/.before.json" "$output_dir/.after.json"
  jq -cn --arg status pass --arg candidate_sha "$candidate_sha" \
    --arg googlechatbot "$digest_googlechatbot" --arg api_rs "$digest_api_rs" \
    --arg console "$digest_console" --arg agent "$digest_agent" --arg iron_proxy "$digest_iron_proxy" \
    --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{test:"TEST-030",status:$status,candidate_sha:$candidate_sha,
      digests:{googlechatbot:$googlechatbot,"api-rs":$api_rs,console:$console,agent:$agent,"iron-proxy":$iron_proxy},
      completed_at:$completed_at}' \
    >"$output_dir/cleanup-result.json"
  sha256sum "$output_dir/cleanup-result.json" >"$output_dir/cleanup-result.json.sha256"
  note "PASS: candidate release, namespace, and host cache removed; production snapshot unchanged"
}

cleanup_runtime() {
  [[ -n "$runtime_tmp" && -d "$runtime_tmp" ]] || return
  rm -rf -- "$runtime_tmp"
}

validate_inputs
trap cleanup_runtime EXIT
case "$action" in
  verify) verify_action ;;
  guard) guard_action ;;
  cleanup) cleanup_action ;;
  *) usage; die "action must be verify, guard, or cleanup" ;;
esac
