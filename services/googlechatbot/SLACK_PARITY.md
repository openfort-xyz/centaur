# Google Chat and Slack parity status

Source review date: 2026-09-07. Live evidence remains dated separately in the
[verification ledger](../../docs/google-chat-parity-verification.md).

Google Chat implements the planned integration, but complete parity remains
unverified. The August release records include signed named-space ingress,
same-message rendering, scoped operations, files, and shared/DM ETL. They do
not certify later changes or the remaining auth-mode, action/form, deletion,
large-file, Console browser, quota, RLS, retention, and same-release gates.

Use these documents for different purposes:

- [Service README](README.md) and [operator reference](../../docs/pages/reference/google-chat.mdx)
  describe current configuration and behavior.
- [ETL guide](../../docs/pages/operate/google-chat-etl.mdx) covers ingestion and retention.
- [Parity plan](../../plan/feature-google-chat-slack-parity-1.md) defines the 31 verification gates.
- [Verification ledger](../../docs/google-chat-parity-verification.md) records results by release.
- [August comparison](../../docs/slack-vs-google-chat-n-to-n-comparison.md) and
  [official-spec audit](../../docs/google-chat-official-spec-conformance.md) are dated snapshots.

## Implementation boundaries

| Area | Current behavior | Evidence or remaining check |
| --- | --- | --- |
| Ingress | Three explicit JWT modes; verified Add-on user token, domain allowlist, and Google-confirmed DM required before releasing a requester email. | Named-space Add-on ingress is recorded live; other modes and negative cases remain. |
| Addressing | Exact mentions in spaces/group chats; DMs are addressed to the bot. Actions become durable workflow events. | Mention/app identity has recorded evidence; action, command, form, and suppression scenarios remain. |
| Permissions | Console merges direct and role grants for each exact space/operation and DM target. api-rs checks them before forwarding. | Representative allow/deny operations are recorded; the full same-release matrix remains. |
| Agent credentials | Tools use a Console JWT. api-rs selects a reader from signed claims and authenticates to the private bot API. | Keep Google credentials and the internal key out of sandboxes. |
| Live DM context | Replay retained user turns and delivered assistant answers from Postgres, without Google history reads. Prior attachments become metadata. | Transcript, fold, redelivery, and recovery tests exist; live sandbox-replacement proof remains. |
| Shared context | Fetch named-space/group thread history from Google, then include bounded context in the execution input. | Unmentioned messages are included when the API returns them. |
| Tools | Discovery, history, search, messages, reactions, DM setup/send, and files use scoped api-rs routes. | Search is bounded and reports truncation. No global user directory. |
| Mutations | Update/delete verify app or configured delegated ownership. Uploads are authored by the delegated uploader. | Representative mutations and exact small-file transfer are recorded; full boundary tests remain. |
| Rendering | Edit one thinking acknowledgement. Ordinary answers use Chat text, images use cards, and overflow uses stable message IDs. | Same-message rendering is recorded live. A missing acknowledgement permits replacement; ambiguous failures remain retry obligations. |
| State and recovery | Persist accepted work, dedupe, overrides, DM transcripts, execution IDs, and final answers. Recover through leases and a recurring sweep. | Earlier Kind restart and policy checks are recorded; they do not prove every crash boundary on the current source. |
| ETL | Shared-space projection, separate owner-scoped DM rows, resumable pagination, tombstones, retention, and metrics. | Ingestion is recorded live. Deletion convergence, RLS, and retention gates remain. |
| Console | Space and DM grants, scheduled destinations, and thread visibility. | Automated coverage exists; narrow/wide keyboard interaction evidence remains. |
| Session preferences | Model and reasoning overrides follow the shared harness vocabulary. api-rs pins the initial persona; unavailable requested personas produce a fallback notice. | Persona, alias, reasoning, and notice tests cover the September sync. |

## Platform differences

Google Chat has no equivalent to Slack's streaming and assistant-title APIs.
The bot uses status edits and final message updates. It does not delete the
thinking acknowledgement after a successful final PATCH.

