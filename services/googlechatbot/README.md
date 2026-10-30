# googlechatbot

Google Chat ingress and private Google API client for Centaur. It verifies Chat
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

Google Chat has no streaming primitive. The bot creates one thinking message
carrying a Stop button, applies bounded status edits while SSE is open (each
edit re-sends the button, because `updateMask=text,cardsV2` would otherwise
strip it), then PATCHes the final answer onto that acknowledgement, which
removes the button. Ordinary answers use Chat text formatting; standalone
images use `cardsV2`, and a Console link may add a small card. Only overflow
or a definitively missing acknowledgement uses a stable create. A Postgres-backed
recovery sweep leases unfinished obligations after disconnects or restarts and
delivers one canonical final answer.

## Stop, steering, and serialization

A mentioned `stop` (or any phrase `stop-command.ts` accepts) and the Stop
button both interrupt the thread's active api-rs execution while the original
response stream stays open; the live render then shows the interrupted
result. The button's callback follows the ingress contract: Chat API modes
(`chat_api_project`, `chat_api_url`) send the bare function name
`centaur_stop`; a Workspace Add-on must address the app's own endpoint, so in
`workspace_addon` mode the button's `function` is the validated
`GOOGLECHATBOT_WEBHOOK_AUDIENCE` URL with an `actionName=centaur_stop`
parameter, and the click arrives as a `buttonClickedPayload` whose
`commonEventObject.invokedFunction` echoes that URL. A URL never names an
action by itself. For a click, command, or form submission the contextual
message is the card the app authored, so the verified Add-on user token is
bound to the interacting `user`, never the card's sender; a MESSAGE is still
bound to its actual sender. Stop intent is written to thread state before anything else, so a stop
that lands while session creation or the execute call is still pending makes
that turn finish as "Stopped before the run started" instead of executing.
The button is bound to the acknowledgement it sits on through a durable record
that is deleted at final and at stop; a click carries no trusted parameters,
and the binding is checked under the thread's handoff lock, so a button from an
earlier turn can never interrupt a newer execution. A stop whose Google event
time predates the active turn's message is ignored.

Each accepted obligation holds its own render lease (one process drives it,
live or recovery). Thread ordering lives in a short, renewed handoff lock held
only across session create, append-or-execute, and stop checks. A mentioned
follow-up from the same verified requester therefore reaches the active
execution (steering) while another process is still rendering it; a
follow-up from anyone else in a shared space is refused with a "still
running" notice, as before.

## Contextual replies

With `GOOGLECHATBOT_PROACTIVITY_ENABLED=true`, a mention in one of the exact
`GOOGLECHATBOT_PROACTIVITY_SPACES` opts its thread in until a stop. Google
pushes no unmentioned messages to a Chat app, so the bot polls
`spaces.messages.list` for the listed spaces (every
`GOOGLECHATBOT_PROACTIVITY_POLL_INTERVAL_MS`, one poller per space across
replicas, durable cursor, dedupe shared with the webhook, bot and mention
messages skipped). Each collected message passes the same identity, domain,
and timestamp checks as a webhook delivery. An unmentioned message in an
eligible thread is classified with the OpenAI Decisions API using recent
thread history; a decline, a classifier error or timeout, an ineligible
thread, or a message seen while a run is active stays silent. An unmentioned
message never steers an active execution and never starts one if a newer turn
began after it was sent. A stop ends participation until the next mention.
DMs are always addressed and never polled.

## Original-message reaction

Google's `spaces.messages.reactions.create` and `delete` reject app auth.
When `GOOGLECHATBOT_REACTION_ACTOR_USER` names a Workspace user with a
domain-wide-delegation grant for `chat.messages.reactions`, the bot reacts to
the message that starts a turn as that user and removes the reaction when the
turn ends, whatever the outcome. The reaction is visibly authored by that
user, not the Chat app. Without an actor, or on any failure, the thinking
message remains the only acknowledgement; a 403 disables further attempts for
the process.

