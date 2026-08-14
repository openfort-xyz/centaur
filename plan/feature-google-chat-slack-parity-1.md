---
goal: Bring the Centaur Google Chat integration to outcome-level feature parity with the Slack integration
version: 1.0
date_created: 2026-08-13
last_updated: 2026-08-14
owner: Centaur Platform
status: 'In progress'
tags: [feature, google-chat, slack, parity, security, reliability, verification]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

This plan closes the actionable differences identified in `docs/slack-vs-google-chat-n-to-n-comparison.md`. Parity means equivalent security, authorization, durability, conversation access, file handling, historical context, observability, and operator confidence. It does not mean recreating Slack-only product concepts that have no Google Chat equivalent.

Every implementation task has one required verification item with the same numeric suffix. A task remains incomplete until its verification passes and its evidence is recorded in `docs/google-chat-parity-verification.md`.

## 1. Requirements & Constraints

- **REQ-001**: Google Chat webhook processing must fail closed unless the request satisfies exactly one configured official contract: Chat API project-number JWT, Chat API endpoint-URL OIDC, or Workspace Add-on endpoint-URL OIDC. Issuer, audience, JWK set, and signer identity must remain paired.
- **REQ-002**: Every Google Chat read or mutation initiated by a sandbox must be authorized for the requesting principal, operation, and exact `spaces/<id>` resource. Creating or resolving a DM must instead match an explicit per-principal or per-role target email grant before `spaces.setup` is called; resource-name targets are invalid.
- **REQ-003**: Accepted webhook work, event deduplication, interactive-action deduplication, sticky thread settings, and final-answer delivery obligations must survive process restart and multiple replicas.
- **REQ-004**: Google Chat must provide agent commands for authorized space discovery, space metadata, members, paginated history, thread history, bounded message search, DMs, reactions, uploads, file metadata, downloads, questions, dumps, and feedback.
- **REQ-005**: Google Chat ETL must preserve message, card, reaction, and attachment context; support bounded historical convergence; enforce RLS; expose retention; and publish operational metrics.
- **REQ-006**: Existing Google Chat message send, update, delete, upload, DM, mention, stop, streaming, model override, and Console-link behavior must remain compatible unless this plan explicitly tightens an unsafe default.
- **REQ-007**: Existing Slack behavior must not regress. Slack is the reference behavior only after its current type-check and renderer test failures are green.
- **REQ-008**: Every task must have automated verification. Tasks involving Google-controlled wire formats, credentials, Kubernetes networking, restart recovery, or Workspace authorization must also have a live smoke test.
- **REQ-009**: `docs/google-chat-parity-verification.md` must record task ID, test ID, command or smoke procedure, date, commit SHA, environment, and result for every task.
- **SEC-001**: No Google service-account JSON, DWD token, relay key, sandbox JWT, or OAuth bearer may be returned, logged, stored in an event, or materialized inside a sandbox.
- **SEC-002**: Resource authorization must occur before an upstream Google API call or internal relay forward. A valid bearer without an allowed operation and matching space is insufficient.
- **SEC-003**: Signed-request validation must require the mode-paired issuer, audience, key set, signer identity where applicable, signature, numeric `iat`, numeric `exp`, and bounded age. A configured email-domain policy may use only a separately verified Add-on `userIdToken`, never a body `User` field.
- **SEC-004**: DWD scopes must be separated by operation. Upload, DM setup, DM history, reactions, and Drive download must not share one broad grant; no Directory grant is added.
- **SEC-005**: Message update and delete must verify that the target is bot-authored or owned by the configured delegated sender before forwarding the mutation.
- **CON-001**: Do not implement Slack user groups, Slack Connect administration, Block Kit, App Home, Google Add-on `widgetUpdatedPayload` suggestions, dialog UI responses, link previews, assistant thread titles, Slack archive ZIP import, public/private-channel terminology, pins, bookmarks, reminders, canvases, calls, huddles, scheduled messages, or ephemeral messages. These are platform-specific or absent from both Centaur integrations; recognizing an event enum for safe logging does not implement it.
- **CON-002**: Do not add a Google Workspace global user directory. Space membership lookup and explicit email-only DM setup satisfy the Chat use cases without adding the broad Admin SDK Directory scope.
- **CON-003**: Do not add a separate Google Chat backfill queue unless bounded continuation stored in `google_chat_sync_checkpoints` fails the convergence test in TEST-026. Google Chat's oldest-first pagination does not require Slack's cursor queue by default.
- **CON-004**: Never edit applied SQL migrations. Add the next numbered migration under `services/api-rs/crates/centaur-session-sqlx/migrations` and use a generated Rails migration plus generated `services/console/db/schema.rb` changes.
- **CON-005**: Keep Google-platform behavior in `services/googlechatbot`, `tools/comms/google_chat`, and `workflows/google_chat`. Keep api-rs limited to resource authorization, internal forwarding, and durable platform-neutral state.
- **GUD-001**: Implement phases in order. Tasks inside a phase may run in parallel only when their `Depends on` clauses are satisfied.
- **GUD-002**: Add no new third-party dependency when an existing Centaur package, standard library API, or Google REST endpoint already covers the task.
- **PAT-001**: Reuse the principal/role merge semantics of `SlackChannelPermission`, the short-lived Console JWT pattern, and the resource-bound checks in `slack_proxy.rs`.
- **PAT-002**: Reuse `@chat-adapter/state-pg` and the Slack render-obligation lease/recovery pattern instead of designing a second durable state framework.
- **PAT-003**: Use deterministic fixtures for automated tests and a dedicated non-production Google Workspace space for live tests.
- **VER-001**: A verification passes only when its assertions are machine-checkable. A manual statement such as “looks correct” is not evidence.
- **VER-002**: The final parity gate requires all focused tests, complete service suites, Console CI, Rust checks, workflow tests, tool tests, Helm validation, and the live smoke matrix to pass on one commit.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Establish a trustworthy baseline and an executable parity contract.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `docs/google-chat-parity-verification.md` with one row for TEST-001 through TEST-031 and fields for commit, environment, command/procedure, result, and artifact link. Add the accepted platform-specific exclusions from CON-001 and CON-002. Depends on: none. Verification: TEST-001. | ✅ | 2026-08-13 |
| TASK-002 | Fix the three `fetch.preconnect` type errors in `services/slackbotv2/test/slack-user.test.ts` and the renderer timing/transcript failures in `services/slackbotv2/test/index.test.ts` without weakening assertions or increasing global timeouts. Treat the shared renderer/session root cause, not individual symptoms. Depends on: none. Verification: TEST-002. | ✅ | 2026-08-13 |

