# Google Chat ↔ Slack parity status

Status date: 2026-08-17

Google Chat parity is **implemented but not yet verified as achieved**. The
automated feature work is present in the current Centaur working tree; the
verification ledger still requires real Google Workspace and narrow/wide
browser evidence, then a final all-gates rerun on one commit.

The authoritative artifacts are:

- `docs/slack-vs-google-chat-n-to-n-comparison.md` — current capability matrix;
- `plan/feature-google-chat-slack-parity-1.md` — task/test contract;
- `docs/google-chat-parity-verification.md` — evidence ledger;
- `docs/google-chat-official-spec-conformance.md` — official-source traceability;
- `docs/pages/reference/google-chat.mdx` — operator setup and live smoke;
- `docs/pages/operate/google-chat-etl.mdx` — ETL, privacy, and retention.

Do not mark parity complete from fixture or unit tests alone.

## Outcome matrix

| Area | Slack reference behavior | Google Chat implementation | Verification state |
| --- | --- | --- | --- |
| Signed ingress | Body-bound Slack HMAC is mandatory. | Google-signed JWT is mandatory by default; issuer, audience, signature, numeric lifetime, age, sender domain, and canonical bot identity are checked. The token does not bind the body, so requester identity is released only after `spaces.get` confirms a signed 1:1 DM. | Automated pass; real signed legacy/Add-ons events pending. |
| Addressing and self suppression | Exact bot ID, Slack trigger-bot policy, DMs. | Exact Chat annotation/resource identity, slash annotations, DMs, self/other-bot suppression, optional follow-up threads. | Automated pass; live `members/app` identity pending. |
| Interactive events | Durable Slack block-action workflow events. | Legacy card clicks and Add-ons buttons, app commands, and forms become typed durable workflow events; dedupe includes user/function/parameters. | Automated pass; live button/form/command pending. |
| Conversation permissions | Exact channel lists for upload/download/history. | Exact space lists for send/update/delete/upload/download/history/members/reactions, plus exact DM setup targets. Direct and role grants merge. | Model/API/proxy tests pass; sandbox-JWT live smoke pending. |
| Credential topology | Slack proxy/direct APIs use scoped secrets and bot tokens. | Sandboxes call api-rs with a scoped Console JWT. Only api-rs can call googlechatbot's private API with a separate key; Google credentials remain at the bot/ETL edge. | Static, route, and live Kind NetworkPolicy/internal-auth checks pass. |
| api-rs ingress auth | `SLACKBOT_API_KEY` authenticates slackbotv2 as an ingress caller scoped to `slack:` thread keys; `/api/slack/*` requires a principal. | `GOOGLECHATBOT_API_KEY` authenticates googlechatbot as an ingress caller scoped to `chat:` thread keys, with workflow-event capability; `/api/google-chat/*` requires a principal. | Route-policy unit test passes; live 401/403 smoke pending. |
| DMs | Open/reuse DM by user; separate user-scoped private ingestion. | Create/reuse and send by exact email grant. Resource-name targets are rejected. Live DM identity/history uses a verified Add-on requester. ETL DMs are opt-in and owner-scoped. | Automated DM and cross-owner RLS checks pass; live DWD checks pending. |
| Conversation discovery | Channels, metadata, members, threads, users. | Spaces, metadata, members, threads, and paginated history. A broad Workspace user directory is intentionally excluded. | Automated pass; scoped live reads pending. |
| Search and analysis | Search, questions, dump, reactions. Upstream removed Slack's stateful feedback subsystem with the personas API. | Bounded authorized scans for search, questions, dump, feedback, and message-qualified reaction reads. `feedback` is a stateless derived view over `dump`, not the removed Slack subsystem, so it stays. | Automated pass; live reaction scope/rate-limit pending. |
| Send/update/delete | Slack tool sends; renderer owns its updates. No generic delete CLI. | Scoped send, app-owned update, and app-owned delete through api-rs. | Automated pass; live ownership/denial smoke pending. |
| Inbound files | Up to 100 MiB; large content uses staging; delayed Slack Connect repair. | Up to 10 files, 100 MiB each/aggregate by default; inline through 25 MiB, then hashed `attachment.chunk` staging. Uploaded and Drive-backed content supported. | Boundary/hash fixtures pass; live Workspace files pending. |
| Agent file tooling | List/search/info/download/upload through channel authorization. | List/search/info/raw download/upload through exact space authorization. Proxy ceiling 100 MiB; CLI download default 10 MiB. | Automated route/client tests pass; live file path pending. |
| Thread context | Refreshed history reaches every execution. | Configurable message cap and newest-biased 24k-character context; card-only text and accepted follow-up attachments are included. | Automated fixtures pass; live follow-up pending. |
| Sticky state | Harness/model/provider and delivery state persist in Postgres. | Harness/model/provider, message IDs, active execution, dedupe, and render obligations persist in Postgres; reasoning remains per-turn. | Database/restart tests and live Kind processing-pod replacement pass. |
| Delivery recovery | Durable lease, SSE resume/replay, final reconciliation. | Durable accepted-work record, per-thread lease, recurring sweep, SSE resume, canonical final update/replacement, bounded stale/failure cleanup. | Deterministic crash-stage tests and live Kind active-turn recovery with exactly one final pass. |
| Timeouts and health | Bounded API operations; readiness follows state. | Chat/control fetches are bounded, SSE connect timeout is separate, reader cleanup is tracked; liveness is process-only and readiness follows Postgres. | Automated and live Kind health/rollout checks pass. |
| Quota safety | Platform SDK/retry behavior. | Shared StateAdapter reservations pace every same-space write at 1/second and direct/aggregate reaction reads at 15/second across replicas; other reads retain bounded 429 retry. | Two-client shared-state tests pass; live multi-replica Workspace load proof pending. |
| Metrics | Webhook, handoff, state, render, recovery, and delivery families. | Events, runs, identity, session API, dedupe, recovery, upstream timeout, delivery, state, open SSE, and pending obligations. | Automated and live Kind scrape checks pass. |
| Historical ingestion | Incremental history, continuation/backfill, attachments, reactions/context, private data, retention, metrics. | Incremental per-space and owner checkpoint, durable page continuation, attachment/reaction tables, shared-space projection, owner-scoped DM RLS, retention, metrics. | Database and subject-aware broker tests pass; live Workspace ETL pending. |
| Console UX | Channel grants on principals/roles. | Space and DM grants on principals/roles with validation, immutable targets, cache invalidation, and responsive keyboard-addressable forms. | Rails tests pass; actual browser screenshots/interactions pending. |
| CI/smoke | Slack suite and integration fixtures. | Typecheck/tests, signed legacy/Add-ons fixture smoke, tool tests, Rust/Console/workflow checks, Helm/schema checks. | Fixture-only CI and docs build pass; final all-suites-on-one-SHA gate pending. |