The plan excludes Slack-only objects and several Google-native features,
including a global user directory, App Home, dialogs, dynamic suggestions,
link previews, named-space administration, membership writes, reaction writes,
and pins. See CON-001 and CON-002 for the full exclusion list.

The Google Chat `feedback` command derives a bounded view from `dump`. It has
no counterpart to the removed Slack feedback database or persona subsystem.

## Authorization and delegated reads

`CHAT_EVENTS_PATH` is public. Other `/api/chat/*` routes require the private
api-rs key. Agent commands use `/api/google-chat/*` and exact Console claims:
`send_spaces`, `update_spaces`, `delete_spaces`, `upload_spaces`,
`download_spaces`, `history_spaces`, `member_spaces`, `reaction_spaces`, and
`dm_setup_targets`. `reader_subjects` maps authorized spaces to readers selected
by the Console; it does not grant additional operations or destinations.

A zero-space discovery grant returns no results without an upstream call.
Attachment and reaction routes require message-qualified resources. DM setup
and first send use one api-rs request, but separate Google calls. A failed send
can leave the DM created.

| Delegated operation | Subject | Scope |
| --- | --- | --- |
| Upload | `GOOGLECHATBOT_UPLOAD_USER` | `chat.messages.create` |
| DM setup | Validated target email | `chat.spaces.create` |
| Agent DM history | Console-selected reader for the exact space | `chat.messages.readonly` |
| Shared reactions | `GOOGLECHATBOT_REACTION_READ_USER` | `chat.messages.reactions.readonly` |
| DM ETL | Exact allowlisted owner | Message, space, membership, and reaction read scopes |
| Drive attachment | `GOOGLECHATBOT_DRIVE_DOWNLOAD_USER` | `drive.readonly` |

Live DM transcript replay does not need a delegated history token. Shared ETL
app reads use iron-proxy; delegated ETL reads go through the api-rs broker.

## Recovery and limits

The bot waits for Postgres before binding its port. Accepted work moves through
`accepted`, `thinking`, `rendering`, and `final`. Live SSE reconnects use the last
event ID. Restart recovery replays the execution from zero to reconstruct the
answer unless a canonical final is already stored. Age and failure limits stop
indefinite retries and record abandonment in metrics.

| Boundary | Limit |
| --- | --- |
| Retained DM turns or fetched thread history | Configurable, default 50, maximum 1000 |
| Execution thread context | Newest-biased 24,000 characters |
| Inbound attachments | First 10 per message |
| Inline file | 25 MiB decoded |
| Staged file | 100 MiB decoded, ordered chunks with SHA-256 |
| Aggregate files per turn | Configurable, default 100 MiB |
| Proxy upload/download | 100 MiB |
| CLI download | Default 10 MiB, bounded by proxy policy |
| Native Drive export | Separate 10 MB limit |
| JSON control response | 10 MiB |
| Serialized Chat message | 32,000 UTF-8 bytes |
| Card | At most 100 widgets; no empty sections |

These are per-operation limits, not an overall memory or queue-capacity bound. The
[source review](../../docs/fork-upstream-review.md) records unresolved work-index
and lease-ownership defects. Earlier recovery tests do not close those cases.

## Validation

Run the service checks in the [README](README.md), then follow the operator
reference for Workspace, Kind, and Console browser verification. Keep all live
results tied to an immutable commit or image digest. TEST-031 requires every
preceding gate to pass on the same evidence identifier.

## Upstream sync windows

### 2026-09-07 — 26 upstream commits, `d8523f7a..d3143c35`

