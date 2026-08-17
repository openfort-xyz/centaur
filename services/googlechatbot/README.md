# googlechatbot

Google Chat ingress and private Google API edge for Centaur. It verifies Chat
events, durably hands agent turns to api-rs, and replaces one thinking message
with the canonical final answer.

Google Chat has no `@chat-adapter/*` transport, so this service owns the Chat
wire formats and REST calls. It still uses the shared Chat SDK Postgres state
adapter for durable dedupe, thread state, leases, and render obligations.

## Runtime flow

```text
Google Chat -- signed POST /api/chat/events --> googlechatbot
                                                  |
                                                  +--> api-rs session API
                                                       --> sandbox

sandbox -- scoped Console JWT --> api-rs -- resource check --> googlechatbot
                                                            --> Chat/Drive APIs
```

The webhook accepts legacy Chat and Workspace Add-ons envelopes. It verifies
the Google-signed bearer before parsing identity, applies the configured sender
domain, resolves the canonical app member, suppresses self/other-bot/ordinary
unmentioned messages, and durably stores accepted messages or action events
before returning `{}`.

Google Chat has no streaming primitive. The bot creates one thinking message,
applies bounded status edits while SSE is open, then PATCHes the canonical final
onto that same acknowledgement, including rich `cardsV2` output. Only overflow
or a definitively missing acknowledgement uses a stable create. A Postgres-backed
recovery sweep leases unfinished obligations after disconnects or restarts and
delivers one canonical final answer.

## Configuration

See `.env.example` and the `googlechatbot` Helm values. Important settings:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service-account key for bot identity and scoped Google OAuth tokens. |
| `CENTAUR_API_URL` | api-rs base URL. |
| `GOOGLECHATBOT_API_KEY` / `CENTAUR_API_KEY` | Bot bearer for api-rs session operations. |
| `GOOGLECHATBOT_DATABASE_URL` / `DATABASE_URL` | Required durable state database. Production has no memory fallback. |
| `GOOGLECHATBOT_INTERNAL_API_KEY` | Private api-rs-to-googlechatbot credential. Never inject it into a sandbox. |
| `GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS` | Verify Google's webhook JWT; defaults to `true`. |
| `GOOGLECHATBOT_INGRESS_MODE` | Exact auth contract: `chat_api_project`, `chat_api_url`, or `workspace_addon`. |
| `GOOGLECHATBOT_PROJECT_NUMBER` / `GOOGLECHATBOT_WEBHOOK_AUDIENCE` | Audience required by the selected mode; they are not interchangeable fallbacks. |
| `GOOGLECHATBOT_ADDON_SERVICE_ACCOUNT_EMAIL` / `GOOGLECHATBOT_ADDON_OAUTH_CLIENT_ID` | Exact Add-on signer and optional verified human-token audience. |
| `GOOGLECHATBOT_SIGNED_REQUEST_MAX_AGE_SECONDS` | Maximum age of an otherwise valid signed token; defaults to 300 seconds. |
| `GOOGLECHATBOT_ALLOWED_DOMAIN` | Additional comma/space-separated sender-domain filter. Empty is not an authentication control. |
| `GOOGLECHATBOT_UPLOAD_USER` | Dedicated DWD upload subject; empty fails closed. |
| `GOOGLECHATBOT_REACTION_READ_USER` | Dedicated DWD reaction-read subject; empty fails closed. |
| `GOOGLECHATBOT_DRIVE_DOWNLOAD_USER` | Dedicated DWD Drive-read subject; missing access degrades to attachment metadata. |
| `GOOGLECHATBOT_THREAD_HISTORY_LIMIT` | Maximum prior thread messages collected per turn; default 50. |
| `GOOGLECHATBOT_ATTACHMENT_AGGREGATE_MAX_BYTES` | Decoded attachment ceiling per executed turn; default 100 MiB. |
| `GOOGLECHATBOT_RECOVERY_MAX_OBLIGATION_AGE_MS` | Maximum recoverable work age; default 24 hours. |
| `GOOGLECHATBOT_RECOVERY_FAILURE_BUDGET` | Failed recovery attempts before abandonment; default 5. |
| `GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS` | Recurring recovery scan interval; default 60 seconds. |
| `CHAT_EVENTS_PATH` | Public webhook path; default `/api/chat/events`. |