## Platform-specific differences accepted by the plan

These are not missing work:

1. **No streaming-copy requirement.** Google Chat has no Slack-equivalent
   streaming primitive and enforces a write-rate model. The bot uses one
   thinking message, bounded status edits, and one canonical text update or
   retry-safe rich-message create followed by acknowledgement deletion. It does
   not reproduce Slack's assistant title API or every
   Block Kit presentation detail.
2. **No global Workspace directory.** Space membership and exact email DM
   targets provide the required outcomes without adding broad
   Admin SDK Directory access.
3. **No Slack-only objects.** Slack user groups, Slack Connect delayed-file
   repair, Slack export ZIP import, and Slack-specific channel/public/private
   vocabulary are not copied where Google Chat has no equivalent.
4. **Different authorship for uploads.** Chat media upload rejects app auth in
   this flow, so a dedicated DWD user creates the upload message. Slack uploads
   are bot-authored.
5. **Google-only message mutation.** Google Chat exposes scoped update/delete of
   app-owned messages to the agent tool. Slack does not need artificial commands
   merely to make the command counts identical.
6. **Google-native unimplemented APIs.** App Home, dynamic
   `widgetUpdatedPayload` suggestions, dialog UI responses, native message
   search/events, named-space administration, membership writes, reaction
   writes, and pins are outside the current Slack outcome surface. They remain
   explicit Google product-scope exclusions, not Slack parity gaps.

## Security boundary

The public endpoint is only `CHAT_EVENTS_PATH`. Every `/api/chat/*` route is
private and requires `GOOGLECHATBOT_INTERNAL_API_KEY`. Agent commands instead
call `/api/google-chat/*` on api-rs with a Console JWT containing exact claims:

- `send_spaces`;
- `update_spaces`;
- `delete_spaces`;
- `upload_spaces`;
- `download_spaces`;
- `history_spaces`;
- `member_spaces`;
- `reaction_spaces`;
- `dm_setup_targets`.

api-rs authorizes the method and exact resource before forwarding. A zero-space
list returns an empty result without an upstream call. Reaction and attachment
routes are message-qualified. DM setup/send validates only the granted target
and the exact space returned by Google; it does not let a caller smuggle a
different space.

Dedicated DWD subjects keep capabilities separately revocable:

| Capability | Subject setting | Scope |
| --- | --- | --- |
| Upload | `GOOGLECHATBOT_UPLOAD_USER` | `chat.messages.create` |
| DM setup target | Validated target email (same-domain, impersonable user) | `chat.spaces.create` |
| Reaction reads | `GOOGLECHATBOT_REACTION_READ_USER` | `chat.messages.reactions.readonly` |
| Drive attachments | `GOOGLECHATBOT_DRIVE_DOWNLOAD_USER` | `drive.readonly` |

The signed and Google-confirmed human requester is the only valid subject for
live 1:1 DM history. Missing configuration fails closed or degrades to
metadata-only content; it never falls back to a broader credential.

## Durable acceptance boundary

The bot requires Postgres and does not bind until it connects. Before returning
the Chat-required `{}` response, it writes the accepted message/action and its
dedupe state. Work transitions through accepted, thinking, rendering, and final
stages. A renewable per-thread lease prevents concurrent replicas from
delivering the same obligation.

Recovery scans at startup and on a configured interval. It resumes an existing
execution from the last event ID, reuses a stored canonical final when present,
and clears thread activity only after delivery/cleanup. Obligations older than
the configured maximum or beyond the failure budget are abandoned visibly in
metrics rather than retried forever.

## File and history ceilings

| Boundary | Value |
| --- | --- |
| Thread messages collected | Configurable, 50 by default, maximum 1000. |
| Thread context text | Newest-biased 24,000 characters. |
| Attachments per inbound message | 10. |
| Inline decoded file | 25 MiB. |
| Staged/decoded binary file | 100 MiB. |
| Google-native Drive `files.export` | 10 MB Google service limit; the client enforces/classifies the boundary and tests both declared and API-reported oversize failures. |
| Aggregate decoded files per turn | Configurable, 100 MiB by default. |
| api-rs proxy upload/download | 100 MiB. |
| Agent CLI download | 10 MiB by default, caller may lower/raise up to proxy policy. |
| JSON control response | 10 MiB. |
| Complete serialized Google `Message` | 32,000 UTF-8 bytes. |
| Card widgets | 100 per card; each section must contain a widget. |

Staged chunks carry deterministic order, total size, and SHA-256. Malformed,
missing, oversized, or aggregate-over-limit attachments fail before execution.
Drive reads validate the resource metadata and exact observed byte count.

## ETL privacy and lifecycle

Shared-space data uses `owner_email=''` and may be projected into company
context. Delegated DM data uses the exact allowlisted DWD subject as owner;
memberships contribute canonical IDs/display names because Google `User` has no
email field. Requester-email RLS protects the owner boundary. Private DM rows
are never projected into the company-wide Google Chat corpus.

Page tokens and their filters are persisted per owner/space, so a bounded first
backfill continues instead of skipping unread pages. The ETL stores message,
attachment, and reaction records; projects shared thread/attachment context;
exports bounded-label health metrics; and has count/dry-run/delete retention.
Retention deletes only Centaur data.

Scheduled sync rescans history so edits to old messages converge. Every app and
delegated message scan requests the officially supported `showDeleted=true` and
removes tombstoned local messages, attachments, and reactions. The former claim
that app-authenticated shared-space scans could not request tombstones was
incorrect. Automated cleanup exists; real shared-space and DM
create→sync→delete→resync evidence remains required. Retention must not be used
as a substitute for that source-reconciliation proof.

## Required live evidence

In plain language, a release blocker means the new branch has not yet been
shown to work with Google's real signer, scopes, payloads, or browser surface.
It does not mean a Slack-only platform feature must be copied. The following
remain blockers even when every local suite is green:

- real Google-signed project-number and endpoint-audience events;
- real legacy and Workspace Add-ons mention/action/command/form wire shapes;
- live `members/app` canonical bot identity and sender suppression;
- live scoped sandbox JWT allow/deny checks for every operation;
- DWD DM setup, DM history, upload, reaction, Drive, and rotation checks;
- attachment boundary/hash checks against Workspace;
- narrow/wide keyboard-only Console permission interaction screenshots;
- ETL continuation, reaction/attachment capture, private-DM RLS, and retention
  against a non-production Workspace.
- shared-space and delegated-DM deletion-convergence smokes using
  `showDeleted=true`;
- native Drive export checks below and above Google's separate 10 MB
  `files.export` limit; the 100 MiB binary ceiling does not apply to native
  exports.

The 2026-08-14 read-only VPS audit observed an older deployed image
(`sha-980e5e3b`), not this working tree. It confirms retained legacy
`spaces.list`, `members.list`, `messages.list`, create/execute/SSE and health
behavior only. It provides no current-branch evidence for ingress auth modes,
DM setup, reactions, DWD brokers, scoped proxy calls, uploads/downloads,
rendering limits, or deletion tombstones.

Run `pnpm --filter googlechatbot run smoke` for deterministic fixtures, then
follow `docs/pages/reference/google-chat.mdx` for the live procedure and record
artifacts in `docs/google-chat-parity-verification.md`.

## Upstream sync windows

### 2026-08-17 — 25 upstream commits, `1b60f619..0e58fe86`

Slack-touching upstream work and its Google Chat disposition.

| Upstream | Slack change | Google Chat disposition |
| --- | --- | --- |
| #1374 authenticate api-rs routes | Every `/api` route requires a caller; `SLACKBOT_API_KEY` registers slackbotv2 as an ingress caller; `/api/slack/*` maps to principal-only. | **Ported.** `GOOGLECHATBOT_API_KEY` registered as an ingress caller with prefix `chat:` and workflow-event capability; `/api/google-chat/*` mapped to principal-only. Without both, the Chat proxy would 403 and the bot would 401 on every session call. Chart passes the key to api-rs; bootstrap generates it; the bot's key is now required, and the dead `CHATBOT_API_KEY` fallback is removed. |
| #1394 sandbox API JWT capabilities | Console always mints a principal JWT and adds a `capabilities` claim; the empty-grant short-circuits are gone. | **Ported.** `google_chat` claims are now always emitted alongside `slack`; revoking Chat grants empties the lists instead of withholding the token. |
| #1378 link Slack DM principals to console users | `slack_dm` principals link to a Console user by `slack_email` at the API upsert boundary, with a backfill migration. | **Ported.** `gchat_dm` principals link by the `google_email` label — the verified-requester address api-rs stamps only for signed 1:1 DMs — plus the matching backfill. |
| #1391 prevent task phrasing from selecting amp | Two extra classifier rules in the LLM override strategy. | **Ported** verbatim into the Chat strategy prompt. |
| #1389 log Slack webhook receipt metadata | Receipt is logged before the allow filter so ignored deliveries stay visible. | **Ported in spirit.** Chat must authenticate before reading an attacker-sized body, so receipt is logged immediately after the body read; the previously silent oversize/unparseable 400s now emit a reject log and counter. |
| #1376 remove Slack feedback tool | Removed a 1,053-line stateful feedback/triage/personas subsystem. | **Not applicable.** `google_chat feedback` is a stateless derived view over `dump` with no tables, personas, or loop. Kept. |
| #1372 stabilize Slack DM sync ingestion | Advisory locks serialize overlapping conversations inside the api-rs batch transaction. | **Not applicable.** The Chat ETL writes single-statement upserts keyed on `(owner_email, space_id)` directly from the workflow; there is no batch endpoint or shared transaction to serialize. |
| #1395 give console worker the Slack bot token | The worker runs Slack channel-catalog refresh jobs. | **Not applicable.** Console has no Google Chat catalog job; Chat grants take exact space names. |

Remaining commits in the window (skills, MCP argument validation, DocSend,
investigator, session cleanup, docs, CI) are platform-agnostic.

## Rollback

Disable ingress or the googlechatbot workload; disable both shared and DM ETL;
revoke DWD scopes; remove Console grants; and roll workloads back with Helm.
Never leave the public endpoint enabled by turning signature verification off.
The new database objects are additive and should remain through application
rollback until no deployed binary references them.