| Upstream | Slack change | Google Chat disposition |
| --- | --- | --- |
| #1595 pin personas for thread lifetime | `--persona <id>` flag; the persona sent when the session is created is pinned by api-rs for the thread's lifetime, later flags are stripped but ignored; the pinned value persists in thread state. | **Ported.** Same flag in `overrides.ts`; `createSession` sends `persona_id` and reads back `persona_id`; `personaId` persists in thread state and is re-sent on harness restarts. The LLM strategy still reads the rest of a persona-flagged message. Slack's preserve/reconcile machinery is not copied: api-rs ignores later personas, so the bot just records what api-rs returns. |
| #1598 fall back from unavailable personas | api-rs replaces an unavailable requested persona and reports `unavailable_requested_persona_id`; the Slack context block carries a warning notice. | **Ported.** `personaFallbackNotice` renders as a leading `⚠️` segment on the Console/metadata widget, which now renders for the notice alone. |
| #1485 Claude aliases to Opus 5 / Sonnet 5 | `--opus`/`--sonnet` and the LLM strategy expand to `claude-opus-5`/`claude-sonnet-5`; Claude Code bumped to 2.1.245. | **Ported** verbatim (alias map, strategy prompt). The sandbox Dockerfile merge takes upstream's Claude Code/Codex pins. |
| #1599 GPT-6-Astra support | `gpt-6-astra` model with the `ultra` effort level in flags, the strategy vocabulary, and the trailer. | **Ported** verbatim (`-rsn ultra`, `gpt-6-astra` in `STRATEGY_MODEL_HARNESSES`, astra effort table and `Ultra` display name). |
| #1597 hide Slack console links when chat is disabled | The chart only passes `CENTAUR_CONSOLE_PUBLIC_URL` to slackbotv2 when `console.chat.enabled`. | **Ported.** Same gate on the googlechatbot template; verified by rendering both values. |
| #1596 console chat sunset controls | Console-side feature flag and PWA/threads UI changes. | **Shared.** Console-only; the Chat-facing half is #1597 above. |
| #1590 canonical Slack permalinks | The Slack tool asks `chat.getPermalink` instead of formatting `slack.com/archives` URLs. | **Not applicable.** Google Chat has no permalink API; the Chat tool already builds the canonical `mail.google.com/chat/...` deep link from the space and message ids. |
| #1573 default Codex reasoning medium | Baked `harness/codex/config.toml` effort and Slack test expectations. | **Shared.** The Chat trailer tests read the baked value, so no change. |
| #1539 linearbot per-turn reasoning effort | Linear only. | **Not applicable.** |

Merge mechanics: one conflict, the sandbox Dockerfile `CLAUDE_CODE_VERSION` /
`CODEX_VERSION` pins (upstream wins). No new numbered SQLx migrations
(the memory-generation migration is experimental and unnumbered), so the
fork offset stays **+4**. api-rs, harness-server, and the Console
controllers auto-merged around the fork's Chat additions.

### 2026-08-31 — 36 upstream commits, `bc72622b..d8523f7a`

| Upstream | Slack change | Google Chat disposition |
| --- | --- | --- |
| #1519 acknowledge steering messages | A mention forwarded into an active execution gets an hourglass reaction that is removed when that run's render finalizes; the thread-wide assistant status is no longer cleared or replaced by the steering turn. | **Ported.** Chat's `reactions.create` is user-auth only, so the acknowledgement is the eager "thinking…" bubble edited into `_Centaur · added to the running turn…_` instead of being deleted on fold; the live run deletes the held notices when it finalizes (live and recovery paths). Names persist in thread state (`steeringAckMessageNames`), so a bot restart still clears them. The status half is moot: each Chat event owns its own bubble. |
| #1477 log Slack webhook retry headers | `x-slack-retry-num`/`x-slack-retry-reason` land on the receipt log. | **Not applicable.** Google Chat HTTP endpoints receive each event once and carry no retry headers. |
| #1445 persist Slack bot channel catalog | Console caches the channels the bot is in and refreshes memberships on principal creation. | **Not applicable.** Chat grants take exact `spaces/<id>` names; no Console catalog (unchanged since 2026-08-17). |
| #1440, #1447, #1453, #1456, #1479, #1480 scheduled tasks | Console-managed cron tasks deliver to a Slack channel or DM, with Slack formatting and an author footer; `mrkdwn` passes through the workflow Slack payload. | **Ported.** `delivery_channel` also accepts `spaces/<id>` or the author's own email, dispatched by shape with no schema change. Deltas: a space is authorized by the author's effective `send_spaces` grant instead of a channel catalog (`GoogleChatDeliveryPolicy`); the DM identity is the author's console email, resolved to a space at run time by `ctx.google_chat_dm_setup`; the footer is plain text (`Sent by <email>'s scheduled task`) because grants hold emails, not `users/<id>`; and Chat formatting plus 4,000-character chunking live in `console_workflow.py` because the internal send route bypasses the bot renderer. |
| #1457, #1465, #1468 Slack DM sync resilience | Console Slack DM credential sync serializes per credential and retries DNS/rate-limit failures. | **Not applicable.** Chat DM history is the bot's own transcript (#166); there is no Console Chat DM sync job. |
| #1494, #1496 bind the requester principal on console and GitHub turns | Console/GitHub turns carry a `requester_principal_foreign_id` that only console callers may assert. | **Already equivalent.** Chat binds the verified DM requester at the api-rs boundary (`google_email`), which this change leaves in place. |
| #1505 inject selected persona prompts into sandboxes | Persona prompts are mounted as sandbox files and composed into the system prompt. | **Shared.** Selection lives in api-rs/Console; neither bot selects personas. |