### Implementation Phase 2

- GOAL-002: Make Google Chat ingress fail closed and correct across legacy and Workspace Add-ons event shapes.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | In `services/googlechatbot/src/config.ts`, model `chat_api_project`, `chat_api_url`, and `workspace_addon` as explicit ingress modes. Add first-class mode, paired audience, Add-on signer, optional user-token audience, and signed-request settings to the chart. Helm must reject a mode missing its exact required values and must never render an issuer/audience cross-product. Depends on: TASK-001. Verification: TEST-003. | ✅ | 2026-08-14 |
| TASK-004 | In `services/googlechatbot/src/chat/token.ts`, reject signed tokens unless `iat` and `exp` are numeric, `exp` is after `iat`, the token is not older than the configured maximum age, and the existing issuer/audience/signature checks pass. Add `GOOGLECHATBOT_SIGNED_REQUEST_MAX_AGE_SECONDS` to `src/config.ts` and the chart with a default of 300 seconds. Depends on: TASK-003. Verification: TEST-004. | | |
| TASK-005 | In `services/googlechatbot/src/chat/client.ts` and `src/chat/normalize.ts`, obtain and cache the canonical numeric bot user resource and use `sender.type === 'BOT'` plus that resource for self-message suppression. Remove the fallback that treats any `@` as a bot mention; require a slash annotation, `singleUserBotDm`, or an annotation/resource match for this bot. Depends on: TASK-003. Verification: TEST-005. | | |
| TASK-006 | In `services/googlechatbot/src/index.ts`, `src/chat/types.ts`, and `src/chat/dedup.ts`, normalize legacy `CARD_CLICKED` plus official Add-ons `buttonClickedPayload` and `appCommandPayload`. Treat `buttonClickedPayload.dialogEventType=SUBMIT_DIALOG` with `commonEventObject.formInputs` as form submission; do not invent `submitFormPayload`. Build action dedupe keys from event time, space, message, user, invoked function, and canonicalized parameters. Depends on: TASK-003. Verification: TEST-006. | | |

### Implementation Phase 3

