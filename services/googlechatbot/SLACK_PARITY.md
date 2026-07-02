# Google Chat ↔ Slack parity audit

Audit of `services/googlechatbot` (+ its platform surface) against `services/slackbotv2`
(+ its platform surface), taken on 2026-07-02 against `sync/upstream-2026-07-02`
(post-merge of paradigmxyz/centaur `main`, 26 commits including the Slack attachment,
model-override-persistence, and activity-summary work).

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
| 1.8 | Stop/interrupt, reactions, slash-command handlers, interactive actions | None (adapter parses reactions/actions; no handlers) | None (client supports reactions; no handlers). Chat slash commands *are* accepted as mentions | 🟰 equal (neither implements controls); Chat's slash-command-as-mention is a superset |
| 1.9 | Sender gating | External-org allowlist + trigger-bot allowlist | Email-domain allowlist + self-message filter | 🟰 platform-equivalent gating (Chat has no Slack-Connect / cross-org concept) |
| 1.10 | Late file repair (Slack Connect delayed `file_share`) | 15s window, synthetic follow-up turn | N/A | 🟰 Slack-Connect-specific quirk; Chat delivers attachments atomically |
| 1.11 | Thread history context | First execution forwards Chat-SDK history; thread replies refresh from `conversations.replies` | Every mention fetches thread siblings via `spaces.messages.list` (cap 50), injection-guarded | 🟰 equivalent (Chat's is arguably fresher); cap noted |
| 1.12 | Plain-text-only escape hatch | Prompt phrases (`plain text only`…) skip streaming, single plain post | Card-vs-text heuristic only | ✅ same prompt phrases now force the plain-text surface (no card) |
| 1.13 | Session titles | Assistant thread title from prompt + `renderer.title.update` | N/A — Chat has no thread-title API | 🟰 no platform surface |
| 1.14 | Metrics depth | ~15 metric families (webhooks, forwards, renders, recovery, session-API ops, delivery status) | 3 counters (events, runs, resumes) | ✅ added session-API operation counters + delivery-outcome counter; full render-recovery families 🔜 with 1.6 |
| 1.15 | Outbound post surface for workflows | None on the bot — api-rs posts straight to `chat.postMessage` with the bot token | `/api/chat/messages` CRUD guarded by `CHATBOT_API_KEY`; api-rs relays | 🟰 deliberate: keeps the Google SA credential in one place; Chat's model is strictly safer |
| 1.16 | Agent file-upload destination context | "Slack Session Context" block (team/channel/thread_ts + `slack upload` example) | No upload path at all (`uploadAttachment` client method unused; google_chat tool has no upload) | 🔜 needs a `google_chat upload` tool command + context block |
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
| 2.14 | Agent comms tool | `slack` CLI ~26 commands incl. `health`, search, upload | `google_chat` CLI 4 commands (send/list/update/delete), no health | 🔜 at minimum `health` + `upload`; ties into 1.16 |
| 2.15 | `centaur_investigator` thread-key resolution | `slack:` keys resolvable | `chat:spaces:` form not generated | ✅ added candidate form |
| 2.16 | `centaur_sdk` helper | `current_slack_thread()` | none | ✅ `current_google_chat_space()` |
| 2.17 | Demo workflow / delivery derivation | `tool_and_slack` workflow, `slack_channel` delivery objects | none | 🔜 low value; skip unless needed |
| 2.18 | Principal model | channel + per-user DM principals (`slack-user-*`) | space principals only (DM space = space principal) | 🟰 documented mirror (`principal.rs`); per-user Chat DM principal 🔜 if per-user grants are ever needed |
| 2.19 | Dev tooling | `run-centaur-dev` skill (app manifest, funnel), signed-webhook QA script | none | 🔜 |

## 3. Follow-up queue (ordered)

1. **State store for the bot** — unlocks 1.4 (sticky model overrides), 1.6 (crash-safe
   render obligations), cross-replica dedup. Recommended: reuse `@chat-adapter/state-pg`
   pattern or persist overrides in api-rs session metadata.
2. **`google_chat upload` tool command + Session Context block** (1.16, 2.14) so agents
   can deliver files into the thread like they do on Slack.
3. **Backfill workflow + ETL metrics module** (2.8, 2.9).
4. **Docs page for Google Chat setup/ETL** (2.13).
5. **Dev/QA tooling** (2.19).
