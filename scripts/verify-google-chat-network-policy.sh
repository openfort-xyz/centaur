#!/usr/bin/env bash
set -euo pipefail

rendered="$(mktemp)"
missing="$(mktemp)"
project="$(mktemp)"
webhook="$(mktemp)"
addon="$(mktemp)"
rules="$(mktemp)"
trap 'rm -f "$rendered" "$missing" "$project" "$webhook" "$addon" "$rules"' EXIT

if helm template parity contrib/chart \
  --set googlechatbot.enabled=true >"$missing" 2>&1; then
  echo "googlechatbot rendered with signed requests but no audience" >&2
  exit 1
fi
grep -Fq 'googlechatbot chat_api_project ingress requires googlechatbot.projectNumber' "$missing"

helm template parity contrib/chart \
  --set googlechatbot.enabled=true \
  --set-string googlechatbot.projectNumber=734836800829 >"$project"

helm template parity contrib/chart \
  --set googlechatbot.enabled=true \
  --set googlechatbot.ingressMode=chat_api_url \
  --set-string googlechatbot.webhookAudience=https://chat.example.test/api/chat/events >"$webhook"

helm template parity contrib/chart \
  --set googlechatbot.enabled=true \
  --set googlechatbot.ingressMode=workspace_addon \
  --set-string googlechatbot.webhookAudience=https://addon.example.test/api/chat/events \
  --set-string googlechatbot.addonServiceAccountEmail=addon@example.iam.gserviceaccount.com \
  --set-string googlechatbot.addonOauthClientId=123.apps.googleusercontent.com >"$addon"

ruby -ryaml -e '
  def env(path)
    docs = YAML.load_stream(File.read(path)).compact
    deployment = docs.find do |doc|
      doc["kind"] == "Deployment" &&
        doc.dig("spec", "template", "metadata", "labels", "app.kubernetes.io/component") == "googlechatbot"
    end or abort "googlechatbot Deployment not rendered"
    deployment.dig("spec", "template", "spec", "containers", 0, "env")
      .to_h { |entry| [entry.fetch("name"), entry["value"]] }
  end

  project = env(ARGV.fetch(0))
  abort "project-number audience not rendered" unless project["GOOGLECHATBOT_PROJECT_NUMBER"] == "734836800829"
  abort "unexpected webhook audience in project model" if project.key?("GOOGLECHATBOT_WEBHOOK_AUDIENCE")
  abort "signed requests not enabled for project model" unless project["GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS"] == "true"
  abort "project mode not rendered" unless project["GOOGLECHATBOT_INGRESS_MODE"] == "chat_api_project"
  abort "empty domain allowlist not rendered explicitly" unless project["GOOGLECHATBOT_ALLOWED_DOMAIN"] == ""

  webhook = env(ARGV.fetch(1))
  expected = "https://chat.example.test/api/chat/events"
  abort "webhook audience not rendered" unless webhook["GOOGLECHATBOT_WEBHOOK_AUDIENCE"] == expected
  abort "unexpected project audience in webhook model" if webhook.key?("GOOGLECHATBOT_PROJECT_NUMBER")
  abort "signed requests not enabled for webhook model" unless webhook["GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS"] == "true"
  abort "URL mode not rendered" unless webhook["GOOGLECHATBOT_INGRESS_MODE"] == "chat_api_url"

  addon = env(ARGV.fetch(2))
  abort "Add-on mode not rendered" unless addon["GOOGLECHATBOT_INGRESS_MODE"] == "workspace_addon"
  abort "Add-on audience not rendered" unless addon["GOOGLECHATBOT_WEBHOOK_AUDIENCE"] == "https://addon.example.test/api/chat/events"
  abort "Add-on signer not rendered" unless addon["GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL"] == "addon@example.iam.gserviceaccount.com"
  abort "Add-on OAuth client not rendered" unless addon["GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID"] == "123.apps.googleusercontent.com"

  puts "verified paired project, URL, and Workspace Add-on ingress modes"
' "$project" "$webhook" "$addon"

helm template parity contrib/chart \
  --set googlechatbot.enabled=true \
  --set googlechatbot.requireSignedRequests=false >"$rendered"

ruby -ryaml -e '
  docs = YAML.load_stream(File.read(ARGV.fetch(0))).compact
  policy = docs.find do |doc|
    doc["kind"] == "NetworkPolicy" &&
      doc.dig("spec", "podSelector", "matchLabels", "app.kubernetes.io/component") == "googlechatbot"
  end or abort "googlechatbot NetworkPolicy not rendered"
  ingress = policy.dig("spec", "ingress") || []
  selectors = ingress.flat_map { |rule| rule.fetch("from", []) }
    .filter_map { |source| source.dig("podSelector", "matchLabels") }
  abort "api-rs ingress selector missing" unless selectors.any? {
    |labels| labels["app.kubernetes.io/component"] == "api-rs"
  }
  forbidden = selectors.any? do |labels|
    labels.key?("centaur.ai/api-server-enabled") ||
      %w[sandbox workflow-run].include?(labels["app.kubernetes.io/component"])
  end
  abort "sandbox or workflow ingress selector admitted" if forbidden
  egress = policy.dig("spec", "egress") || []
  abort "postgres egress selector missing" unless egress.any? do |rule|
    rule.fetch("to", []).any? { |target|
      target.dig("podSelector", "matchLabels", "app.kubernetes.io/component") == "postgres"
    } && rule.fetch("ports", []).any? { |port| port["protocol"] == "TCP" && port["port"] == 5432 }
  end
  postgres = docs.find do |doc|
    doc["kind"] == "NetworkPolicy" &&
      doc.dig("spec", "podSelector", "matchLabels", "app.kubernetes.io/component") == "postgres"
  end or abort "postgres NetworkPolicy not rendered"
  postgres_sources = postgres.dig("spec", "ingress").to_a.flat_map { |rule| rule.fetch("from", []) }
  abort "googlechatbot postgres ingress selector missing" unless postgres_sources.any? do |source|
    source.dig("podSelector", "matchLabels", "app.kubernetes.io/component") == "googlechatbot"
  end
  deployment = docs.find do |doc|
    doc["kind"] == "Deployment" &&
      doc.dig("spec", "template", "metadata", "labels", "app.kubernetes.io/component") == "googlechatbot"
  end or abort "googlechatbot Deployment not rendered"
  env = deployment.dig("spec", "template", "spec", "containers", 0, "env")
    .to_h { |entry| [entry.fetch("name"), entry["value"]] }
  abort "explicit signed-request opt-out not rendered" unless env["GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS"] == "false"
  puts "verified googlechatbot ingress isolation and bidirectional postgres policy"