- GOAL-003: Add principal-scoped Google Chat authorization and a sandbox-reachable proxy path.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Generate `services/console/db/migrate/20260813000000_create_google_chat_permissions.rb`. Create `google_chat_space_permissions` with exactly one grantee (`principal_id` xor `role_id`), normalized `space_name`, and boolean flags `send_enabled`, `update_enabled`, `delete_enabled`, `upload_enabled`, `download_enabled`, `history_enabled`, `members_enabled`, and `reactions_enabled`. Create `google_chat_dm_permissions` with exactly one grantee, normalized `target_identity`, and `setup_enabled`. Add both models and owner concerns by adapting the Slack merge, validation, cache invalidation, and OR semantics. Update `Principal` and `Role` associations and generate `services/console/db/schema.rb`. Depends on: TASK-001. Verification: TEST-007. | ✅ | 2026-08-13 |
| TASK-008 | Add Google Chat space and DM-target permission CRUD/replacement support to `services/console/config/routes.rb`, `services/console/app/controllers/api/v1/principals_controller.rb`, `services/console/app/controllers/api/v1/roles_controller.rb`, `services/console/app/controllers/api/v1/sandbox/permissions_controller.rb`, `services/console/app/controllers/console/principals_controller.rb`, `services/console/app/controllers/console/roles_controller.rb`, and new partials `services/console/app/views/console/shared/_google_chat_space_permissions.html.erb` and `services/console/app/views/console/shared/_google_chat_dm_permissions.html.erb`. Reject malformed resource names/identities and preserve immutable targets on update. Depends on: TASK-007. Verification: TEST-008. | | |
| TASK-009 | Extend `services/console/lib/api_server/jwt.rb` to emit a `google_chat` claim containing a sorted space-name array per operation flag plus sorted `dm_setup_targets`, using the existing 15-minute rotation window and one-hour TTL. Return nil only when both Slack and Google Chat claims are empty. Include effective Google Chat permissions in proxy-sync snapshots and sandbox permission responses. Depends on: TASK-007. Verification: TEST-009. | | |
| TASK-010 | Add `services/api-rs/crates/centaur-api-server/src/google_chat_proxy.rs` and merge its router in `routes.rs`. Expose resource-bound routes for spaces, messages, threads, memberships, reactions, attachments, send, update, delete, upload, and DM setup. Verify the Console JWT, normalize the target `spaces/<id>`, enforce the operation-specific claim before reading a body or forwarding, and require an exact `dm_setup_targets` match before setup. Filter space-list results to authorized space names. Cap request/response sizes and forward only to the internal googlechatbot service with bounded connect/read timeouts. Depends on: TASK-009. Verification: TEST-010. | | |
| TASK-011 | Replace googlechatbot's deployment-wide outbound relay authorization in `services/googlechatbot/src/index.ts` with an internal-service credential accepted only from api-rs. Preserve `/api/chat/*` as internal routes, enforce bot/delegated-user message ownership for update/delete, and return a valid empty JSON object for an upstream empty DELETE response. Add api-rs-to-googlechatbot credentials and URLs to `contrib/chart/templates/apirs.yaml`, `contrib/chart/templates/googlechatbot.yaml`, and `contrib/chart/templates/networkpolicy.yaml`. Depends on: TASK-010. Verification: TEST-011. | ✅ | 2026-08-14 |
| TASK-012 | Change `tools/comms/google_chat/client.py` and `pyproject.toml` so every command uses the api-rs proxy and its injected short-lived Console JWT. Remove the default plain-HTTP googlechatbot URL, the hard-coded DWD subject, the sandbox-level Google service-account grants, and the unconditional `CHATBOT_API_KEY` constructor requirement. Configure upload/DM/Drive delegated subjects only on googlechatbot through chart values and fail closed when a required subject is absent. Depends on: TASK-010, TASK-011. Verification: TEST-012. | | |

### Implementation Phase 4

- GOAL-004: Make Google Chat webhook acceptance, state, and final delivery crash-durable.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-013 | Add `@chat-adapter/state-pg`, `chat`, and `pg` to `services/googlechatbot/package.json`. Add Postgres URL, state-prefix, connect retry, and pool configuration to `src/config.ts`, `src/server.ts`, and `contrib/chart/templates/googlechatbot.yaml`, following `services/slackbotv2/src/index.ts:createDefaultState` and `ensureStateConnected`. The bot must not become ready before state connects. Depends on: TASK-003. Verification: TEST-013. | ✅ | 2026-08-13 |
| TASK-014 | Replace `EventDeduper`'s process-local map with state-backed `setIfNotExists` leases and completed markers. Persist forwarded/executed message IDs, action IDs, last event ID, active execution, and sticky harness/model/provider per Chat thread. Preserve reasoning as a per-turn override. Depends on: TASK-006, TASK-013. Verification: TEST-014. | ✅ | 2026-08-13 |
| TASK-015 | Persist an authenticated, token-stripped raw envelope before the synchronous response and finish normalization/media/history under a leased background worker. Add durable obligation index, per-thread lease, startup/recurring recovery, stale/failure bounds, and canonical final recovery. Text finals may update the acknowledgement; rich finals must use retry-safe create plus acknowledgement deletion because Google PATCH does not support `fallbackText`. Depends on: TASK-013, TASK-014. Verification: TEST-015. | | |
| TASK-016 | Add explicit abort policies to every `fetch` in `services/googlechatbot/src/session-api.ts`: 30 seconds for create/append/execute/interrupt/workflow-event requests, 10 seconds for stream connection establishment, and the existing session duration/idle rules for an established SSE body. Abort and release SSE readers after terminal events. Depends on: TASK-013. Verification: TEST-016. | ✅ | 2026-08-13 |
| TASK-017 | Extend `services/googlechatbot/src/metrics.ts` and `/health` with state connection status, open SSE connections, dedupe outcomes, pending render obligations, recovery attempts/outcomes, upstream timeout counts, and delivery outcomes. Readiness must cover state connectivity; liveness must remain process-only. Update Prometheus annotations and probes in `contrib/chart/templates/googlechatbot.yaml`. Depends on: TASK-015, TASK-016. Verification: TEST-017. | ✅ | 2026-08-14 |

