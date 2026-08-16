# Google Chat parity verification ledger

Plan: `plan/feature-google-chat-slack-parity-1.md`

Baseline commit: `e143b10ff0a5850b73b6e82f412686de75229fdc`

This ledger tracks evidence for Google Chat outcome-level parity. Status has a
strict evidence meaning:

- **Passed** — the complete named verification passed against the immutable
  40-character commit SHA or `sha256:` image digest recorded in `Commit`.
- **Verified-local** — the command passed on the current working tree. This is
  useful engineering evidence, but the tree is mutable and it is not release
  evidence.
- **Provisional** — automated checks or an earlier local snapshot support the
  result, but the full verification was not rerun on the current immutable
  release candidate, or required live/browser evidence is still absent.
- **Pending**, **Failed**, or **Blocked** — respectively not yet run, run and
  failed, or unable to run because a named dependency is unavailable.

`TEST-031` may be `Passed` only when `TEST-001` through `TEST-030` are `Passed`
on the same immutable commit or image evidence. A working-tree result can never
be promoted to `Passed`.

## Accepted platform-specific exclusions

- **CON-001**: Do not implement Slack user groups, Slack Connect administration, Block Kit, App Home, Google Add-on `widgetUpdatedPayload` suggestions, dialog UI responses, link previews, assistant thread titles, Slack archive ZIP import, public/private-channel terminology, pins, bookmarks, reminders, canvases, calls, huddles, scheduled messages, or ephemeral messages. These are platform-specific or absent from both Centaur integrations; recognizing an event enum for safe logging does not implement it.
- **CON-002**: Do not add a Google Workspace global user directory. Space membership lookup and explicit email-only DM setup provide the required Chat outcome without the broad Admin SDK Directory scope.

## Evidence classes

- **Official contract**: audited 2026-08-14 against Google Chat REST discovery
  revision `20260809` and the linked Google documentation in
  `docs/google-chat-official-spec-conformance.md`.
- **Automated**: local deterministic tests validate code behavior, but do not
  prove Google accepted the request or scope.
- **Live legacy**: the read-only Centaur VPS audit observed deployed image
  `sha-980e5e3b`, not this working tree. It confirms only retained legacy
  list/create/session/health behavior and contains no raw payloads.
- **Live current-branch infrastructure**: candidate `04065be1` ran on
  `centaur-vps` as native amd64 images in the isolated
  `centaur-gchat-parity-canary` release. This proves deployment, state,
  health, internal authentication, policy isolation, and replica replacement;
  it does not prove Google-controlled wire formats or tenant authorization.
- **Live current-release Workspace**: production release `c8f1df8…` and VPS
  GitOps release `6f55ddea…` now prove DWD setup/history/mutations, attachment
  upload/download, reactions, Drive export, and shared/DM ETL. Google-signed
  ingress is still unproved because a real Chat UI interaction could not be
  performed without an available signed-in browser.

## 2026-08-14 centaur-vps canary result

Candidate application commit: `04065be1163943f50880083a4ff135cf93cc78f9`.
Production control commit: `bb37a15396bcc2e823b95ea26c523be993bf167d`.

- Built and ran native amd64 candidate images pinned by `tag@sha256` for
  googlechatbot, api-rs, Console, sandbox agent, and iron-proxy. OCI revision,
  rendered spec, and K3s runtime image IDs matched the candidate evidence.
- Two bot replicas became Ready with connected PostgreSQL state. Live and ready
  probes, metrics, internal API `401/401/400` behavior, and replacement of a
  deleted replica all passed.
- The exact googlechatbot image passed 426 tests and type-checking on the VPS;
  the exact agent image passed all 38 Google Chat CLI/client tests.
- Live policy probes passed: bot and workflow traffic reached PostgreSQL,
  api-rs reached the bot, and sandbox traffic was denied to both PostgreSQL and
  the bot.
- A 300-second production guard observed no readiness loss, restart increase,
  or Google Chat rejection/failure counter increase. Cleanup removed the
  canary release, namespace, PVCs, test pods, and exact candidate images.
  Protected production snapshots before and after cleanup were identical;
  only the expected rotation of completed two-minute reaper CronJob pods was
  excluded.