' "$rendered"

# The Google Chat state pool must also reach a managed core database.
helm template parity contrib/chart \
  --set googlechatbot.enabled=true \
  --set googlechatbot.requireSignedRequests=false \
  --set postgres.enabled=false \
  --set 'externalDatabase.cidrs[0]=192.0.2.10/32' \
  --set externalDatabase.port=5544 >"$rendered"
ruby -ryaml -e '
  docs = YAML.load_stream(File.read(ARGV.fetch(0))).compact
  policy = docs.find { |doc| doc["kind"] == "NetworkPolicy" &&
    doc.dig("spec", "podSelector", "matchLabels", "app.kubernetes.io/component") == "googlechatbot" }
  abort "managed database egress missing" unless policy.dig("spec", "egress").any? { |rule|
    rule.fetch("to", []).any? { |target| target.dig("ipBlock", "cidr") == "192.0.2.10/32" } &&
    rule.fetch("ports", []).any? { |port| port["protocol"] == "TCP" && port["port"] == 5544 }
  }
  deployment = docs.find { |doc| doc["kind"] == "Deployment" &&
    doc.dig("spec", "template", "metadata", "labels", "app.kubernetes.io/component") == "googlechatbot" }
  env = deployment.dig("spec", "template", "spec", "containers", 0, "env")
  abort "removed Console UI link still configured" if env.any? { |entry| entry["name"] == "CENTAUR_CONSOLE_PUBLIC_URL" }
  puts "verified Google Chat managed database egress and removed Console link"
' "$rendered"

# Operator proactivity rules render as one ConfigMap file per space, mounted
# where the bot reads them; a list that repeats a rule name fails the render.
cat >"$rules" <<'YAML'
googlechatbot:
  enabled: true
  requireSignedRequests: false
  proactivity:
    enabled: true
    spaces: [spaces/AAAAalerts]
    defaultRules:
      - name: question
        when: A direct question about a service we own.
    spaceRules:
      AAAAalerts:
        - name: alert
          when: A monitoring alert that is firing.
          context: Check the dashboards first.
      AAAAsocial: []
YAML
helm template parity contrib/chart -f "$rules" >"$rendered"
ruby -ryaml -rjson -e '
  docs = YAML.load_stream(File.read(ARGV.fetch(0))).compact
  config_map = docs.find { |doc| doc["kind"] == "ConfigMap" && doc.dig("metadata", "name").end_with?("googlechatbot-proactivity-rules") } \
    or abort "googlechatbot proactivity rules ConfigMap not rendered"
  data = config_map.fetch("data")
  abort "default rules not rendered" unless JSON.parse(data.fetch("default.json")) == [{ "name" => "question", "when" => "A direct question about a service we own." }]
  abort "space rules not rendered" unless JSON.parse(data.fetch("AAAAalerts.json")).first["context"] == "Check the dashboards first."
  abort "empty space list not rendered" unless JSON.parse(data.fetch("AAAAsocial.json")) == []
  deployment = docs.find { |doc| doc["kind"] == "Deployment" &&
    doc.dig("spec", "template", "metadata", "labels", "app.kubernetes.io/component") == "googlechatbot" }
  pod = deployment.dig("spec", "template", "spec")
  env = pod.dig("containers", 0, "env").to_h { |entry| [entry.fetch("name"), entry["value"]] }
  dir = env["GOOGLECHATBOT_PROACTIVITY_RULES_DIR"] or abort "rules directory not configured"
  mount = pod.dig("containers", 0, "volumeMounts").find { |entry| entry["mountPath"] == dir } or abort "rules directory not mounted"
  volume = pod.fetch("volumes").find { |entry| entry["name"] == mount["name"] }
  abort "rules volume does not use the ConfigMap" unless volume.dig("configMap", "name") == config_map.dig("metadata", "name")
  puts "verified Google Chat proactivity rules ConfigMap and mount"
' "$rendered"
if helm template parity contrib/chart -f "$rules" \
  --set 'googlechatbot.proactivity.spaceRules.AAAAalerts[1].name=alert' \
  --set 'googlechatbot.proactivity.spaceRules.AAAAalerts[1].when=Again.' >"$missing" 2>&1; then
  echo "googlechatbot rendered rules that repeat a name" >&2
  exit 1
fi
grep -Fq 'googlechatbot.proactivity: AAAAalerts rules repeat the name "alert"' "$missing"