### Implementation Phase 5

- GOAL-005: Reach Slack-equivalent conversation discovery, history, DM, search, and feedback outcomes through the scoped proxy.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-018 | Implement typed Chat REST methods with official auth/scopes, page caps, unquoted thread filters, uppercase order values, supported update masks, app/delegated `showDeleted`, shared-state cross-replica pacing for every same-space write and direct/aggregate reaction read, bounded streamed responses, safe operation-specific retry, stable message/setup IDs, and exact route-bound named-space threading behavior. Enforce the complete 32,000-byte Message limit, card structure limits, `fallbackText`, and retry-safe multipart IDs. Depends on: TASK-011. Verification: TEST-018. | | |
| TASK-019 | Extend `tools/comms/google_chat/client.py` and `cli.py` with `spaces`, `space-info`, `members`, `thread`, `search`, and `reactions`. Implement `search` as an authorized bounded history scan with `--max-pages`, deterministic newest-first output, and an explicit `truncated` field when the bound is reached. Expose pagination tokens for every list command. Do not add reaction mutation because Slack exposes reaction summaries but no reaction-write command. Depends on: TASK-012, TASK-018. Verification: TEST-019. | | |
| TASK-020 | Add `google-chat dm <user-email> <text>` using `spaces.setup` through the proxy. Impersonate the exact granted target email with only `chat.spaces.create`, send `singleUserBotDm=true` with an empty memberships array, and reject `users/<id>`/legacy resource targets before token exchange. Reuse Google's returned DM and fail closed when delegation is absent. Depends on: TASK-018, TASK-019. Verification: TEST-020. | | |
| TASK-021 | Add `questions`, `dump`, and `feedback` commands to `tools/comms/google_chat`. Build them from the authorized paginated message/thread/reaction methods, preserve the Slack command output schemas where platform-neutral, and mark bounded/incomplete scans in output. Do not add Google-only global user enumeration. Depends on: TASK-019. Verification: TEST-021. | | |
| TASK-022 | Correct live context in `services/googlechatbot/src/chat/normalize.ts`: hydrate attachments for accepted unmentioned follow-ups, preserve card-only prior messages using the same deterministic widget traversal as ETL, paginate history to the configured cap, and retain requester-DWD fallback for DMs. Add one shared JSON fixture corpus consumed by TypeScript and Python tests so the two language-local card-text helpers must produce identical output without introducing a cross-language package. Depends on: TASK-005, TASK-014. Verification: TEST-022. | | |

### Implementation Phase 6

- GOAL-006: Reach Slack-equivalent attachment ingestion, retrieval, and authorization outcomes.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-023 | Port Slack's bounded `attachment.chunk` staging protocol into `services/googlechatbot/src/session-api.ts` for uploaded Chat content larger than 25 MiB and at most 100 MiB. Keep first-message limits explicit and reject aggregate payloads that exceed configured bounds. Depends on: TASK-022. Verification: TEST-023. | ✅ | 2026-08-13 |
| TASK-024 | Add delegated Drive download support for `DRIVE_FILE` attachments with a dedicated optional `drive.readonly` subject. Validate resource IDs, metadata, MIME, declared/actual size, redirect hosts, and the 100 MiB binary-download ceiling. Export Google-native Docs/Sheets/Slides/Drawings/Apps Script through MIME/extension-correct `files.export`; never use unsupported `alt=media`, model Drive's separate 10 MB exported-content limit explicitly, and keep Vids metadata-only until long-running `files.download` is implemented. Preserve structured metadata-only degradation. Depends on: TASK-012, TASK-022. Verification: TEST-024. | | |
| TASK-025 | Add proxy and CLI operations `files`, `search-files`, `file-info`, and `download`. Derive files from authorized messages, bound `search-files` by page count with explicit truncation, require the download claim for the exact space, stream bytes without base64 expansion, reject HTML/error bodies, and enforce a configurable 100 MiB proxy ceiling plus a 10 MiB default CLI ceiling. Depends on: TASK-010, TASK-018. Verification: TEST-025. | | |

### Implementation Phase 7

- GOAL-007: Bring Google Chat historical ingestion, private history, retention, and metrics to equivalent operational outcomes.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-026 | Add SQLx attachment/reaction rows and bounded continuation checkpoints. Persist only official Chat attachment fields and raw metadata, reactions, card text, continuation, and per-space errors. Scheduled scans must rescan history so old edits converge; every app/delegated message read must request the officially supported `showDeleted` option and delete tombstoned message/attachment/reaction rows. Depends on: TASK-022, TASK-025. Verification: TEST-026. | | |
| TASK-027 | Add `workflows/google_chat/retention.py` with dry-run, count, and delete modes for derived Google Chat messages, attachments, reactions, checkpoints, and expired runs. Register `google_chat_retention` in the workflow registry and chart/API environment using the same queue class and safety controls as Slack retention. Never delete Google source messages or files. Depends on: TASK-026. Verification: TEST-027. | ✅ | 2026-08-13 |
| TASK-028 | Add `workflows/google_chat/metrics.py` for run status/duration, API outcomes, rate limits, messages/files/reactions processed, continuation age, watermark lag, per-space failures, last failure time, and retention counts. Wire metrics into sync and retention and expose them through the existing workflow metrics exporter. Depends on: TASK-026, TASK-027. Verification: TEST-028. | ✅ | 2026-08-13 |
| TASK-029 | Add opt-in DWD DM synchronization using an explicit allowlist of delegated subject emails. Store the allowlisted subject as owner and only official canonical member IDs/display names as participants; never expect `User.email`. Exclude DM rows from company context and enforce owner-scoped RLS. Depends on: TASK-026. Verification: TEST-029. | | |

