# Google Chat and Slack parity status

Source review date: 2026-10-21. Live evidence remains dated separately in the
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
| Console | Space and DM grants and scheduled destinations. Upstream removed the Console chat UI. | Automated coverage exists; narrow/wide keyboard interaction evidence remains. |
| Session preferences | Model and reasoning overrides follow the shared harness vocabulary. api-rs pins the initial persona, including no persona; a persona-pinned model overrides model/provider selections; unavailable requested personas produce a fallback notice. | Persona, alias, reasoning, Pi, and notice tests cover the October sync. |

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

Google sends no Add-on user token to a standalone HTTP Chat app, and
`requesting_google_scopes` only makes Chat re-send the same event. The bot
resolves the sender of a Google-signed Add-on MESSAGE from `users/<id>` to their
primary email with the People API directory lookup, as
`GOOGLECHATBOT_DIRECTORY_LOOKUP_USER` over domain-wide delegation
(`sender-lookup.ts`, `ChatEdgeClient.lookupSenderEmail`). Slack has no
equivalent: its user identity comes with every event.

Personal grants in shared spaces diverge from Slack because every Chat session
principal is a space, including a 1:1 DM. api-rs binds a per-user
`gchat-user-<email slug>-<sha256[:12]>` principal (kind `gchat_user`) as the requester of every
Chat turn, DM or group, from the allowlisted sender email (Add-on token or
directory lookup) the bot sends on `/execute` as `googlechat_requester_email` with
`googlechat_request_verified`. The Console hoists that principal's hand-granted
non-broker static secrets into the turn's proxy config, which is how a
per-person desktop token follows its owner into a group; Slack, GitHub and
console requesters keep upstream's always-available-wrapper-only hoist. The
gate is `requester.kind = 'gchat_user'` in proxy-sync's
`sql/effective_credentials.sql`.
Because that turn now carries one person's grants, the bot folds a follow-up
into a running turn only from the same verified sender (`fold-guard.ts`); in a
DM everything folds, in a shared space anyone else gets a "still running"
notice and their message is not appended. slackbotv2 folds every follow-up.

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

### 2026-10-21 — 87 upstream commits, `d63acb7b..4bf5d61d`

Fork #194 had already ported #1894, #1814, #1908, #1904, #1742, #1941, #1942,
and #1953 by hand; this merge replaces those copies with upstream's originals,
so slackbotv2 and the shared packages match upstream.