The initial `--persona <id>` selection is pinned by api-rs for the session;
later persona flags do not replace it. An unavailable requested persona produces
a fallback notice. The Console chat UI was removed upstream, so Helm no longer supplies
Console session links. Response metadata still renders independently.

## Configuration

See `.env.example` and the `googlechatbot` Helm values. Important settings:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service-account key for bot identity and scoped Google OAuth tokens. |
| `CENTAUR_API_URL` | api-rs base URL. |
| `GOOGLECHATBOT_API_KEY` / `CENTAUR_API_KEY` | Required. Bot bearer for api-rs session operations; api-rs authenticates every `/api` route, and this key is what registers the bot as a `chat:spaces:`-scoped ingress caller. |
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
| `GOOGLECHATBOT_REACTION_ACTOR_USER` | DWD subject that writes the turn-start reaction (`chat.messages.reactions`); empty disables reactions. Never shares the read-only subject. |
| `GOOGLECHATBOT_ACK_REACTION` | Unicode emoji for the turn-start reaction; default 👀. |
| `GOOGLECHATBOT_PROACTIVITY_ENABLED` | Contextual replies in exact spaces; default `false`. |
| `GOOGLECHATBOT_PROACTIVITY_SPACES` | Comma-separated `spaces/<id>` names; required when enabled. There is no all-spaces mode. |
| `GOOGLECHATBOT_PROACTIVITY_CLASSIFIER` / `GOOGLECHATBOT_PROACTIVITY_MODEL` | `openai` on `gpt-6-luna` by default. |
| `GOOGLECHATBOT_PROACTIVITY_OPENAI_API_KEY` | Classifier key; falls back to `OPENAI_API_KEY`. Required when enabled. |
| `GOOGLECHATBOT_PROACTIVITY_TIMEOUT_MS` / `GOOGLECHATBOT_PROACTIVITY_POLL_INTERVAL_MS` | Decision deadline (default 2 s) and poll interval (default 5 s). |
| `GOOGLECHATBOT_MESSAGE_OVERRIDES_STRATEGY` / `GOOGLECHATBOT_MESSAGE_OVERRIDES_MODEL` | `flags` (default) or `llm`, which classifies natural-language model requests with the OpenAI Decisions API on `gpt-6-luna`. |
| `GOOGLECHATBOT_SHUTDOWN_DRAIN_MS` | How long SIGTERM waits for live turns; default 20 s. |
| `GOOGLECHATBOT_DRIVE_DOWNLOAD_USER` | Dedicated DWD Drive-read subject; missing access degrades to attachment metadata. |
| `GOOGLECHATBOT_THREAD_HISTORY_LIMIT` | Maximum prior thread messages collected per turn; default 50. |
| `GOOGLECHATBOT_ATTACHMENT_AGGREGATE_MAX_BYTES` | Decoded attachment ceiling per executed turn; default 100 MiB. |
| `GOOGLECHATBOT_RECOVERY_MAX_OBLIGATION_AGE_MS` | Maximum recoverable work age; default 24 hours. |
| `GOOGLECHATBOT_RECOVERY_FAILURE_BUDGET` | Failed recovery attempts before abandonment; default 5. |
| `GOOGLECHATBOT_RECOVERY_SWEEP_INTERVAL_MS` | Recurring recovery scan interval; default 60 seconds. |
| `SESSION_MAX_DURATION_MS` | Execution limit; default 30 minutes. |
| `SESSION_IDLE_TIMEOUT_MS` | Idle limit; default is the smaller of three hours and the execution limit. |
| `CHAT_EVENTS_PATH` | Public webhook path; default `/api/chat/events`. |

Signed requests are on by default. `GOOGLECHATBOT_REQUIRE_SIGNED_REQUESTS=false`
is a local-development escape hatch, not a production rollback mechanism.
`GOOGLECHATBOT_ALLOWED_DOMAIN` can be satisfied only by a verified Workspace
Add-on `userIdToken`; official Chat API `User` resources expose no email.

