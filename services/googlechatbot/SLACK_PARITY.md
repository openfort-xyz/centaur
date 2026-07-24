# Google Chat ↔ Slack parity audit

Audit of `services/googlechatbot` (+ its platform surface) against `services/slackbotv2`
(+ its platform surface), taken on 2026-07-02 against `sync/upstream-2026-07-02`
(post-merge of paradigmxyz/centaur `main`, 26 commits including the Slack attachment,
model-override-persistence, and activity-summary work).

**Update 2026-07-04 (`sync/upstream-2026-07-04`, 24 upstream commits):** new
Slack-touching upstream work and its Chat disposition — see section 3.

Openfort runs both bots in production (centaur-vps), but Google Chat is the primary
surface. Goal: functionally and internally head-to-head — every difference is either
fixed, tracked as follow-up, or recorded as a deliberate platform difference.

Legend: ✅ fixed in this pass · 🔜 follow-up (tracked, out of scope here) ·
🟰 deliberate difference (platform constraint or design choice — no action).

## 1. Bot service (`services/googlechatbot` vs `services/slackbotv2`)

| # | Area | Slack (slackbotv2) | Google Chat (googlechatbot) | Status |
|---|------|--------------------|------------------------------|--------|
| 1.1 | Inbound file/image attachments | Chat-SDK attachments + raw `files[]` materialized, inline base64 (100MB cap), staged `attachment.chunk` lines >900KB, `[Slack attachment: …]` fallback text | `message.attachment` never read in `normalize.ts`; downstream plumbing (`NormalizedBinaryPart` → data-URL image blocks / placeholder text) exists but dead | ✅ normalize now reads `message.attachment`, downloads via the Chat media API, inlines up to 25 MB (same session-api plumbing); Drive files → placeholder (no Drive scope). `attachment.chunk` staging for bigger files 🔜 |
| 1.2 | Activity summaries → live status | `session.activity_summary` SSE events drive assistant status (`SLACKBOTV2_ACTIVITY_SUMMARY_STATUS_ENABLED`) | SSE parser dropped `session.activity_summary`; status pulses only from renderer status events | ✅ activity summaries now feed the 1 Hz status-pulse line |
| 1.3 | Requester context for the agent | "Requester Context" block: Slack IDs, display name, GitHub handle from profile, PR-attribution rules | Only `user_id`/`user_name` in metadata; no context block, no attribution rules | ✅ Requester Context block (name, email, attribution-by-display-name rule); GitHub handle N/A — Chat profiles carry no custom fields (🟰 that part) |
| 1.4 | Sticky per-thread model/provider overrides | Persisted in Postgres thread state (upstream #831); harness/model/provider sticky, reasoning per-turn | Harness sticky via session creation; model/provider per-turn only — bot is stateless (no DB) | 🔜 needs a state story (api-rs session metadata or a small PG state); tracked below |
| 1.5 | Streaming render | Progressive Slack streaming, plan/task cards, conflation, segment rotation, divergence reconcile | Single ack message PATCHed once with final answer; 1 Hz status pulses | 🟰 Chat has no streaming primitive and rate-limits edits (1 write/s/space); single-write render is the correct Chat idiom |
| 1.6 | Crash-safe render recovery | Durable render obligations in PG + startup sweep + lease | In-process SSE resume (≤3 passes) + PATCH→fresh-message fallback; nothing survives a bot restart | 🔜 same state-store dependency as 1.4 |
| 1.7 | Webhook retry semantics | 503 + dedupe-key clearing to trigger Slack's redelivery; execute idempotency keys | Sync `{}` ACK then background processing (Google requires a fast sync ACK; Chat does not redeliver on 5xx the way Slack does); execute idempotency keys present | 🟰 platform contract difference; idempotency parity exists |
| 1.8 | Stop/interrupt, reactions, slash-command handlers, interactive actions | `stop-command.ts` mention detector → `POST /interrupt` (#911/#915); reactions/actions parsed, no handlers | ✅ same detector (`stop-command.ts`, pattern byte-identical) → same interrupt route; checked before the ack so no stranded placeholder. Reactions/interactive actions still unhandled on both surfaces | ✅ stop/interrupt at parity; Chat's slash-command-as-mention is a superset |
| 1.9 | Sender gating | External-org allowlist + trigger-bot allowlist | Email-domain allowlist + self-message filter | 🟰 platform-equivalent gating (Chat has no Slack-Connect / cross-org concept) |
| 1.10 | Late file repair (Slack Connect delayed `file_share`) | 15s window, synthetic follow-up turn | N/A | 🟰 Slack-Connect-specific quirk; Chat delivers attachments atomically |
| 1.11 | Thread history context | First execution forwards Chat-SDK history; thread replies refresh from `conversations.replies` **and embed the transcript in the execute input line** (`contextMessages` in `codexInputContent`) | Every mention fetches thread siblings via `spaces.messages.list` (cap 50), injection-guarded — but the history was only *appended* to the session store (Console-only; never reaches the harness input), so any follow-up after a sandbox swap (pool drain/reap) started from amnesia and the agent's Chat-API fallback 400s in DMs | ✅ "Google Chat Thread Context" block now rides every execute input (24k-char newest-biased cap), matching slackbotv2's per-turn thread context |
| 1.12 | Plain-text-only escape hatch | Prompt phrases (`plain text only`…) skip streaming, single plain post | Card-vs-text heuristic only | ✅ same prompt phrases now force the plain-text surface (no card) |
| 1.13 | Session titles | Assistant thread title from prompt + `renderer.title.update` | N/A — Chat has no thread-title API | 🟰 no platform surface |
| 1.14 | Metrics depth | ~15 metric families (webhooks, forwards, renders, recovery, session-API ops, delivery status) | 3 counters (events, runs, resumes) | ✅ added session-API operation counters + delivery-outcome counter; full render-recovery families 🔜 with 1.6 |
| 1.15 | Outbound post surface for workflows | None on the bot — api-rs posts straight to `chat.postMessage` with the bot token | `/api/chat/messages` CRUD guarded by `CHATBOT_API_KEY`; api-rs relays | 🟰 deliberate: keeps the Google SA credential in one place; Chat's model is strictly safer |
| 1.16 | Agent file uploads into the thread | "Slack Session Context" block (team/channel/thread_ts + `slack upload` example); agent uploads with the bot token | Dead `uploadAttachment` (wrong URL, app-auth token that `media.upload` rejects); no tool command; no context block | ✅ official DWD flow: `GOOGLECHATBOT_UPLOAD_USER` impersonation (`chat.messages.create`), multipart `media.upload` + attachment message, `/api/chat/attachments` relay route, `google-chat upload` tool command, "Google Chat Session Context" block on every turn |
| 1.17 | Rich outbound payloads via workflow relay | `ctx.post_to_slack` supports blocks/unfurl/broadcast/thread_ts | `ctx.post_to_google_chat` supports text + thread_name only | 🟰 Chat cards are bot-rendered; overlay `_openfort_chat.py` handles formatting/chunking/threading client-side |

## 2. Platform surface (api-rs, workflows, chart, console, docs, tools)

| # | Area | Slack | Google Chat | Status |
|---|------|-------|-------------|--------|
| 2.1 | ETL queue routing | `slack_sync`→SlackLive, backfill/archive→EtlBackfill, retention→Etl | `google_chat_retention`→Etl, but **`google_chat_sync` fell through to Standard** | ✅ routed to Etl |
| 2.2 | Chart ETL values | `apiRs.etl.slack.*` (15 env vars rendered + sandbox passthrough) | Nothing — `GOOGLE_CHAT_ETL_ENABLED` must be hand-added via `extraEnv` (as done on centaur-vps) | ✅ `apiRs.etl.googleChat.*` values + apirs.yaml rendering + passthrough |
| 2.3 | values.schema.json | `slackbotv2` present | `googlechatbot` absent | ✅ added |
| 2.4 | Metrics scraping | slackbotv2 template has Prometheus scrape annotations | googlechatbot template has none | ✅ added |
| 2.5 | CI | Dedicated `slackbotv2-tests` job (also discordbot, teamsbot) | googlechatbot tests never run in CI | ✅ added `googlechatbot-tests` job |
| 2.6 | ETL RLS / readonly role | `slack_sync_*` covered by RLS policies + `centaur_readonly` grants (migrations 0016/0019/0021/0023) | `0032` creates `google_chat_sync_*` tables with **no RLS, no readonly grants** | ✅ migration adds RLS + readonly grants mirroring the Slack policies |
| 2.7 | Session-context platform block | api-rs returns `slack` block for `slack:` thread keys; session-runtime injects `platform=slack` context into harness input | `chat:spaces:` keys get no platform context | ✅ `google_chat` block (space/thread) in api-rs session context + runtime injection |
| 2.8 | ETL metrics | `workflows/slack/metrics.py` (rate limits, runs, retention, archive) | None (generic etl_items_* only) | 🔜 add with backfill work (2.9) |
| 2.9 | Backfill workflow | `slack_backfill` (resumable historical cursors, lag metrics) | Bounded first-sync only (`GOOGLE_CHAT_MAX_PAGES_PER_RUN`) | 🔜 |
| 2.10 | Retention workflow | `slack_retention` in-repo | `google_chat_retention` lives in centaur-overlay (deliberate: Openfort-owned ETL) | 🟰 works today; revisit if upstreaming |
| 2.11 | Archive import + DM sync (workflows, admin API, console UI) | Full pipeline | None | 🟰 Slack-export ZIPs and user-token DM scraping have no Google Chat analogue (Chat history comes via the same app-member API the sync already uses; Vault covers compliance export) |
| 2.12 | Console sign-in / OAuth broker | Slack OIDC login + OAuth v2 user-token provider | None Chat-specific (Google OIDC login exists; bot auth is a service account, not a brokered user token) | 🟰 deliberate credential model difference |
| 2.13 | Docs (centaur.run) | Quickstart, config reference, ETL page, permissioning examples | Zero mentions | 🔜 docs pass once feature set settles |
| 2.14 | Agent comms tool | `slack` CLI ~26 commands incl. `health`, search, upload | `google_chat` CLI 4 commands (send/list/update/delete), no health | ✅ `upload` + `health` added; the long tail of Slack-specific commands (search, usergroups, dumps) 🟰 covered by ETL/company-context on the Chat side |
| 2.15 | `centaur_investigator` thread-key resolution | `slack:` keys resolvable | `chat:spaces:` form not generated | ✅ added candidate form |
| 2.16 | `centaur_sdk` helper | `current_slack_thread()` | none | ✅ `current_google_chat_space()` |
| 2.17 | Demo workflow / delivery derivation | `tool_and_slack` workflow, `slack_channel` delivery objects | none | 🔜 low value; skip unless needed |
| 2.18 | Principal model | channel + per-user DM principals (`slack-user-*`) | space principals only (DM space = space principal) | 🟰 documented mirror (`principal.rs`); per-user Chat DM principal 🔜 if per-user grants are ever needed |
| 2.19 | Dev tooling | `run-centaur-dev` skill (app manifest, funnel), signed-webhook QA script | none | 🔜 |

## 3. Follow-up queue (ordered)

1. **State store for the bot** — unlocks 1.4 (sticky model overrides), 1.6 (crash-safe
   render obligations), cross-replica dedup. Recommended: reuse `@chat-adapter/state-pg`
   pattern or persist overrides in api-rs session metadata.
2. **Backfill workflow + ETL metrics module** (2.8, 2.9).
3. **Docs page for Google Chat setup/ETL** (2.13) — including the upload DWD admin grant.
4. **Dev/QA tooling** (2.19).
5. **`attachment.chunk` staging** for inbound files over the 25 MB inline cap (1.1).

## 4. Deploy note: enabling uploads (1.16)

Uploads need a one-time Workspace admin step, per the official Chat docs
(`media.upload` rejects app auth): grant the service account's client ID
domain-wide delegation for `https://www.googleapis.com/auth/chat.messages.create`
(Admin console → Security → API controls → Domain-wide delegation), then set
`googlechatbot.uploadUser` (chart) / `GOOGLECHATBOT_UPLOAD_USER` (env) to the
impersonated user. Until then `/api/chat/attachments` fails closed with a 503
explaining the setup.

## 3. Upstream sync 2026-07-04 (24 commits) — Slack-touching changes

| # | Upstream change | Chat disposition | Status |
|---|-----------------|------------------|--------|
| 3.1 | #843 console threads view + slackbotv2 "Open chat in Console" context block (renamed by #889) | `console-session-link.ts` ported: first assistant message carries an `Open chat in Console · MODEL · Harness` card line (textParagraph, HTML link — Chat has no stop-stream context block). Chart mirrors `CENTAUR_CONSOLE_PUBLIC_URL` + `CLAUDE_MODEL`/`CODEX_MODEL` like slackbotv2. First-message detection = empty thread history (bot is stateless). | ✅ |
| 3.2 | #875 console Slack thread visibility for Slack SSO identities | Chat threads were invisible in the threads view. Added `googlechat_thread_owner_sql`: googlechatbot now records the requester's workspace email (`user_email`, from `sender.email`/envelope `user.email`) in session+message metadata; console matches it against the signed-in (Google SSO) user's email directly — simpler than Slack's identity mapping because console logins ARE Google identities. | ✅ |
| 3.3 | #882 restore Slack DM context visibility (slack_team_id metadata → iron-control; Slack-DM ETL tables in company_context) | No Chat analogue needed: gchat principals derive wholly from the thread key (space id — `parse_gchat_space`), so no metadata is required to scope them; and there is no Chat DM ETL (DMs are deliberately excluded from the shared corpus, `DEFAULT_INCLUDE_SPACE_TYPES = "SPACE"`). Chat DM ETL with per-user consent (the analogue of upstream's Slack-DM sync subsystem) would be new feature work. | 🟰 / 🔜 (DM ETL) |
| 3.4 | #887 capture Slack app message content (attachment fallback) + unfreeze busy-channel ETL sync | Ported both applicable halves to `workflows/google_chat/sync.py`: `_message_text` falls back to `cardsV2` widget text (Chat apps post empty `text` + cards — same failure as Slack's attachment-only app posts), and the sync watermark never regresses below the pre-run checkpoint. The head-probe/continuation-job halves are Slack-pagination-specific (oldest-anchored windows); Chat pages `createTime asc` with a token cursor and cannot freeze that way. Backfill job queue remains 🔜 (2.9). | ✅ |
| 3.5 | #884 gate sandbox API access by capability (tool-side: slack/feedback.py, gsuite/client.py) | Gating lives in shared code (centaur_sdk `save_attachment`, gsuite client — both merged in). The Slack feedback tool has no Chat analogue, and `tools/comms/google_chat` talks to the googlechatbot relay, not the sandbox API server. Nothing to port. | 🟰 |

## 4. Upstream sync 2026-07-09 (65 commits) — Slack-touching changes

Structural note for this window: upstream's new Slack read/write tooling (#961/#1001)
routes history and files through an **api-rs Slack proxy** (`slack_proxy.rs`) gated by
per-channel JWT capabilities (#971/#973). The Chat side deliberately has **no api-rs
chat proxy** — `tools/comms/google_chat` reads/uploads **directly against
`chat.googleapis.com`** and lets iron-proxy MITM-inject the SA credential at the edge
(`client.py` `list_messages` / `upload_attachment`). So Slack's history (`list_messages`)
and upload (`upload`, from 1.16) parity already exists via a different transport, and the
proxy + JWT-capability machinery has no Chat analogue by design.

| # | Upstream change (PR) | Chat disposition | Status |
|---|----------------------|------------------|--------|
| 4.1 | #942 Add Meta model support (`--meta` → `{provider:'responses',harnessType:'codex'}` in slackbotv2 `overrides.ts`; shared `args.rs` `META_AI_API_KEY`, iron-proxy `meta-ai` fragment, `harness/codex/config.toml` all merged) | Ported the one-line `meta` entry to `googlechatbot/src/overrides.ts` `PROVIDER_FLAGS` + doc + tests. `session-api.ts` already forwards `provider` on the execute line (same path `--bedrock` uses), so no api-rs/chart change — only the `META_AI_API_KEY` secret must be provisioned on centaur-vps. | ✅ port |
| 4.2 | #900 handle newline after model override (new `MODEL_VALUE_SEPARATOR`/`FLAG_VALUE_BOUNDARY` regexes + newline/`<br>`-stripping `stripMatch` in slackbotv2 `overrides.ts`) | Ported verbatim to `googlechatbot/src/overrides.ts` (its parser mirrored the pre-#900 form and mis-stripped `--model x⏎prompt`). `<br>` clause is inert on Chat (normalize emits `\n`) but kept for byte-parity. Tests added. | ✅ port |
| 4.3 | #1001 proxy Slack history and files (`slack_proxy.rs` + `channel-proxy`/`upload-proxy`/`download-proxy` CLI) | History (`list_messages`) and upload (`upload`) parity already exist via direct `chat.googleapis.com` + edge injection (deliberate transport difference). Only gap: a `download` command for a Chat attachment by resource name — inbound attachments already reach the agent via session context (1.1/1.11). | 🟰 / 🔜 (attachment download cmd) |
| 4.4 | #961 add Slack file proxy API · #1002 proxy sandbox api traffic · #973 slack client jwt on healthz · #971 API server JWTs for sandbox proxy sync | api-rs Slack proxy + JWT-capability machinery: no Chat analogue by design (Chat uses no held token / no api-rs chat proxy). #1002 sandbox-networking is shared infra, applies to both. | 🟰 |
| 4.5 | #981 resolve user IDs/@usernames to DM channels in Slack read paths | Slack-specific (`conversations.open`); Chat `list_messages` takes a space resource name directly and app-auth can't read DM spaces. No analogue. | 🟰 |
| 4.6 | #986 index private Slack channels behind flag (`SLACK_SYNC_INDEX_PRIVATE_CHANNELS`, migration `0038→0040`) | Chat ETL already gates space inclusion by type (`GOOGLE_CHAT_INCLUDE_SPACE_TYPES`, default `SPACE`); the private-channel concept maps to space types, already configurable. RLS test merged to keep google_chat coverage + adopt the public/private `visible_rows` model. | 🟰 |
| 4.7 | #911 / #915 / #970 interrupt process through slackbot stop + stop-command detection | harness-server interrupt primitive is shared/merged; Chat stop-command detector + `/interrupt` call wired post-sync (`stop-command.ts`, `interruptSessionExecution`), updating parity 1.8. | ✅ (ported post-sync) |
| 4.8 | #920 release session event stream connections after terminal events · #916 gauge open stream connections | Server-side runtime fix (`centaur-session-runtime`) is shared/merged and benefits Chat; bot-side SSE release + open-stream gauge could be mirrored in `googlechatbot/session-api.ts`. | 🟰 (runtime) / 🔜 (bot mirror) |
| 4.9 | #931 / #935 retry retryable handoff failures in-process | Tied to Slack's redelivery model; Chat already does post-ACK background processing (parity 1.7). Console snapshot half is shared/merged. | 🟰 / 🔜 (resilience) |
| 4.10 | #924 preserve paragraph breaks in Slack plain-text extraction (`@chat-adapter/slack` patch) | Slack-adapter-specific; Chat has its own `normalize.ts` and does not use `@chat-adapter/slack`. | 🟰 |
| 4.11 | #982 wire slack bot token into api-rs chart · #983+#985 scoped slack search proxy (added+reverted) | Chart token wiring feeds the api-rs Slack proxy (Chat uses edge injection, no held token). #983 reverted by #985 — nothing lands. | 🟰 |
| 4.12 | #994 granola MCP backend · #956 GitHub client/githubbot · #955/#957 allium MCP rename · #932/#937/#938/#941/#964/#965/#966 console Integrations + OAuth (Granola/Linear/Attio) | Cross-surface tools/services and console/infra, not a Slack↔Chat parity axis; usable from either bot's sandboxes unchanged. Console OAuth broker stays 🟰 (2.12 — Chat uses a service account). | 🟰 (N/A) |

### Merge-mechanics note (not a parity item)

Migrations collided: the fork's already-applied `0036_google_chat_sync_tables` /
`0037_google_chat_context_rls` (prod `_sqlx_migrations` has 36/37 as google_chat) vs
upstream's new `0036`/`0037`/`0038`. Resolution: renumber the **incoming upstream**
migrations to `0038_readonly_all_workflow_queues` / `0039_session_sandbox_repo_cache_access`
/ `0040_slack_private_channels` (never the fork's applied ones, which would break checksum
reconciliation). Harness completion: adopted upstream's `terminal_assistant_stop_settle`
(2s) settle-window over the fork's result-only stance (fixes hung turns without
reintroducing empty follow-ups), preserving the fork's `accumulate_turn_usage`.

### Follow-up queue additions (this sync)

6. ~~**Chat stop/interrupt controls** (4.7)~~ — done: `stop-command.ts` detector (pattern
   shared with slackbotv2) + `interruptSessionExecution` → `POST /api/session/{key}/interrupt`,
   wired before the ack in `processChatEvent`; parity 1.8 updated.
7. **Attachment `download` tool command** (4.3) — fetch a Chat attachment by resource name
   via edge-injected direct API.
8. **Bot-side SSE release + open-stream gauge** (4.8) — mirror in `googlechatbot/session-api.ts`.

## 5. Upstream sync 2026-07-11 (27 commits, `503aa4cd..38f10c3`) — Slack-touching dispositions

| # | Upstream change | Chat surface | Status |
|---|-----------------|--------------|--------|
| 5.1 | #1027 `--rsn max` (GPT-5.6 max Codex reasoning) + harness support | Ported: `max: 'max'` in `googlechatbot/src/overrides.ts` + test (pattern parity with slackbotv2). | ✅ |
| 5.2 | #1009 / #1023 / #1025 / #1029 Slack file/thread/channel/member tools default to api-rs proxy routes | Slack transport family: Chat tools go direct to `chat.googleapis.com` with iron-proxy edge injection (parity 4.4). No held-token problem to solve on Chat. | 🟰 |
| 5.3 | #1010 / #1011 / #1013 / #1017 / #1022 / #1032 Slack identity → principal/DM permission chain | Slack-SSO/identity plumbing in api-rs+console. Chat records `user_email` in session metadata for Console visibility (parity §875 analogue); a Chat-identity permission chain would be its own feature, not a port. | 🟰 |
| 5.4 | #987 Granola sync · #4c0b8e7/#1031 Attio sync (migrations 0040-0042 upstream → 0041-0043 fork) | Platform workflows, surface-agnostic; inert until GRANOLA/ATTIO credentials exist in the vault. Migration renumber per fork convention. | 🟰 |
| 5.5 | #1020 grace executions awaiting sandbox assignment · #1012 stale api-rs build artifacts · #1015 drop nonexistent co-author · #944 Datadog proxy headers | Shared runtime/build/sandbox fixes; benefit both surfaces on merge, nothing bot-side to port. | 🟰 (shared) |
| 5.6 | #1005 / #1016 Codex default → `gpt-5.6-sol` | Harness config, shared; Chat `--codex` runs pick it up automatically. | 🟰 (shared) |
| 5.7 | #980 / #1026 console PWA · #1006 / #1007 MPP discovery | Console/platform features, no bot surface. | 🟰 |

Merge mechanics: 3 conflicts (Justfile / publish-images.yml service-list unions
keeping googlechatbot alongside new githubbot+linearbot; AGENTS.md rewritten
upstream — taken wholesale, the fork's one-line google_chat_sync table entry had
no surviving home). Incoming migrations renumbered 0041-0043 (fork's applied
0040_slack_private_channels keeps its slot).

## 6. Upstream sync 2026-07-18 (63 commits, `origin/main..upstream/main`) — Slack-touching dispositions

This was a full merge (all 63 commits), not a scoped cherry-pick: one merge-blocking gap
found and fixed, plus every Slack-only feature in the range ported to Chat so the fork
does not regress parity by merging.

| # | Upstream change (PR) | Chat disposition | Status |
|---|----------------------|------------------|--------|
| 6.1 | #704 Make the chat agent platform-aware (Slack/Discord/Linear/Github) — adds `ChatDestination` (api-rs `centaur-session-core`), platform-tagged session context, and free-function removal in `centaur-api-server`/`centaur-session-runtime` | **Not conflict-flagged** — the file merged cleanly with zero Google Chat awareness (upstream added Discord/Linear/GitHub variants but never a Chat one, since Chat doesn't exist upstream). Would have silently dropped Chat's platform/session-context block on merge. Added `ChatDestination::GoogleChat { space_name, thread_name }`, its `platform()`/`context_line()`/`chat_destination()` arms, and a parsing test in `centaur-session-core`; threaded through `centaur-api-server` (`SessionContextResponse.google_chat` field, 5-tuple match) and `centaur-session-runtime` (`session_context_for_thread` match arm, test). This is the merge-blocking item flagged before scoping this PR. | ✅ |
| 6.2 | #1096 Add LLM message override strategy (slackbotv2 `message-overrides-strategy.ts`: OpenAI-backed natural-language flag extraction, `GOOGLECHATBOT`-equivalent config, `flags`/`llm` strategy switch) | Ported as `googlechatbot/src/message-overrides-strategy.ts` (`createFlagMessageOverridesStrategy`/`createOpenAiMessageOverridesStrategy`/`messageOverridesStrategyFromConfig`, memoized) + `GOOGLECHATBOT_MESSAGE_OVERRIDES_STRATEGY`/`_OPENAI_API_KEY`/`_OPENAI_BASE_URL`/`_MODEL`/`_TIMEOUT_MS`/`_MAX_OUTPUT_TOKENS` config. `overrides.ts` refactored (`MessageOverrides` → `HarnessOverrides` + `cleanedText`) so both the flag-parser and LLM paths share one shape. 7 tests (`message-overrides-strategy.test.ts`). | ✅ port |
| 6.3 | #1075 Default model and reasoning effort per Slack channel (`slackbotv2` channel-defaults: per-channel `harness`/`model`/`provider`/`reasoning` below the deployment default, above per-message overrides) | Ported as `googlechatbot/src/space-defaults.ts` (`parseSpaceDefaults`/`spaceIdFromThreadId`/`resolveSpaceDefault`/`spaceDefaultsFromConfig`) + `GOOGLECHATBOT_SPACE_DEFAULTS` config (JSON keyed by space id, parsed from `chat:spaces:<id>:...` thread keys). `index.ts`'s `driveSession` now resolves `overrides ?? spaceDefault ?? config default` for harness/model/provider/reasoning, same precedence chain as Slack's channel defaults. 10 tests (`space-defaults.test.ts`). Note (1.4 still applies): this precedence is per-turn from static config, not the sticky-in-Postgres persistence Slack has — that gap is unchanged by this port. | ✅ port |
| 6.4 | #1110 Dispatch Slack Block Kit actions (`slackbotv2` `chat.onAction` → lease-deduped `POST /api/workflows/events` as `slack.block_action.<action_id>`) | Ported best-effort as Google Chat `CARD_CLICKED` dispatch: `googlechatbot/src/index.ts` now special-cases `envelope.type === 'CARD_CLICKED'` **before** `normalizeChatEnvelope` (which deliberately nulls out that type — no command-aware workflow path exists yet, see its inline comment) and calls `emitWorkflowEvent(config, 'google_chat.card_click.<invokedFunction>', payload)` via the new `googleChatCardClickPayload()`/`handleCardClick()`. No separate per-click lease was added (unlike Slack's `state.setIfNotExists`): the existing top-level `EventDeduper`/`chatDedupKey` (keyed on `eventTime`+`spaceName`+`messageName`) already runs on every inbound webhook before dispatch, which covers redelivery the same way. **⚠️ Unverified**: the `event.common.invokedFunction`/`event.common.parameters` wire shape for `CARD_CLICKED` (added to `GoogleChatEnvelope.common`) is taken from Google's REST reference docs, not exercised against a live Chat backend anywhere in this codebase — nothing in `googlechatbot` currently sends a `cardsV2` button whose `onClick.action.function` would trigger this path, so there is no existing card in production to click. **Needs a manual smoke test against a real Google Chat card button before this is relied upon** (post-deploy: post a message with a button card, click it, confirm `google_chat.card_click.*` lands in workflow events with the expected fields). | ✅ port (best-effort, unverified) |
| 6.5 | #1051 scoped trigger bot IDs · #1043 resolve trigger bot identities · #1048 trigger on rich message mentions · #1061 fall back to direct Slack threads · #1088 non-rotating Slack OAuth tokens · #1079 ingest private Slack channels from OAuth | All Slack-transport-specific: trigger-bot allowlisting and rich-mention detection are text/event-shape quirks of the Slack Events API that Chat's envelope-typed `normalizeChatEnvelope` doesn't share (1.9); OAuth-token rotation and private-channel-via-OAuth ingestion are Slack App OAuth concepts with no Chat analogue (Chat bot auth is a service account, 2.12; space-type inclusion already covers the private/public axis, 4.6). No functional gap on the Chat side. | 🟰 |
| 6.6 | #1093 label Slack principal kinds · #1092 label Slack DM principals with email | Cosmetic principal-display fixes in Slack's admin/console surfaces. Chat DM principals already carry `user_email` in session metadata (3.2); no equivalent display gap identified. | 🟰 |
| 6.7 | #1085 show Codex effort/speed in slackbotv2 · #1095 hide Codex effort/speed (slackbotv2 Block Kit UI toggle) | Slack-specific Block Kit rendering of harness metadata. Chat's card renderer has no equivalent status line for effort/speed today — a real but low-priority gap, not part of the 3 features scoped for this sync. | 🔜 |
| 6.8 | #984/#1047/#1054/#1102 console chat composer + attribution/discovery fixes · #1027/#1005/#1016/#1009/#1023/#1025/#1029/#1010/#1011/#1013/#1017/#1022/#1032/#1101/#1100/#1097/#1094/#1090/#1074/#1072/#1076/#1078/#1083/#1084/#1036/#1039/#1062/#1058/#1059/#1060/#1063/#1073/#1077/#1099/#1106/#1109/#1118/#1119/#1124/#1125/#1126 platform/console/harness/infra work | Platform-agnostic (console, api-rs runtime, sandbox, CI, chart, Airtable/Granola integrations) or Slack-proxy-transport work already dispositioned as 🟰 by the `slack_proxy.rs`-vs-edge-injection note in section 4. Benefits both bots (or console-only) on merge; nothing bot-side to port. | 🟰 (shared/N/A) |

### Merge mechanics note (this sync)

Widest merge to date: 63 commits touching `api-rs` (5 crates), `workflows/`,
`contrib/chart`, and `services/console` Ruby tests, on top of the 3 Chat-only ports
above. Notable conflict resolutions: sqlx migrations renumbered (`0044`-`0046`,
fork's `0043_centaur_readonly_slack_dm_rls` kept in its applied slot); `contrib/chart/templates/networkpolicy.yaml`
kept the fork's googlechatbot+otlpEgress block verbatim (upstream's side was empty);
`workflows/company_context_documents.py` took upstream's new scope-claiming
`handler()` architecture wholesale, then had the Google Chat ETL scope
(`google_chat_thread`) added to it explicitly — the auto-merge produced a version
that would `raise ValueError`/silently no-op for Chat's projection scope if left
unfixed, since upstream's rewrite had no knowledge of that scope either (same class
of gap as 6.1: upstream code that merges clean but is blind to a fork-only surface).
`services/console/test/controllers/console/threads_controller_test.rb` conflict
resolved by keeping both sides' new tests and correctly dropping (not restoring) a
test whose target private method upstream had removed in a console refactor
(coverage already existed via a separate integration test).

### Follow-up queue additions (this sync)

9. **Smoke-test the Card-click port against a live Google Chat backend** (6.4) —
   the `event.common.invokedFunction`/`event.common.parameters` shape is unverified;
   confirm before any workflow depends on `google_chat.card_click.*` events firing.
10. **Codex effort/speed status line for Chat** (6.7) — cosmetic parity gap, low
    priority.

## 7. Upstream sync 2026-07-24 (23 commits, `origin/main..upstream/main`) — Slack-touching dispositions

Full merge (all 23 commits). Three real conflicts, resolved in the merge commit;
Slack-touching feature work ported to Chat below so the fork does not regress parity.

| # | Upstream change (PR) | Chat disposition | Status |
|---|----------------------|------------------|--------|
| 7.1 | #1130 native Nanocodex harness — new `harness-server` harness (`nanocodex.rs`, `nanocodex_subagents.rs`) + `packages/rendering/nanocodex.ts`, plus slackbotv2 wiring to select it (`--nanocodex`, LLM strategy allowed value, "explicit flags first" short-circuit). The harness-server/rendering pieces are surface-agnostic and merged as-is. | Ported the slackbotv2 wiring to `googlechatbot/src/overrides.ts` (`nanocodex` in `HARNESS_FLAGS` + `STRATEGY_HARNESSES`, doc comment) and `message-overrides-strategy.ts` (allowed-harness in `SYSTEM_PROMPT` + schema enum; explicit flags resolved before the OpenAI call so a strict schema/model failure can't discard the selection and flags never leak into the harness prompt — adapted to Chat's flat `MessageOverrides` return shape). 3 tests (`--nanocodex` parse, explicit-flag-before-strategy, LLM-selects-nanocodex). | ✅ port |
| 7.2 | #1133 clarify slackbot claude model selection — adds `claude-opus-4-7`, clarifies the bare-`--claude`→opus / `--claude --model=fable`→fable prompt wording, raises the override timeout 1500ms→2000ms | Ported to `googlechatbot`: `claude-opus-4-7` in `overrides.ts` `STRATEGY_MODEL_HARNESSES` and `message-overrides-strategy.ts` `MODEL_VALUES` + prompt alias; the clarity lines adapted for the Chat surface ("In this Chat bot"); timeout raised to 2000ms. 1 test (strategy selects `claude-opus-4-7`). | ✅ port |
| 7.3 | #1135 preserve pinned thread harness (slackbotv2 `index.ts`: once a thread is pinned via `--claude/--amp/--codex/--nanocodex`, only another explicit flag may move it — a false-positive LLM harness/model/provider inference must not replace it) | Not portable as written: it reads/writes `SlackbotV2ThreadState` — the sticky per-thread harness state persisted in Postgres (#831) that googlechatbot deliberately does not have (stateless bot; harness is sticky only via session creation). Tracked under the existing state-store follow-up (§1.4/1.6). The explicit-flags-first short-circuit ported in 7.1 gives Chat the *deterministic-flag* half of this fix (flags always win over the LLM strategy per turn); only the cross-turn *pinning* half waits on the state store. | 🔜 (state store) |
| 7.4 | #1136 make Nanocodex commentary/subagents explicit · #1137 render Nanocodex commentary as Slack progress | Shared `packages/rendering/nanocodex.ts` changes are surface-agnostic (merged); the Slack-facing half renders Nanocodex commentary as incremental Slack progress updates, which is Slack-streaming specific. Chat is single-write (one ack PATCHed once, no streaming primitive — §1.5), so there is no per-step progress surface to feed. | 🟰 (§1.5) |
| 7.5 | #1157/#1150/#1143 Twitter/X (response handling, quote+retweet lookups, search pagination) · #1142 gsuite full-text Drive search · #1121 surface Granola MCP tool errors · #1141/#1164 per-proxy labels · #1158 proxy labels in pg dsn · #1163 python workflow event waits · #1161 append mounted overlay system prompts · #1165 client-credentials broker refresh · #1162 Codex instruction limit 128 KiB · #1131/#1134 console system-theme option · #1132 redaction word-boundary · #1166/#1168/#1170 dependabot config + dep bumps | Platform-agnostic: tool plugins (`twitter`, `gsuite`, `granola`), api-rs runtime/proxy/broker/workflows, console UI, and dependency/CI hygiene. Benefits both bots (or is console-/tool-only) on merge; nothing bot-side to port. | 🟰 (shared/N/A) |

### Merge mechanics note (this sync)

Three conflicts, all resolved in the merge commit:
- `.github/workflows/ci.yml` — kept the fork's `googlechatbot-tests` allowed-skip
  alongside upstream's new `sandbox-tests` (union).
- `centaur-session-runtime` redaction — the fork and upstream #1132 independently
  fixed the same "redaction mangles `sk-` glued inside a slug like `metamask-`" bug.
  Took upstream's `should_redact_prefixed_token` (more complete: boundary-before +
  token validation + `sk-` length gate), dropping the fork's `is_slug_word_char`
  word-boundary approach. **Behavior delta adopted:** upstream treats `=`/`:`/`/`/`.`
  as token-internal, so a prefixed secret glued directly after a URL-query separator
  (`?key=sk-ant-...`) is no longer redacted by that path — only the env-key path
  catches it when the key name is sensitive. The fork's retained regression test was
  updated to reflect this (comment added), keeping its slug-sparing + bare-token
  assertions.
- `granola/sync_credential_test.rb` — kept both the fork's `parse_meetings` tests
  and upstream #1121's MCP-tool-error test (additive).