- The run found and fixed one product defect: the shared NetworkPolicy omitted
  googlechatbot on both sides of its PostgreSQL connection. It also fixed VPS
  verifier assumptions about Ruby availability, dynamic sandbox repository
  mounts, StatefulSet claims, current workload images, and completed CronJob
  churn.

Result: VPS deployment/runtime verification passed. Final Workspace parity is
still blocked on a dedicated non-production Google Chat app/project, DWD users,
owned spaces/DMs/files, and the live TEST-015 through TEST-028 matrix. Reusing
the working production app would not be isolated or safe release evidence.

## 2026-08-16 production release result

Application commit: `c8f1df8bf10e5e337e854fa71154c7f4a781ee32`.
VPS GitOps commit: `6f55ddea2472bdf1cffedc3de6fa750ede96dded`.

- Centaur CI, Rust/API integration CI, CodeQL, workflow tests, and the six-image
  production build passed. Helm lint passed; strict kubeconform validated 33
  chart resources and 21 Argo source-2 resources. Argo resolved both sources to
  the VPS commit and became `Synced`, `Healthy`, and `Succeeded`.
- `deploy/verify.sh --full` passed 9/9, including the workflow hosts and a real
  sandbox/harness/Parallel API turn. Googlechatbot live/ready returned 200 and
  an unsigned event returned 401.
- A bounded live `google_chat_sync` completed all 13 requested scopes with zero
  failures and no ETL error, reading/upserting 109 messages. Sanitized owner
  aggregates proved 11 DMs, 90 messages, 13 attachments, 11 reactions, and 11
  checkpoints, separate from the shared-space corpus.
- Live DWD setup, membership/history, upload, update, delete, reactions, and
  Drive access passed. The Drive proof exported a 75,979-byte XLSX with exact
  MIME/bytes and safe internal headers; Chat-uploaded content also returned
  exact bytes and content type.
- Two live-only defects were found and fixed at the shared roots: delegated
  message reads now forward `show_deleted`, and owner-scoped DM reaction reads
  now use the exact allowlisted DWD owner while shared scans retain the fixed
  reader. The latter has focused Rust broker checks, Python ETL checks, strict
  clippy/formatting, and the 99-test combined workflow suite.
- A DWD user-authored DM message was created through the Chat API and cleaned
  up, but Google emitted no observable interaction event. The production
  counter remained at zero accepted events. Official documentation does not
  promise that API-created messages invoke a Chat app, so a real Chat UI message
  is required before attributing the result to connection or audience settings.
  The supported browser runtime reported no available browser.

Result: the outbound, permission, file, DWD, and ETL parity paths are production
verified. TEST-031 remains pending because signed ingress, browser UI evidence,
explicit deletion/removal cycles, several size boundaries, and the remaining
named live scenarios have not all passed on this release.

## Evidence