### Implementation Phase 8

- GOAL-008: Make parity verifiable in CI, a real Workspace, Kubernetes, and operator documentation.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-030 | Add deterministic signed legacy and Workspace Add-ons webhook fixtures plus a `services/googlechatbot/scripts/smoke.ts` driver. Cover mention, DM, group space, stop, follow-up attachment, card action, app command, form submission, duplicate delivery, restart during render, send/update/delete, DM setup, reactions, upload/download, and permission denial. Add CI execution for all fixture-only cases and document the live cases. Depends on: TASK-015, TASK-020, TASK-025, TASK-029. Verification: TEST-030. | | |
| TASK-031 | Add operator/ETL docs, update the N-to-N matrix and status docs, and create an official-source conformance report covering every Google-facing contract. Separate official-spec validation, local automation, old-deployment VPS observations, and current-branch live proof. Document every remaining gap and platform exclusion without overclaiming. Mark parity achieved only after every ledger row passes on one commit. Depends on: TASK-001 through TASK-030. Verification: TEST-031. | | |

## 3. Alternatives

- **ALT-001**: Copy every Slack command and internal mechanism literally. Rejected because Slack user groups, Slack Connect, Block Kit, assistant titles, and archive ZIPs have no direct Google Chat equivalent; outcome parity avoids dead abstractions.
- **ALT-002**: Keep sandbox tools talking directly to `chat.googleapis.com` with host/method DWD grants. Rejected because the current proxy cannot bind grants to a space path, so a principal with the tool receives broader access than intended.
- **ALT-003**: Expose googlechatbot directly to sandboxes over plain HTTP. Rejected because it bypasses the existing api-rs capability boundary and contradicts the CONNECT-only egress model.
- **ALT-004**: Store dedupe and render recovery in custom Google Chat SQL tables. Rejected because `@chat-adapter/state-pg` already supplies the required atomic TTL and list primitives used by Slack.
- **ALT-005**: Add the Admin SDK Directory read scope for Slack-like global user search. Rejected because space members plus explicit DM targets cover the integration use cases with less privilege.
- **ALT-006**: Add a dedicated Google Chat backfill queue immediately. Rejected under CON-003; bounded oldest-first continuation is smaller and must be proven insufficient before adding queue machinery.
- **ALT-007**: Treat company-context search as a complete replacement for Chat tool history/search. Rejected because agents need current, authorized, thread-specific reads and explicit pagination independent of ETL freshness.

## 4. Dependencies

- **DEP-001**: A disposable Postgres database for `@chat-adapter/state-pg`, Console migrations, SQLx migration/RLS tests, and restart-recovery tests.
- **DEP-002**: A non-production Google Workspace project with the Chat app installed and `chat.app.messages.readonly` administrator approval.
- **DEP-003**: Separate DWD configuration for upload (`chat.messages.create`), DM setup (Chat space/membership scopes), DM history (`chat.messages.readonly`), and optional Drive download (read-only Drive scope).
- **DEP-004**: A dedicated non-production Workspace user for delegated upload/DM/Drive smoke tests; production personal addresses must not appear in repository manifests.
- **DEP-005**: Existing Console JWT signing configuration and sandbox api-rs capability labels.
- **DEP-006**: Existing internal api-rs-to-googlechatbot Kubernetes connectivity and a new service credential stored through the configured secret manager.
- **DEP-007**: Existing `@chat-adapter/state-pg`, `chat`, `pg`, Hono, httpx, Typer, workflow runtime, company-context projection, and metrics packages. No new third-party library is planned.
- **DEP-008**: A local Kind cluster for network-policy, pod-restart, multi-replica, and final-delivery smoke tests.

## 5. Files