## OAuth scopes and delegated subjects

The app credential uses `chat.bot` and the administrator-approved
`chat.app.messages.readonly` scope for shared-space history. Live DM turns replay
the bot's retained transcript without calling Google's history API. Agent tools
and DM ETL use delegated history reads with `chat.messages.readonly`.

Operations that reject app auth use independent DWD subjects:

| Subject variable | Scope |
| --- | --- |
| `GOOGLECHATBOT_UPLOAD_USER` | `chat.messages.create` |
| `GOOGLECHATBOT_REACTION_READ_USER` | `chat.messages.reactions.readonly` |
| `GOOGLECHATBOT_REACTION_ACTOR_USER` | `chat.messages.reactions` (create and delete the turn-start reaction) |
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
api-rs and denies direct sandbox/workflow access when enabled and enforced by
the cluster. Update/delete retain an ownership check using app or configured delegated credentials. File metadata
and download routes are message-qualified. DM setup and first send share one
API request, but they are separate Google operations; a send failure can leave
the DM created.

## History and files

Each turn carries at most the configured message count and a newest-biased
24,000-character thread context. DM transcripts retain accepted user turns and
delivered assistant answers, with attachment metadata only. They do not backfill
messages from before the bot retained them. Named spaces and group chats fetch
thread history from Google. Up to 10 inbound attachments are hydrated.
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

On SIGTERM the bot fails readiness, keeps answering webhooks briefly, waits
up to `GOOGLECHATBOT_SHUTDOWN_DRAIN_MS` for live turns, then exits. A turn
still running is recovered by the next process from its durable obligation.
Recovery discovers pending work by querying the work records themselves on
Postgres (the rolling list index only serves in-memory test adapters), so an
old unfinished obligation is never evicted from discovery by later work. Work
and handoff leases use the state adapter's token-checked locks, and a lease's
authority ends at a conservative deadline (the time its last renewal was
issued plus the TTL) enforced by its own timer, so a renewal that hangs or
answers late never stretches ownership past the row's real expiry; an expired
owner cannot renew or release a successor's lease and stops mutating once it
loses ownership. Sweeps launch up to eight obligations in the background so one
hung stream cannot block the backlog.

### Rolling out the lock-based leases

Earlier releases leased a whole thread through a cache entry; this release
leases each obligation through the locks table, and the two schemes do not
see each other. The chart deploys googlechatbot with `updateStrategy:
Recreate` so an old and a new replica never drive the same obligation during
the first rollout; legacy obligations are ordinary work records and are
recovered by the new process. `RollingUpdate` is safe again once every running
replica uses this scheme.

## Harness routing

`GOOGLECHATBOT_ENABLED_HARNESSES` optionally restricts routing to known,
comma-separated harness wire names (for example `codex,claudecode,omp`). Omit it
to preserve unrestricted routing. The deployment default must be in the list;
empty lists and unknown names fail startup. Disabled inline, sticky, or space
selections fall back to the deployment default and clear model/provider
selection. Session API responses cannot send execution to a disabled harness.
A persona that pins a model for the thread's harness overrides model and
provider selections, and the footer names the pinned model.

`--omp` selects the OMP harness and supports Pi-compatible reasoning levels.
`CENTAUR_OMP_MODEL` sets its deployment model default and is mirrored from
`sandbox.extraEnv` by the chart. Unqualified Sol requests in LLM override mode
select `gpt-6.1-sol`; an explicit GPT-6 Sol request still selects `gpt-6-sol`.

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

The ledger records dated Workspace and Kind evidence. It still leaves auth-mode,
action/form, deletion, large-file, Console browser, quota, RLS, retention, and
same-release checks incomplete. Earlier successful runs do not validate later
changes; do not claim complete parity from this local suite.