| Upstream change | Google Chat disposition |
| --- | --- |
| Remove the Codex/Nanocodex A/B rollout (#1967) | **Ported.** `GOOGLECHATBOT_CODEX_NANOCODEX_ROLLOUT_PERCENT`, `harness-rollout.ts`, the `harness_assignment` metadata, and the chart value are removed. |
| Personas pin a model or harness (#1966, #1969) | **Ported.** `createSession` reads `persona_model`; a pinned thread sends no model/provider override, recomputes reasoning for the pinned model, and the footer names it. api-rs enforces the pin. |
| Keep replies through deploys (#1999) | **Partly ported.** `googlechatbot.yaml` gains the startup probe. No SIGTERM drain: Chat work is durable and restart recovery replays it. |
| Assistant status after steering (#1963), native Stop button (#1973), remove bot reactions (#2001) | **Platform-specific.** Chat has no assistant status or Stop API, and reaction writes are user-auth only; steering keeps the held acknowledgement bubble. |
| Slack Connect allowlist (#2000, #2006) | **Platform-specific.** Chat admission is the verified domain allowlist and exact space grants. Migration `0060` imports as `0064` (fork offset +4). |
| Admin changes from a DM (#1991, #1994, #1996) | **Not ported.** The gate is `slack_dm` plus the home-workspace channel catalog. A `gchat_dm` branch keyed on the verified `google_email` link is a follow-up. |
| Proxy sync served only by proxy-sync (#1933, #1934) | **Ported.** Rails' snapshot class, warm/prune jobs, and the Rails/Rust parity harness are deleted. The `gchat_user` direct non-broker hoist already lives in `sql/effective_credentials.sql`; `integration_tests.rs` now covers it, and the Chat JWT claim test reads `PrincipalSyncConfig`. |
| token-broker (#1970), Microsoft OAuth (#1924), shared OAuth apps (#1910), company-context Slack/Calendar/import sync, Mercator, dependency and CI updates | **Shared.** Chat's Bun image, `hono`, and type packages follow Slack's bumps by hand because dependabot does not cover `services/googlechatbot`. The new `e2e.yml` and `token-broker-checks` use GitHub-hosted runners; CI, Justfile, and image publishing build both token-broker and googlechatbot. |

### 2026-10-06 — 113 upstream commits, `adb8d2d1..d63acb7b`

| Upstream change | Google Chat disposition |
| --- | --- |
| Pi harness (#1848, #1854), per-turn Claude reasoning (#1801), product-name footers (#1858) | **Ported.** Chat accepts Pi selectors, reports its configured default model, validates Claude/Pi reasoning, and uses the same model display names. Shared harness implementations come from upstream. |
| Per-channel personas (#1841, #1863) | **Ported.** Space defaults accept a validated persona; an initial inline persona takes precedence, and an existing session's pinned persona (including no persona) remains authoritative. Ingress tests check creation and pinned-persona precedence. |
| Skip the override classifier without selector terms (#1829) | **Ported.** Ordinary Chat messages bypass the classifier; explicit selectors and personas retain their behavior. |
| Managed PostgreSQL and opt-in ParadeDB (#1817, #1824) | **Shared/ported.** Chat uses the shared database-egress helper. New search migrations become `0060`, and core migrations `0061`–`0063`; existing fork versions and legacy checksums remain stable. |
| Remove Console chat UI (#1779), caller-supplied e-mail override (#1855), investigator/read-only role (#1891), Slack archive import (#1887), and local sandbox backend | **Shared/ported.** Accept the deletions. Remove the Chat footer link, its configuration, and the deleted-UI redirect expectation. Chat DM RLS tests use indexed source identity rather than the removed e-mail override. |
| Dedicated proxy-sync (#1745, #1813) | **Ported.** The Rust service emits the same Chat JWT claims as Rails, merges direct and role grants, resolves delegated readers, invalidates cached hashes when readers change, and preserves the verified Chat requester's direct non-broker statics. A real Rails/Rust parity test covers grants, revocation, ambiguous readers, and requester isolation. |
| Slack history channel IDs (#1857), unknown privacy (#1740), indexed-search DSN (#1860) | **Already equivalent/platform-specific.** Chat messages carry space-qualified resource names; exact grants and verified space types govern access. Chat search uses a bounded authorized API scan, so it has no indexed-search DSN. Import the shared company-context database helper. |
| Slack late-file repair (#1851) and bot-trigger streaming recipient (#1765) | **Platform-specific.** These handle Slack file webhooks and Slack member-ID streaming. Chat resolves attachments during normalization and uses durable work retries; its renderer edits Chat messages without a Slack streaming recipient. |
| Dependency updates, company-context, sandbox/runtime, skills, docs, and fake-Slack e2e | **Shared/ported.** Import upstream and align Chat's SDK/state adapters (4.40.0), Bun image, and common dependencies with Slack. The new state adapter incorporates the fork's expired-state patch. Retain Chat attachment-integrity dependencies. |
| Replayed output and container compatibility | **Verified/fixed.** A reconnectable socket or stream error no longer contaminates a successful final answer; terminal execution failures and exhausted retries still surface errors. The container check kills a ready, non-terminating replica and checks one final reply after recovery. |
| Depot runners (#1885) | **Fork infrastructure.** Use GitHub-hosted Ubuntu runners so this fork's CI can run. Retain the Chat CI job and image publication. |

This sync also removes earlier fork changes unrelated to Google Chat: private
HTTPS egress exceptions, custom sandbox packages, Attio/Notion and Drive helper
changes, and Slack-specific fixes. The remaining fork changes support Chat or
its shared contracts, migration numbering, documentation, and CI.

### 2026-09-24 — 14 upstream commits, `e8011275..adb8d2d1`

| Upstream | Change | Google Chat disposition |
| --- | --- | --- |
| #1723, #1726 | GPT-6 Sol and Luna model selection, reasoning, pricing, and Codex version | **Ported.** The Chat strategy maps Sol/Luna to GPT-6, accepts both new model IDs, and preserves explicit GPT-5.6 requests. The per-turn reasoning filter accepts the same efforts as Slack. Pricing and the Codex image pin are shared. |
| #1735 | Opus 5.5 default, aliases, pricing, and Claude Code version | **Ported.** Chat's `--opus`, `--model opus`, per-space defaults, and natural-language strategy select `claude-opus-5-5`. Explicit Opus 5 and Opus 5 Fast remain supported. The default metadata reads the shared harness config. |
| #1724, #1732 | Slack direct lookups use user credentials; clarify DM uploads | **Not applicable.** These change Slack-only tools. Chat retains its scoped proxy, exact-space authorization, and server-side delegated credentials. |
| #1702, #1728, #1734 | Workspace file creation destinations, Luma, and Pangram tools | **Shared.** Platform-independent tools, with no Chat transport change. |
| #1729, #1730, #1711, #1712, #1714, #1715 | Kind sandbox CI, chart cleanup, dependency updates | **Shared.** The CI conflict keeps both `sandbox-e2e` and `googlechatbot-tests` in the aggregate check. Chat chart settings remain intact. |

No numbered migrations were added; the fork's existing migration numbering is
unchanged. The local Kind verifier now supplies the required dummy ingress API
key alongside its existing internal key and expects the owned status message
to be patched into the final reply. Local checks include 486 Chat tests, typecheck, signed fixture smoke,
295 Slack tests with one existing skip, 211 changed-tool tests, migration order,
21 Rust telemetry/pricing tests, and the parity ledger checker. These are local
results, not live Workspace or
production rollout evidence.
The built Google Chat image
`sha256:e8efb760927db352faaec3574dbcf4de5526f812ebc1acd4904a074b045dc7de`
also passed `scripts/verify-google-chat-runtime-kind.sh` in a disposable local
Kind cluster: auth/probes, active-turn recovery after killing the processing
pod, one final reply, obligation cleanup, and two healthy replicas.

### 2026-09-21 — 22 upstream commits, `3d6bbcf1..e8011275`

| Upstream | Slack change | Google Chat disposition |
| --- | --- | --- |
| #1705 remove console workflow eligibility checks | The workflow no longer re-reads the task from Console before the agent turn or the root Slack post. | **Ported.** `_deliver_to_google_chat` drops the `post_result` eligibility check added in the 2026-09-17 window; the DM space setup and chunked posting are unchanged. |
| #1707 limit console workflow checkpoints | The `agent_result` step stores only `execution_id` and a truncated `result_text`. | **Shared.** Same `run_agent`, which the Chat branch uses with the Chat prompt. |
| #1690 preapproved session admission | `CENTAUR_SESSION_PRINCIPAL_ADMISSION=preapproved` rejects sessions whose principal does not exist; slackbotv2 reports the denial. | **Shared, default unchanged.** The default is `automatic`. `resolve_session` keeps the fork's `apply_gchat_identity` before the label merge. googlechatbot has no denial message; add one before enabling `preapproved`. |
| #1684, #1694, #1697, #1700 Slack tooling | Slack search routing, MCP guidance, JSON CLI output, file share retries. | **Not applicable.** Slack tool and bot only. |
| #1687, #1689 company context Slack rows | Company context reader can read scoped Slack rows. | **Shared.** Upstream migration `0055_company_context_reader_slack_rows.sql` is renumbered to `0059`; the fork offset becomes **+4** for this file. |

Merge mechanics: three conflicts. `session.rs` keeps `apply_gchat_identity` with upstream's `existing` binding; `console_workflow.py` and its tests take upstream's removal of eligibility checks and keep the Chat delivery branch.

### 2026-09-17 — 31 upstream commits, `3f899945..3d6bbcf1`

| Upstream | Slack change | Google Chat disposition |
| --- | --- | --- |
| #1678 scheduled task eligibility | Tasks may be manual-only (no cron); the workflow re-reads the task from Console before the agent turn and again before the root Slack post, and skips when it is disabled or its delivery channel changed. | **Ported.** `_deliver_to_google_chat` takes the same eligibility check inside its `post_result` step, so a Chat space or DM delivery is skipped the same way. The DM space setup still runs first. Console model and form keep the Chat destination validation next to upstream's manual-only schedule. |
| #1644, #1645 markdown in the durable fallback | The streaming-failure fallback posts and edits CommonMark instead of plain text. | **Not applicable.** Chat has no streaming fallback path; every final answer already goes through the Chat renderer. |
| #1665, #1668, #1669 Slack access paths | The Slack context line tells the agent to use proxied methods in channels and `*-direct` in DMs; public channel history and files are allowed by default. | **Not applicable.** Slack tool and proxy policy only. The Google Chat context line is unchanged. |
| #1675 Slack emoji reaction command | `slack react` adds a reaction. | **Not applicable.** Chat `reactions.create` is user-auth only (no `chat.bot` scope). |
| #1672 proxy access to cluster services | The chart default `ironProxy.upstreamDenyCidrs` drops `10.43.0.0/16`. | **Shared.** centaur-vps sets its own deny list, so the deployed value does not change. The fork keeps `extraHttpsEgressCidrs`. |

Merge mechanics: six conflicts. `console_workflow.py` and the scheduled task model/controller take upstream's eligibility gate and manual-only schedules while keeping the Chat delivery branches; `principal.rb` keeps both the Google Chat labels and upstream's `TOOL_LABEL`; the sandbox prompt keeps the Chat delivery sentence with upstream's manual-only wording; chart values take upstream's deny list plus the fork's `extraHttpsEgressCidrs`. No new numbered SQLx migrations, so the fork offset stays **+4**.

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

### 2026-10-15 — focused parity ports, upstream `d63acb7b..a8078de5`

This is a selective port, not an upstream merge. The upstream ancestry remains
at `d63acb7b`; unrelated changes in this review window are intentionally not
imported. Future syncs must account for the ports below.

| Upstream change | Google Chat disposition |
| --- | --- |
| `4257592b` / paradigmxyz/centaur#1894 enabled-harness routing | **Ported.** `GOOGLECHATBOT_ENABLED_HARNESSES` validates the deployment allowlist. Disabled inline, sticky, and space defaults fall back with model/provider reset; disabled Nanocodex rollout is suppressed. Session creation rejects disabled requests/responses and restarts a disabled conflicting harness. Slack's original fix and tests are included. |
| `80b669b5` / paradigmxyz/centaur#1814 GPT-6.1 Sol | **Ported/shared.** The classifier maps unqualified Sol to `gpt-6.1-sol`, preserving explicit GPT-6 Sol. GPT-6.1 Sol accepts ultra effort. Shared Codex startup binds the first-turn model and the sandbox pins the required CLI. |
| `bf32a635` / paradigmxyz/centaur#1908 source citations | **Shared.** The harness resolves known citations to source links before either platform receives output. Includes upstream recorded protocol tests. |
| `445b3db0` / paradigmxyz/centaur#1904 unresolved citations | **Ported.** Final Google Chat payloads strip unresolved native markers, including recovery payloads, while preserving resolved links. Google Chat has no text-delta delivery surface; filtering occurs before final text/card construction. |
| `5e149b8a` / paradigmxyz/centaur#1742 OMP harness | **Ported/shared.** Import the shared OMP backend, API/runtime registration, credential-placeholder mapping, pinned CLI, persistent state, and upstream protocol fixtures. Google Chat adds `--omp`, classifier vocabulary, Pi-compatible effort validation, the OMP label, and `CENTAUR_OMP_MODEL` chart mirroring. Chart patch version `0.1.164` is required by CI for the model-mirroring template changes. |
| `e22ead21` / paradigmxyz/centaur#1941 paragraph boundaries | **Shared.** Both transports use the corrected shared renderer: separate answer items retain a blank line; token deltas within an item still concatenate. |
| `5747367a` / paradigmxyz/centaur#1942 recovery leases | **Already equivalent.** Google Chat's `processWorkObligation` holds a periodically renewed lease until its `finally` block, without detaching work on a sweep deadline. A regression test holds it past its original TTL. Import the Slack fix separately to retain the upstream reference behavior. This does not resolve the separately documented atomic-lease or pending-index findings. |
| `9c77fc42` / paradigmxyz/centaur#1953 Codex child-agent notifications | **Shared.** Child-thread notifications cannot contaminate the root answer; upstream fixtures exercise the shared harness path. |

Excluded from this focused port: company-context v2 ingestion/query/rollout work,
Mercator onboarding, unrelated OAuth and credential-conflict changes, sandbox
checkout/reaping fixes, generic proxy changes, dependency sweeps, workflow
removal, and CI action upgrades. These may be considered in a later general
upstream sync; their omission is not a claim that the fork is fully synced.

Local validation: both ingress typechecks; 512 Google Chat tests including
state tests against disposable PostgreSQL; signed Google Chat fixtures; 302
Slack tests (one pre-existing skip); 45 shared renderer tests; Helm lint and
rendering of OMP model mirroring; and the parity ledger. Rust checks, image
builds, and Kind validation were not run locally because their toolchains are
unavailable. Payload previews demonstrate paragraph/citation output, not live
Workspace or same-release certification.

## Rollback

Disable ingress or the googlechatbot workload; disable both shared and DM ETL;
revoke DWD scopes; remove Console grants; and roll workloads back with Helm.
Never leave the public endpoint enabled by turning signature verification off.
The new database objects are additive and should remain through application
rollback until no deployed binary references them.