- **FILE-001**: `docs/slack-vs-google-chat-n-to-n-comparison.md` — source gap matrix and final parity status.
- **FILE-002**: `docs/google-chat-parity-verification.md` — per-task verification evidence ledger.
- **FILE-003**: `services/googlechatbot/src/config.ts`, `server.ts`, `index.ts`, `session-api.ts`, `metrics.ts` — ingress, state, recovery, timeout, health, and relay behavior.
- **FILE-004**: `services/googlechatbot/src/chat/token.ts`, `verify.ts`, `types.ts`, `dedup.ts`, `normalize.ts`, `client.ts` — authentication, event normalization, API operations, attachment handling, and identity.
- **FILE-005**: `services/googlechatbot/src/**/*.test.ts`, `services/googlechatbot/src/index.e2e.test.ts` — focused and end-to-end bot verification.
- **FILE-006**: `services/googlechatbot/package.json`, `pnpm-lock.yaml` — reuse of the existing state and Postgres packages.
- **FILE-007**: `services/googlechatbot/scripts/smoke.ts` and `services/googlechatbot/testdata/` — deterministic fixture driver and signed fixtures.
- **FILE-008**: `tools/comms/google_chat/client.py`, `cli.py`, `pyproject.toml`, `tests/test_client.py` — scoped proxy transport and expanded agent commands.
- **FILE-009**: `services/console/db/migrate/20260813000000_create_google_chat_permissions.rb`, `services/console/db/schema.rb` — space and DM-target permission persistence.
- **FILE-010**: `services/console/app/models/google_chat_space_permission.rb`, `models/concerns/google_chat_space_permission_owner.rb`, `models/principal.rb`, `models/role.rb` — permission model and inheritance.
- **FILE-011**: `services/console/app/controllers/**`, `services/console/config/routes.rb`, `services/console/app/views/console/shared/_google_chat_space_permissions.html.erb` — permission APIs and UI.
- **FILE-012**: `services/console/lib/api_server/jwt.rb`, `services/console/app/controllers/api/v1/sandbox/permissions_controller.rb` — short-lived Google Chat claims.
- **FILE-013**: `services/console/test/**` — model, API, controller, UI, JWT, and sandbox permission tests.
- **FILE-014**: `services/api-rs/crates/centaur-api-server/src/google_chat_proxy.rs`, `lib.rs`, `routes.rs` — authorized forwarding boundary.
- **FILE-015**: `services/api-rs/crates/centaur-session-sqlx/migrations/0054_google_chat_parity_data.sql` and `0055_google_chat_dm_rls.sql` — attachments, reactions, continuation, and privacy. If 0054 is no longer the maximum at implementation start, allocate `max(existing)+1` and `max(existing)+2` and update this plan before writing either file.
- **FILE-016**: `services/api-rs/crates/centaur-session-sqlx/tests/etl_context_rls.rs` — Google Chat message/attachment/DM RLS verification.
- **FILE-017**: `workflows/google_chat/client.py`, `sync.py`, `retention.py`, `metrics.py`, `workflows/tests/test_google_chat_etl.py`, and new focused Google Chat tests — data lifecycle.
- **FILE-018**: `contrib/chart/values.yaml`, `values.schema.json`, `templates/googlechatbot.yaml`, `templates/apirs.yaml`, `templates/networkpolicy.yaml` — configuration, secrets, probes, and connectivity.
- **FILE-019**: `.github/workflows/ci.yml`, `.github/scripts/run-tool-tests.sh` only if discovery changes are required — parity gates.
- **FILE-020**: `docs/pages/reference/google-chat.mdx`, `docs/pages/operate/google-chat-etl.mdx`, `services/googlechatbot/README.md`, `services/googlechatbot/SLACK_PARITY.md` — operator documentation.
- **FILE-021**: `services/slackbotv2/test/slack-user.test.ts`, `services/slackbotv2/test/index.test.ts`, and the shared production code identified by the failing assertions — stable reference suite.

## 6. Testing

