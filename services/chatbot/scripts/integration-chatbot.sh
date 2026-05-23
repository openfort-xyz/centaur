#!/bin/bash
set -euo pipefail

CHATBOT_URL="${CHATBOT_URL:-http://localhost:3002}"
CHATBOT_API_KEY="${CHATBOT_API_KEY:-dev-chatbot-key}"
SPACE_NAME="${SPACE_NAME:-spaces/test-space-123}"

header_auth() {
  echo "Authorization: Bearer $CHATBOT_API_KEY"
}

content_type() {
  echo "Content-Type: application/json"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "=== Chatbot Integration Smoke Test ==="
echo "CHATBOT_URL=$CHATBOT_URL"
echo ""

echo "--- Test 1: Health check ---"
HEALTH=$(curl -sS "$CHATBOT_URL/health")
echo "$HEALTH" | jq -e '.ok == true' > /dev/null || fail "Health check failed"
echo "  PASS"

echo "--- Test 2: Health ready redirect ---"
READY_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$CHATBOT_URL/health/ready")
[[ "$READY_STATUS" == "30"* ]] || fail "Health ready not a redirect"
echo "  PASS"

echo "--- Test 3: Events endpoint accepts valid JSON ---"
EVENT_RESPONSE=$(curl -sS -X POST "$CHATBOT_URL/api/chat/events" \
  -H "$(content_type)" \
  -d '{
    "type": "MESSAGE",
    "eventTime": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
    "space": {"name": "'"$SPACE_NAME"'", "type": "DIRECT_MESSAGE"},
    "message": {
      "name": "'"$SPACE_NAME"'/messages/test-1",
      "text": "hello",
      "sender": {"name": "users/123", "displayName": "Test User", "email": "test@example.com"}
    },
    "user": {"name": "users/123", "displayName": "Test User", "email": "test@example.com"}
  }')
RESPONSE_OK=$(echo "$EVENT_RESPONSE" | jq -r '.ok')
[[ "$RESPONSE_OK" == "true" ]] || fail "Events endpoint returned ok=false: $EVENT_RESPONSE"
echo "  PASS"

echo "--- Test 4: Events endpoint deduplicates ---"
DUP_RESPONSE=$(curl -sS -X POST "$CHATBOT_URL/api/chat/events" \
  -H "$(content_type)" \
  -d '{
    "type": "MESSAGE",
    "eventTime": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
    "space": {"name": "'"$SPACE_NAME"'", "type": "DIRECT_MESSAGE"},
    "message": {
      "name": "'"$SPACE_NAME"'/messages/test-1",
      "text": "hello",
      "sender": {"name": "users/123", "displayName": "Test User", "email": "test@example.com"}
    },
    "user": {"name": "users/123", "displayName": "Test User", "email": "test@example.com"}
  }')
DUP_OK=$(echo "$DUP_RESPONSE" | jq -r '.ok')
DUP_DUP=$(echo "$DUP_RESPONSE" | jq -r '.duplicate')
[[ "$DUP_OK" == "true" && "$DUP_DUP" == "true" ]] || fail "Dedup failed: $DUP_RESPONSE"
echo "  PASS"

echo "--- Test 5: Added to space event ---"
WELCOME_RESPONSE=$(curl -sS -X POST "$CHATBOT_URL/api/chat/events" \
  -H "$(content_type)" \
  -d '{
    "type": "ADDED_TO_SPACE",
    "eventTime": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
    "space": {"name": "'"$SPACE_NAME"'-new", "type": "DIRECT_MESSAGE"},
    "user": {"name": "users/456", "displayName": "New User", "email": "new@example.com"}
  }')
WELCOME_OK=$(echo "$WELCOME_RESPONSE" | jq -r '.ok')
[[ "$WELCOME_OK" == "true" ]] || fail "Added to space failed: $WELCOME_RESPONSE"
echo "  PASS"

echo "--- Test 6: Slash command event ---"
CMD_RESPONSE=$(curl -sS -X POST "$CHATBOT_URL/api/chat/events" \
  -H "$(content_type)" \
  -d '{
    "type": "MESSAGE",
    "eventTime": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
    "space": {"name": "'"$SPACE_NAME"'", "type": "DIRECT_MESSAGE"},
    "message": {
      "name": "'"$SPACE_NAME"'/messages/cmd-1",
      "text": "/centaur help me with something",
      "argumentText": "help me with something",
      "annotations": [{"type": "SLASH_COMMAND", "slashCommand": {"commandName": "/centaur", "commandId": 1}}],
      "sender": {"name": "users/123", "displayName": "Test User", "email": "test@example.com"}
    },
    "user": {"name": "users/123", "displayName": "Test User", "email": "test@example.com"}
  }')
CMD_OK=$(echo "$CMD_RESPONSE" | jq -r '.ok')
[[ "$CMD_OK" == "true" ]] || fail "Slash command failed: $CMD_RESPONSE"
echo "  PASS"

echo "--- Test 7: APP_COMMAND event ---"
APPCMD_RESPONSE=$(curl -sS -X POST "$CHATBOT_URL/api/chat/events" \
  -H "$(content_type)" \
  -d '{
    "type": "APP_COMMAND",
    "eventTime": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
    "space": {"name": "'"$SPACE_NAME"'", "type": "DIRECT_MESSAGE"},
    "appCommandMetadata": {"appCommandId": 2, "appCommandType": "SLASH_COMMAND"},
    "user": {"name": "users/123", "displayName": "Test User", "email": "test@example.com"}
  }')
APPCMD_OK=$(echo "$APPCMD_RESPONSE" | jq -r '.ok')
[[ "$APPCMD_OK" == "true" ]] || fail "APP_COMMAND failed: $APPCMD_RESPONSE"
echo "  PASS"

echo "--- Test 8: Rejects invalid domain ---"
BAD_DOMAIN_RESPONSE=$(curl -sS -X POST "$CHATBOT_URL/api/chat/events" \
  -H "$(content_type)" \
  -d '{
    "type": "MESSAGE",
    "eventTime": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
    "space": {"name": "'"$SPACE_NAME"'", "type": "DIRECT_MESSAGE"},
    "message": {
      "name": "'"$SPACE_NAME"'/messages/bad-1",
      "text": "hello",
      "sender": {"name": "users/evil", "displayName": "Evil", "email": "evil@bad-domain.com"}
    },
    "user": {"name": "users/evil", "displayName": "Evil", "email": "evil@bad-domain.com"}
  }')
BAD_DOMAIN_ERROR=$(echo "$BAD_DOMAIN_RESPONSE" | jq -r '.error')
[[ "$BAD_DOMAIN_ERROR" == "domain_not_allowlisted" ]] || fail "Domain allowlisting failed: $BAD_DOMAIN_RESPONSE"
echo "  PASS"

echo "--- Test 9: Rejects stale events ---"
STALE_RESPONSE=$(curl -sS -X POST "$CHATBOT_URL/api/chat/events" \
  -H "$(content_type)" \
  -d '{
    "type": "MESSAGE",
    "eventTime": "2020-01-01T00:00:00.000Z",
    "space": {"name": "'"$SPACE_NAME"'", "type": "DIRECT_MESSAGE"},
    "message": {
      "name": "'"$SPACE_NAME"'/messages/stale-1",
      "text": "stale",
      "sender": {"name": "users/123", "displayName": "Test User", "email": "test@example.com"}
    },
    "user": {"name": "users/123", "displayName": "Test User", "email": "test@example.com"}
  }')
STALE_ERROR=$(echo "$STALE_RESPONSE" | jq -r '.error')
[[ "$STALE_ERROR" == "stale_event_timestamp" ]] || fail "Stale event rejection failed: $STALE_RESPONSE"
echo "  PASS"

echo "--- Test 10: Rejects invalid JSON ---"
INVALID_RESPONSE=$(curl -sS -X POST "$CHATBOT_URL/api/chat/events" \
  -H "$(content_type)" \
  -d 'not json')
INVALID_ERROR=$(echo "$INVALID_RESPONSE" | jq -r '.error')
[[ "$INVALID_ERROR" == "invalid_chat_payload" ]] || fail "Invalid JSON handling failed: $INVALID_RESPONSE"
echo "  PASS"

echo ""
echo "=== All Smoke Tests Passed ==="