| Task | Test | Status | Date | Commit | Environment | Command or procedure | Result | Artifact |
|---|---|---|---|---|---|---|---|---|
| TASK-001 | TEST-001 | Verified-local | 2026-08-14 | working-tree | local macOS | `scripts/verify-google-chat-parity-ledger.sh` | Current ledger has 31 task/test rows, both exclusions, valid status vocabulary, and immutable-evidence enforcement for `Passed` | This file; `scripts/verify-google-chat-parity-ledger.sh` |
| TASK-002 | TEST-002 | Provisional | 2026-08-13 | working-tree | local macOS | Three consecutive `pnpm --filter slackbotv2 run check:types && pnpm --filter slackbotv2 test` runs | Recorded snapshot: each run type-check clean; 242 passed, 1 skipped, 0 failed; 1,518 assertions; not rerun on one immutable release candidate | `services/slackbotv2/src/slack-user.ts`, `services/slackbotv2/test/chat-sdk-emulate.test.ts` |
| TASK-003 | TEST-003 | Provisional | 2026-08-14 | working-tree | local macOS | Bot config/auth tests; mode-aware fixture smoke; `scripts/verify-google-chat-network-policy.sh`; `helm lint contrib/chart` | Recorded local checks support mode pairing and fail-closed configuration; not rerun on immutable release evidence | `services/googlechatbot/src/config.test.ts`, `services/googlechatbot/src/chat/verify.test.ts`, `scripts/verify-google-chat-network-policy.sh` |
| TASK-004 | TEST-004 | Provisional | 2026-08-14 | working-tree | local macOS | `pnpm --filter googlechatbot test` | All deterministic signature, mode-pairing, signer-email, Add-on user-token, lifetime, replay-age, and subject-binding cases pass; current-branch Google-signed token smoke remains | `services/googlechatbot/src/chat/token.test.ts`, `services/googlechatbot/src/chat/verify.test.ts` |
| TASK-005 | TEST-005 | Provisional | 2026-08-13 | working-tree | local macOS | `pnpm --filter googlechatbot test` | Numeric identity and addressing cases passed; live `members/app` canonical identity smoke remains under REQ-008 | `services/googlechatbot/src/chat/client.test.ts`, `services/googlechatbot/src/chat/normalize.test.ts`, `services/googlechatbot/src/index.e2e.test.ts` |
| TASK-006 | TEST-006 | Provisional | 2026-08-14 | working-tree | local macOS | `pnpm --filter googlechatbot test`; mode-aware smoke | Official legacy `CARD_CLICKED`, Add-ons `buttonClickedPayload`, `appCommandPayload`, and `SUBMIT_DIALOG` form inputs normalize/dedupe; fictitious `submitFormPayload` was removed; live wire-format smoke remains | `services/googlechatbot/src/chat/dedup.test.ts`, `services/googlechatbot/src/index.test.ts`, testdata fixtures |
| TASK-007 | TEST-007 | Provisional | 2026-08-13 | working-tree | local macOS + disposable ParadeDB/PostgreSQL | Focused parity suite; full `bin/rails test`; migration up/down; Zeitwerk; RuboCop; Brakeman | Both models/tables, constraints, normalization, merge/delete/cache behavior passed; Console suite 1,522 runs / 6,037 assertions / 0 failures; 34 existing skips; 373 RuboCop files clean; 0 Brakeman warnings | `services/console/test/models/google_chat_permission_test.rb`, `services/console/test/migrations/create_google_chat_permissions_test.rb` |
| TASK-008 | TEST-008 | Provisional | 2026-08-14 | working-tree | local macOS + disposable ParadeDB/PostgreSQL; Browser runtime unavailable | Focused controller/API/render tests (27 runs / 179 assertions); full `bin/rails test`; supported Browser connection/discovery procedure | CRUD, malformed input, admin auth, effective payloads, no namespace field, keyboard-addressable markup, and responsive CSS structure passed. Browser discovery returned no available runtime, so required narrow/wide interaction and screenshots remain externally blocked | `services/console/test/controllers/**/google_chat_permissions_controller_test.rb` |
| TASK-009 | TEST-009 | Provisional | 2026-08-13 | working-tree | local macOS | Focused JWT/sandbox tests; full `bin/rails test` | Automated JWT/snapshot cases passed; live sandbox JWT injection and rotation smoke remains under REQ-008 | `services/console/test/models/google_chat_jwt_test.rb`, `services/console/test/controllers/api/v1/sandbox_permissions_controller_test.rb` |
| TASK-010 | TEST-010 | Provisional | 2026-08-13 | working-tree | local macOS + loopback mock upstream | `cargo test -p centaur-api-server google_chat_proxy --lib`; `cargo clippy -p centaur-api-server --all-targets -- -D warnings`; `cargo fmt --all --check` | 12 focused route/security tests and Rust checks passed; live scoped sandbox-to-proxy credential smoke remains under REQ-008 | `services/api-rs/crates/centaur-api-server/src/google_chat_proxy.rs` |
| TASK-011 | TEST-011 | Provisional | 2026-08-14 | working-tree | local macOS + Kind `centaur-gchat-parity` | Bot typecheck/full suite; Helm lint/render; static policy verifier; `GOOGLE_CHAT_KIND_CONTEXT=kind-centaur-gchat-parity scripts/verify-google-chat-network-policy-kind.sh`; current-source image `sha256:6f0a2cb30a7f910dd5a4af75c444dc84c44a1d37d1a140a08f3372a5eec7e4de` through `scripts/verify-google-chat-runtime-kind.sh` | 368 bot tests / 894 assertions passed; rendered policy allowed api-rs and denied sandbox/workflow pods; actual bot returned 401 for absent/wrong keys and accepted the correct key through route validation; ownership, empty-DELETE, and bounded declared/chunked API/OAuth response cases passed | `services/googlechatbot/src/index.test.ts`, `services/googlechatbot/src/chat/client.test.ts`, `scripts/verify-google-chat-network-policy-kind.sh`, `scripts/verify-google-chat-runtime-kind.sh` |
| TASK-012 | TEST-012 | Provisional | 2026-08-14 | working-tree | local macOS | `.github/scripts/run-tool-tests.sh`; Google Chat bot/config tests; `helm lint contrib/chart` | Current repository tool harness passed, including all 34 Google Chat CLI/client tests; live delegated upload/DM credential smoke remains under REQ-008 | `tools/comms/google_chat/tests/test_client.py`, `tools/comms/google_chat/tests/test_cli.py`, chart diff |
| TASK-013 | TEST-013 | Provisional | 2026-08-13 | working-tree | local macOS + PostgreSQL | State/config/health tests with two real Postgres adapters; bot typecheck/full suite; Helm lint/render | Production fail-closed, readiness 503→200, bounded backoff, shared prefix and restart persistence passed | `services/googlechatbot/src/state.test.ts`, `services/googlechatbot/src/index.test.ts` |
| TASK-014 | TEST-014 | Provisional | 2026-08-13 | working-tree | local macOS + PostgreSQL | State-backed dedupe/thread tests plus webhook E2E | Cross-instance message/action dedupe, distinct actions, capped IDs, active/last-event/sticky state, non-sticky reasoning, and restart persistence passed | `services/googlechatbot/src/state.test.ts`, `services/googlechatbot/src/index.e2e.test.ts` |
| TASK-015 | TEST-015 | Provisional | 2026-08-13 | working-tree | local deterministic E2E + PostgreSQL | Bot durability E2E and startup recovery tests | Automated durable accept, crash stages, leases, retry budget/stale cleanup, and stable replacement passed; live Workspace restart visibility/exactly-one-final/no-stranded-thinking smoke remains | `services/googlechatbot/src/index.e2e.test.ts`, `services/googlechatbot/src/state.ts` |
| TASK-016 | TEST-016 | Provisional | 2026-08-13 | working-tree | local deterministic hanging endpoints/SSE | Focused `session-api.test.ts`; full bot suite | 30s/10s policies, hanging-control/connection abort, established-stream survival, terminal reader release, gauge and timeout metrics passed | `services/googlechatbot/src/session-api.ts`, `services/googlechatbot/src/session-api.test.ts` |
| TASK-017 | TEST-017 | Provisional | 2026-08-14 | working-tree | local macOS + Kind `centaur-gchat-parity` | Metrics/health tests; Helm lint/render; current-source image `sha256:6f0a2cb30a7f910dd5a4af75c444dc84c44a1d37d1a140a08f3372a5eec7e4de` through `GOOGLE_CHAT_KIND_CONTEXT=kind-centaur-gchat-parity GOOGLE_CHAT_KIND_IMAGE=centaur-googlechatbot:parity-20260814 scripts/verify-google-chat-runtime-kind.sh` | Two replicas became ready against PostgreSQL; live/readiness JSON and state metric passed; rendered probes and Prometheus annotation matched; deleting one bot pod restored two ready replicas | `services/googlechatbot/src/metrics.test.ts`, `services/googlechatbot/src/index.test.ts`, `scripts/verify-google-chat-runtime-kind.sh` |
| TASK-018 | TEST-018 | Provisional | 2026-08-14 | working-tree | local macOS + mock Google API | `pnpm --filter googlechatbot exec bun test src/chat/client.test.ts src/index.test.ts src/chat/card-text.test.ts src/chat/normalize.test.ts`; earlier renderer contract run | Current focused run: 128 passed / 0 failed. It covers official scopes/bodies/masks/filters/order, bounded responses, stable message IDs and DM request IDs, safe upload retry, shared-state cross-replica write/reaction pacing, route-bound threading, Drive/card contracts, and normalization; renderer boundaries passed on an earlier mutable snapshot. Live Workspace quota/wire smoke remains | `services/googlechatbot/src/chat/client.test.ts`, `services/googlechatbot/src/index.test.ts`, `services/googlechatbot/src/renderer.test.ts` |
| TASK-019 | TEST-019 | Provisional | 2026-08-14 | working-tree | local macOS + mock api-rs | `.github/scripts/run-tool-tests.sh`; Google Chat CLI/client tests | Current repository tool harness passed; Google Chat 34/34; deployed scoped-JWT CLI and rate-limit smoke remains | `tools/comms/google_chat/client.py`, `tools/comms/google_chat/cli.py`, `tools/comms/google_chat/tests/` |
| TASK-020 | TEST-020 | Provisional | 2026-08-14 | working-tree | local macOS + mock Google API | Bot, Rust proxy, Python tool, and Console boundary suites | Exact email-only grant, target impersonation, `chat.spaces.create`, no app-JWT `sub`, `singleUserBotDm`, empty memberships, and pre-token resource rejection pass; live DWD DM reuse/participant/denial smoke remains | `services/googlechatbot/src/chat/client.test.ts`, `services/api-rs/crates/centaur-api-server/src/google_chat_proxy.rs`, `tools/comms/google_chat/tests/` |
| TASK-021 | TEST-021 | Provisional | 2026-08-13 | working-tree | local macOS + deterministic tool fixtures | Google Chat tool tests; `.github/scripts/run-tool-tests.sh` | Questions/dump/feedback schemas, bounded scans, threads, and reaction summaries passed; live scoped read/reaction smoke remains | `tools/comms/google_chat/tests/test_client.py`, `tools/comms/google_chat/tests/test_cli.py` |
| TASK-022 | TEST-022 | Provisional | 2026-08-14 | working-tree | local macOS + deterministic shared fixtures | Focused TypeScript/Python fixture contracts using `fixtures/google_chat_card_text.json` | Follow-up attachment hydration, pagination cap, requester-DWD retry, and lockstep traversal of documented v1/v2 card headers, sections, collapse controls, text/images, decorated text, buttons/menus, inputs, grids, columns, carousels, chips, and footers pass locally. Live Google history/attachment formats remain | `fixtures/google_chat_card_text.json`, `services/googlechatbot/src/chat/card-text.test.ts`, `services/googlechatbot/src/chat/normalize.test.ts`, `workflows/tests/test_google_chat_etl.py` |
| TASK-023 | TEST-023 | Provisional | 2026-08-13 | working-tree | local macOS | Bot session API tests; harness-server full tests with inherited OTLP variables unset | Exact 25 MiB inline, +1 staged, exact 100 MiB hash/reassembly, +1 rejection, aggregate limits, and malformed/missing/duplicate chunks passed; harness 83 library + 20 integration tests passed, 4 real-harness tests ignored | `services/googlechatbot/src/session-api.test.ts`, `crates/harness-server/src/server.rs`, `crates/harness-server/src/nanocodex.rs` |
| TASK-024 | TEST-024 | Provisional | 2026-08-14 | working-tree | local macOS + fake Drive API | `bun test src/chat/client.test.ts src/chat/normalize.test.ts src/config.test.ts`; `pnpm check:types` | Missing grant, resource/MIME/size/redirect validation, exact byte bounds, ordinary downloads, native export MIME/extensions, distinct 10 MB failures, normalized exported metadata, and invalid Vids export avoidance pass locally; live delegated Drive/export remains | `services/googlechatbot/src/chat/client.test.ts`, `services/googlechatbot/src/chat/normalize.test.ts`; [Drive files.export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export) |
| TASK-025 | TEST-025 | Provisional | 2026-08-14 | working-tree | local macOS + loopback mocks | 12 api-rs proxy tests; 34 Google Chat CLI/client tests through the full tool harness | Exact-space claims, list/search/info/raw download, truncation, HTML/error rejection, actual-byte ceilings, overwrite refusal, headers, and composite DM send passed; live Workspace file/proxy credential smoke remains under REQ-008 | `services/api-rs/crates/centaur-api-server/src/google_chat_proxy.rs`, `tools/comms/google_chat/tests/` |
| TASK-026 | TEST-026 | Provisional | 2026-08-14 | working-tree | local macOS + disposable PostgreSQL | `uv run --project services/workflow-python --with pytest python -m pytest -q workflows/tests/test_google_chat_etl.py`; earlier SQLx migrator/RLS tests | Current ETL run: 32 passed / 0 failed, including unconditional app/delegated `showDeleted`, shared-space and DM tombstone cleanup, official attachment/reaction persistence, continuation, old-edit rescan, projection, and errors. SQLx/RLS evidence is from an earlier mutable snapshot; live deletion convergence remains | `workflows/tests/test_google_chat_etl.py`, `workflows/google_chat/sync.py`, migrations `0054`/`0055` |
| TASK-027 | TEST-027 | Provisional | 2026-08-13 | working-tree | local macOS + PostgreSQL | Focused DB-backed retention tests; workflow registry and Helm render assertions | Dry-run/count/delete, age and batch bounds, referential cleanup, idempotency, RLS, no source deletion, and ETL queue routing passed | `workflows/google_chat/retention.py`, `workflows/tests/test_google_chat_etl.py`, chart diff |
| TASK-028 | TEST-028 | Provisional | 2026-08-13 | working-tree | local macOS | Focused metric tests plus full workflow suite | Outcomes, 429, partial failure, lag, continuation age, retention, reset, and bounded-label assertions passed | `workflows/google_chat/metrics.py`, `workflows/tests/test_google_chat_etl.py` |
| TASK-029 | TEST-029 | Provisional | 2026-08-14 | working-tree | local macOS + disposable PostgreSQL | Focused workflow-host, Google Chat ETL, Rust broker, bot, and SQLx tests | Brokered reads keep credentials in googlechatbot and validate exact allowlisted subject/resource/operation. DM owner email comes only from the allowlisted subject; memberships retain canonical IDs/display names, never nonexistent email fields. Default-off, removal, company-context exclusion, owner RLS, reaction IDs, bounds, and token-safe errors pass locally. Live DWD DM-history smoke remains | `services/workflow-python/api/workflow_engine.py`, `services/api-rs/crates/centaur-workflows/src/lib.rs`, `workflows/google_chat/sync.py`, migration `0055` |
| TASK-030 | TEST-030 | Provisional | 2026-08-14 | working-tree | local fixture smoke + Kind `centaur-gchat-parity` | Fixture smoke; bot typecheck/full suite; CI JSON/YAML validation; both Kind verification scripts; current-source image `sha256:9b5e97afffff8dfe36301a3381dcfd724255a135b253ce74544e7048782c558e` | Current-tree typecheck, smoke, and isolated bot suite pass (425 tests / 1,051 assertions / 0 failures). Earlier signed legacy/Add-ons fixtures and live Kind NetworkPolicy/auth/probes also pass: a webhook was sent directly to a named processing replica, its durable `rendering` obligation and execution were observed in PostgreSQL, that pod was killed, and the replacement resumed after lease expiry. Assertions passed for one execution, at least two SSE opens, one exact sentinel final, zero thinking/fallback duplicates, deleted obligation, recovery metric, and two ready replicas. The Workspace live matrix with redacted artifacts remains required | `services/googlechatbot/scripts/smoke.ts`, `services/googlechatbot/testdata/`, `scripts/verify-google-chat-network-policy-kind.sh`, `scripts/verify-google-chat-runtime-kind.sh` |
| TASK-031 | TEST-031 | Pending | 2026-08-14 | working-tree | local macOS + prior disposable PostgreSQL/Kind evidence | Current focused checks and earlier Console/workflow/tool/Rust/Helm/Kind gates passed on mutable intermediate snapshots. Final gate remains pending because current-branch Workspace/DWD/browser evidence is absent and every gate has not been rerun on one immutable commit/image | This ledger; `docs/google-chat-official-spec-conformance.md`; TEST-031 matrix |