- **TEST-001**: Validate the verification ledger with a script or test that asserts exactly one row exists for TEST-001 through TEST-031, every task ID maps to the same-numbered test ID, and exclusion IDs CON-001/CON-002 are present.
- **TEST-002**: Run `pnpm --filter slackbotv2 run check:types` and `pnpm --filter slackbotv2 test` three consecutive times. Require zero type errors, zero failures, identical pass/skip counts, and no timeout increase in the diff.
- **TEST-003**: Add config and Helm tests proving signed requests default on; each of the three ingress modes renders only its paired issuer/audience/signer inputs; missing mode-required values fail; cross-mode inputs do not authorize; and explicit development opt-out remains visible.
- **TEST-004**: Extend `src/chat/token.test.ts` with missing, nonnumeric, inverted, expired, too-old, future, boundary-skew, wrong-audience, wrong-issuer, and valid token cases. Require all cases to assert a specific rejection reason.
- **TEST-005**: Extend normalization/E2E tests with numeric bot sender IDs, other bots, ordinary human `@alice` text, exact bot annotations, slash commands, DMs, and self-authored messages. Require only exact bot addressing, slash commands, and DMs to start runs.
- **TEST-006**: Add legacy and official Add-ons action fixtures. Assert distinct users/functions/parameters dispatch separately, exact redelivery dispatches once, app commands and `SUBMIT_DIALOG` form inputs use typed event names, malformed payloads make no workflow call, and no `submitFormPayload` contract exists.
- **TEST-007**: Add Rails model/migration tests for both permission tables: exact-one-grantee, resource/identity normalization, duplicate rejection, at-least-one flag, immutable target, role/direct OR merge, deletion, cache invalidation, and migration rollback on a disposable database.
- **TEST-008**: Add Rails API/controller/view tests for principal and role space/DM-target create/replace/upsert/delete, inherited/effective payloads, malformed input, admin authorization, proof that the removed namespace field is not reintroduced, keyboard-addressable controls, and narrow/wide rendered layouts.
- **TEST-009**: Add JWT tests asserting stable ordering, all eight space claim arrays, DM target claims, direct-plus-role merge, 15-minute rotation, one-hour expiry, Slack-plus-Chat coexistence, no secret content, and sandbox permission payload parity.
- **TEST-010**: Add Rust unit/integration tests for every route and operation: missing/invalid/expired JWT, wrong space, unauthorized DM target, filtered space listing, wrong operation, encoded-path confusion, oversized body, upstream timeout, upstream error, and allowed success. Assert denied requests make zero upstream calls.
- **TEST-011**: Add googlechatbot E2E tests for api-rs-only internal authentication, message ownership checks, empty DELETE success, delegated-user ownership, invalid resource names, request limits, and no credential values in logs or responses. Render the NetworkPolicy and assert api-rs is allowed while sandbox pod selectors are not.
- **TEST-012**: Run `.github/scripts/run-tool-tests.sh`. Add tests proving every command targets api-rs, no command resolves the old relay, no raw Google/API key is loaded, grants contain no hard-coded user, missing delegated configuration fails closed, and JWT headers use the injected sentinel credential contract.
- **TEST-013**: Add state configuration tests and a Postgres-backed startup test. Assert readiness is 503 before connection, 200 after connection, reconnect attempts are bounded/backed off, and two bot instances share state under the configured prefix.
- **TEST-014**: Add two-instance Postgres-backed tests for duplicate messages, duplicate/distinct card actions, forwarded/executed ID caps, active execution, last event ID, and sticky overrides. Restart both instances and assert state and dedupe outcomes persist.
- **TEST-015**: Add a hanging-upstream test proving the token-stripped authenticated envelope is durable and `{}` returns before Google's 30-second deadline. Add crash-point tests before/after acknowledgement, during SSE, and around text-update/rich-create delivery. Restart a second instance and assert exactly one canonical final, no stranded thinking message, lease exclusion, and bounded cleanup.
- **TEST-016**: Use hanging fake endpoints and streams to assert each control call aborts at its configured deadline, an established active SSE is not cut off by the connection timeout, terminal events release readers, and the open-stream gauge returns to zero.
- **TEST-017**: Assert metric names/labels are registered once, counters/gauges change on success/failure/recovery, readiness and liveness differ correctly, and Helm renders separate probe paths plus Prometheus annotations.
- **TEST-018**: Add Chat client/renderer contract tests for pagination, URL encoding, unquoted filters, uppercase ordering, supported masks, credential/scopes, app and delegated `showDeleted`, reaction caps, two-client shared-StateAdapter write/reaction pacing, safe upload versus idempotent-create retry, stable message/setup IDs, route-space thread binding and official space-type resolution, bounded streamed bodies, 32,000-byte Message boundaries including Unicode, 100-widget/non-empty cards, `fallbackText`, named-space-only reply options, multipart IDs/409 replay, and no bearer leakage.
- **TEST-019**: Add CLI tests for every new command, JSON and human output, pagination tokens, thread filters, max-page search truncation, malformed resources, permission denial, and rate-limit/upstream errors. Run the repository tool-test script.
- **TEST-020**: Add automated tests proving email-only targets, target impersonation, exact `chat.spaces.create` scope, no app-JWT `sub`, `singleUserBotDm=true`, empty memberships, and pre-token rejection of every resource-name target. In Workspace, create/reuse the DM, verify participants and denial of ungranted reuse.
- **TEST-021**: Add fixture-based command tests that compare Google Chat questions/dump/feedback schemas with the platform-neutral Slack fields, include reaction summaries and threads, and explicitly flag bounded scans. Assert each read is constrained by history/reaction claims.
- **TEST-022**: Add normalization tests for unmentioned follow-up files, card-only roots/replies, multi-page history, DM DWD fallback, history caps, attachment-download bounds, and identical card text between live context and ETL output.
- **TEST-023**: Add size-boundary tests at 25 MiB, 25 MiB plus one byte, 100 MiB, and 100 MiB plus one byte; reconstruct chunked payloads and compare hashes; assert aggregate limits and malformed/missing chunks fail without starting execution.
- **TEST-024**: Add fake Drive tests for missing grant, invalid resource, redirect to unapproved host, declared/actual size mismatch, MIME mismatch, the 100 MiB binary boundary, the 10 MB `files.export` ceiling and oversized-export failure, 401/403/429, ordinary download, each Google-native export mapping, and metadata-only fallback. Add one live delegated Drive attachment/export smoke test at both sides of the native-export limit.
- **TEST-025**: Add proxy/tool tests for authorized file list/search/info/download, bounded-search truncation, wrong-space denial, no-download-claim denial, streaming, HTML rejection, upstream error, 10 MiB CLI limit, 100 MiB proxy limit, and filename/content-type sanitization.
- **TEST-026**: With `SESSION_SQLX_TEST_DATABASE_URL` set, verify official-field-only attachment/reaction writes, idempotency, continuation, scheduled full-rescan edit convergence, app and delegated `showDeleted` tombstone cleanup, projection, and RLS denial. Retention must never be cited as source reconciliation.
- **TEST-027**: Add retention tests for dry-run/count/delete, age boundary, batch limit, referential cleanup, idempotency, RLS, and proof that no Google API delete method is called. Verify the workflow registry and chart route `google_chat_retention` to the ETL queue.
- **TEST-028**: Add metric tests for every declared outcome and gauge, including 429, partial-space failure, lag, continuation age, retention, and reset behavior. Assert label cardinality excludes raw space/message/user IDs.
- **TEST-029**: Add SQLx/workflow tests showing DM sync is disabled by default, only allowlisted subjects run, the owner email comes only from that subject, membership email is never expected, canonical IDs/display names remain, company projection excludes DMs, cross-owner RLS denies, subject removal stops sync, and logs contain no delegated token. Add one live DWD DM-history smoke test.
- **TEST-030**: Run fixture smoke in CI. In Kind, run two replicas, enforce NetworkPolicy, kill the processing pod, and assert one recovered answer. In Workspace, exercise every current-branch live case and save redacted request IDs/resource names/metrics. Old-deployment VPS logs may support legacy observations only and must never be counted as current-branch proof.
- **TEST-031**: Check every row in `docs/google-chat-official-spec-conformance.md` has an official URL, implementation path, automated evidence, live status, result, and caveat. Then, on one commit, run the Slack, Google Chat (three times), tool, workflow, Console, Rust, Helm/schema, docs, Kind, and Workspace matrices. Require every TEST-001 through TEST-030 ledger row to pass before changing status to `Completed`.

