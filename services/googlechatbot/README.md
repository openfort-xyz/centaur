# googlechatbot

Google Chat ingress for Centaur. Receives Google Chat webhook events, drives an
agent run through the `api-rs` session API, and delivers the answer back into the
same Chat message.

It is the Google Chat sibling of `services/slackbotv2` and `services/discordbot`.
Unlike those (which build on the `chat` SDK + a `@chat-adapter/*` package), Google
Chat has no chat-adapter, so this service owns its own webhook I/O: envelope
parsing, request verification, normalization, and the Chat REST client.

## Flow

```
User @mentions the bot in Google Chat
        │  POST {CHAT_EVENTS_PATH}  (webhook)
        ▼
  parseChatBody (v1 + Workspace Add-ons v2)
  verifyChatRequest (domain allowlist + event freshness)
  dedup → returns {} immediately (silent ACK)
        │  (async, after responding)
        ▼
  post "_Condor is thinking…_" ack message  ── seeds the bubble we PATCH later
  collectThreadHistory (parallel)
        ▼
  createSession → appendSessionMessages → executeSession   (POST /api/session/*)
  openSessionEventStream (GET /api/session/*/events, SSE)
        ▼
  CodexAppServerRendererEventMapper → status pulses + final answerMarkdown
  PATCH the ack message with the rendered Card v2 answer (single-message UX)
```

Single-message UX: Google Chat lacks a streaming primitive and rate-limits
edits, so the bubble shows short `_Condor · <task>…_` pulses while the run is in
flight, then is PATCHed once with the final answer.

## Runtime

Bun + Hono. `src/server.ts` is the entrypoint (`bun src/server.ts`).

## Configuration

See `.env.example`. Key variables:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account key for the Chat REST client (JWT OAuth2) and bot identity. |
| `CENTAUR_API_URL` | `api-rs` base URL (default `http://127.0.0.1:8080`). |
| `GOOGLECHATBOT_API_KEY` / `CENTAUR_API_KEY` | Bearer token for `api-rs`. |
| `GOOGLECHATBOT_ALLOWED_DOMAIN` | Comma/space-separated email-domain allowlist (empty = open). |
| `GOOGLECHATBOT_UPLOAD_USER` | Workspace user impersonated for attachment uploads (see below). Empty = uploads fail closed. |
| `CHAT_EVENTS_PATH` | Webhook path (default `/api/chat/events`). |

## Attachment uploads

`POST /api/chat/attachments` (Bearer `CHATBOT_API_KEY`) uploads a file into a
space and posts a message referencing it — the relay behind the `google-chat
upload` agent tool. Google Chat's `media.upload` rejects app auth (`chat.bot`),
so per the official docs the bot uses domain-wide delegation: a Workspace admin
grants the service account's client ID the
`https://www.googleapis.com/auth/chat.messages.create` scope
(Admin console → Security → API controls → Domain-wide delegation), and the bot
impersonates `GOOGLECHATBOT_UPLOAD_USER` for the upload and the message that
carries it. The upload message is therefore authored by that user, not the app.

## Tests

```
bun test src
```