Merge mechanics: six conflicts. `otel.rs` took upstream's rewrite (#1449) —
the fork's only change there was a lint fix to a function upstream deleted;
upstream also dropped `sha2` from harness-server, which the fork's attachment
chunk hashing still needs, so it is re-added. Console `Principal::KINDS`,
iron-control imports, and the api-rs route tests are unions; the sandbox
Dockerfile keeps the fork's `cryptography` pin and drops upstream's removed
`opentelemetry-proto`. Upstream's `0053`/`0054` company-context embedding
migrations import as **`0057`/`0058`** (fork is +4). The fork's Chat
`SessionTraceContext` test follows upstream's new `new(None, None)` signature.

### 2026-08-20 — 42 upstream commits, `0e58fe86..bc72622b`

| Upstream | Slack change | Google Chat disposition |
| --- | --- | --- |
| #1437 own Nanocodex rollout policy | Slackbot now selects and records its rollout cohort after api-rs removed the shared policy. | **Ported.** Googlechatbot uses the same deterministic selection, model-override bypass, sticky conflict recovery, chart value, and session/execution metadata. |
| #1411 preserve unchanged message timestamps | Slack ETL no longer advances `updated_at` when the raw payload is unchanged. | **Ported.** Google Chat message upserts now use the same `IS DISTINCT FROM` guard. |
| #1422 omit default upload comments | Slack uploads only include an explicit comment. | **Already equivalent.** Google Chat uploads only send the optional `--text` caption. |
| #1412 use the MCP user token for search | Slack native search uses the linked user token and falls back to authorized bot history only for bot-token rejection. | **Already equivalent.** Google Chat search is an exact-space bounded scan; delegated readers are selected and signed server-side. |
| #1443 retry transient Slack sync failures | The Console Slack DM job defers Slack `fatal_error` and `internal_error` responses. | **Already equivalent.** Google Chat ETL retries rate limits and transient HTTP failures in its bounded client. |
| #1441 and #1408 channel catalog resilience and autocomplete | Console caches and searches the Slack channel catalog. | **Not applicable.** Google Chat grants use exact `spaces/<id>` names and have no Console catalog job, as recorded in the previous sync window. |
| #1401 custom workflow Slack identity | Workflow Slack messages may set `username` and `icon_emoji`. | **Not applicable.** Google Chat app messages cannot override the app identity per message. |
| #1152, #1145, and #628 Slack API/emulator, DM scope, and ETL-token fixes | Slack-only SDK and credential behavior. | **Not applicable.** Google Chat uses its own signed fixtures, exact-email DWD DM setup, and scoped Console JWT proxy. |

The remaining commits are platform-agnostic and merge without a Google Chat
transport port.

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