## 7. Risks & Assumptions

- **RISK-001**: Enabling signed requests by default is a breaking deployment change. Mitigation: chart validation, explicit development opt-out, release notes, and a pre-deploy audience smoke test.
- **RISK-002**: DWD creates high-impact delegated authority. Mitigation: separate subjects/scopes, bot-side credential custody, per-space proxy claims, no sandbox tokens, and live denial tests.
- **RISK-003**: Google Chat app-auth behavior differs for named spaces and DMs. Mitigation: explicit credential classes, automated 400/401/403 handling, and live named-space plus DM coverage.
- **RISK-004**: Render recovery can duplicate answers around crash boundaries. Mitigation: persisted obligation before acceptance, per-thread leases, idempotent canonical final answer, and kill-at-each-boundary tests.
- **RISK-005**: Large attachment staging can exhaust memory or session limits. Mitigation: streaming proxy downloads, aggregate limits, chunk hashes, strict ceilings, and boundary tests.
- **RISK-006**: Google pagination tokens may expire. Mitigation: persist watermark plus continuation metadata and prove convergence after token invalidation; do not depend on a token as the only checkpoint.
- **RISK-007**: Search implemented as bounded history scanning is not equivalent to Slack's server-side full-text search at large scale. Mitigation: expose truncation and bounds, use company context for corpus-wide retrieval, and avoid claiming complete results.
- **RISK-008**: The Slack reference tests are currently timing-sensitive. Mitigation: TASK-002 is a hard prerequisite for final parity claims.
- **RISK-009**: Google Workspace Add-ons payloads and live card actions are not currently exercised in production. Mitigation: signed fixtures plus a mandatory live button/form/command smoke test.
- **ASSUMPTION-001**: Production uses api-rs and Console-managed sandbox permissions; direct standalone tool use is not a supported privileged path after TASK-012.
- **ASSUMPTION-002**: The existing Google Chat app can receive all messages when follow-up mode is enabled and can be installed in the dedicated test spaces.
- **ASSUMPTION-003**: A dedicated DWD test user can be provisioned without using a developer's personal account.
- **ASSUMPTION-004**: Google Chat source-message deletion is outside ETL retention; retention applies only to Centaur-derived data.
- **ASSUMPTION-005**: The next SQLx migration number is 0054 at implementation start. If another migration lands first, use the next available number without renumbering applied files and update FILE-015.

## 8. Related Specifications / Further Reading

- [Current Slack vs Google Chat N-to-N comparison](../docs/slack-vs-google-chat-n-to-n-comparison.md)
- [Existing chronological Google Chat parity log](../services/googlechatbot/SLACK_PARITY.md)
- [Google Chat bot implementation notes](../services/googlechatbot/README.md)
- [api-rs contribution and validation guide](../services/api-rs/AGENTS.md)
- [Console contribution and validation guide](../services/console/AGENTS.md)
- [Slack bot implementation guide](../services/slackbotv2/AGENTS.md)
