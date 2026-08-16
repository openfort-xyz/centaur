#!/usr/bin/env bash
set -euo pipefail

rendered="$(mktemp)"
missing="$(mktemp)"
project="$(mktemp)"
webhook="$(mktemp)"
addon="$(mktemp)"
trap 'rm -f "$rendered" "$missing" "$project" "$webhook" "$addon"' EXIT

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