Signed requests are on by default. `GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS=false`
is a local-development escape hatch, not a production rollback mechanism.
`GOOGLECHATBOT_ALLOWED_DOMAIN` can be satisfied only by a verified Workspace
Add-on `userIdToken`; official Chat API `User` resources expose no email.

## OAuth scopes and delegated subjects

The app credential uses `chat.bot` and the administrator-approved
`chat.app.messages.readonly` scope. Live 1:1 DM history uses the signed and
Google-confirmed requester as a DWD subject with `chat.messages.readonly`.

Operations that reject app auth use independent DWD subjects:

| Subject variable | Scope |
| --- | --- |
| `GOOGLECHATBOT_UPLOAD_USER` | `chat.messages.create` |
| `GOOGLECHATBOT_REACTION_READ_USER` | `chat.messages.reactions.readonly` |
| `GOOGLECHATBOT_DRIVE_DOWNLOAD_USER` | `drive.readonly` |

Uploads are authored by the impersonated upload user, not the Chat app. Keep
the subjects separate so each delegated capability is independently revocable.
DM setup has no fixed subject: the validated target email is itself impersonated
with `chat.spaces.create`, so it must be an active, impersonable user in the
service account's Workspace domain.

## Permissions and internal API

Agent tools authenticate to api-rs with a short-lived Console JWT. Its
`google_chat` claim contains exact lists for send, update, delete, upload,
download, history, members, and reactions, plus exact DM setup targets. api-rs
validates the resource and operation, then calls this service with
`GOOGLECHATBOT_INTERNAL_API_KEY`.

The internal `/api/chat/*` routes are not sandbox APIs. NetworkPolicy admits
api-rs and denies direct sandbox/workflow access. Update/delete retain an
app-ownership check; file metadata/download routes are message-qualified; DM
setup plus first send is atomic from the caller's perspective.

## History and files

Each turn carries at most the configured message count and a newest-biased
24,000-character thread context. Up to 10 inbound attachments are hydrated.
Each decoded file is capped at 100 MiB and the turn aggregate defaults to
100 MiB. Files over 25 MiB use bounded, SHA-256-checked `attachment.chunk`
staging; smaller files are inline.

Uploaded-content and Drive-backed downloads enforce declared and observed size
limits. Google-native exports use documented MIME/extension pairs and report
Drive's separate 10 MB `files.export` ceiling distinctly; Google Vids remain
metadata-only because they require the long-running `files.download` method.
Other Drive access failures become metadata-only parts. The proxy download
ceiling is 100 MiB; the agent CLI defaults to 10 MiB and refuses overwrite.

## Health and metrics

- `/health/live`: process-only liveness.
- `/health/ready` and `/health`: 200 only after Postgres state connects.
- `/metrics`: Prometheus events, runs, identity, session operations, dedupe,
  recovery, timeout, delivery, open-SSE, state, and pending-obligation metrics.

The production server waits for state before binding its port. Chat and control
requests have bounded connect/request timeouts; the established SSE stream is
not killed by its connect timeout.

## Verification

```bash
pnpm --filter googlechatbot run check:types
pnpm --filter googlechatbot test
pnpm --filter googlechatbot run smoke
```

The smoke command uses signed deterministic legacy/Add-ons fixtures and mock
Google/session endpoints. It does not replace the required live Workspace or
Kind verification scripts. See
[`docs/pages/reference/google-chat.mdx`](../../docs/pages/reference/google-chat.mdx)
and [`docs/google-chat-parity-verification.md`](../../docs/google-chat-parity-verification.md).

Google Chat parity is not achieved while any verification-ledger row is
pending. Current pending gates include live Workspace wire/auth tests, a
final all-gates rerun on one commit, and actual narrow/wide Console browser
checks. The two-replica Kind restart/recovery and NetworkPolicy gates pass.
