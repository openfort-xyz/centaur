---
goal: Validate the Google Chat parity implementation against the working Centaur VPS deployment without disrupting production
version: 1.0
date_created: 2026-08-14
last_updated: 2026-08-14
owner: Centaur Platform
status: 'Planned'
tags: [process, google-chat, parity, canary, vps, validation, security, release]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan validates the Google Chat parity working tree against the known-good
Centaur VPS control deployment. The control is `origin/main` commit
`bb37a15396bcc2e823b95ea26c523be993bf167d`. The candidate is the parity work
rebased onto that commit after preserving main's message-query controls.

Production remains the control throughout the test. Candidate workloads use a
dedicated namespace, Helm release, database, repository cache, Secrets, ingress
hostname, Google Chat test app, Workspace test spaces, and DWD test users. Every
task maps one-to-one to a test with the same numeric suffix. A task is incomplete
until its test passes and sanitized evidence is recorded in
`docs/google-chat-parity-verification.md` against one immutable candidate SHA and
image-digest set.

## 1. Requirements & Constraints

- **REQ-001**: Pin the production control to commit `bb37a15396bcc2e823b95ea26c523be993bf167d` and record every running Centaur image tag and digest before candidate deployment.
- **REQ-002**: Rebase or replay the parity implementation onto the pinned control before building candidate images. Do not test a candidate based only on `e143b10ff0a5850b73b6e82f412686de75229fdc`.
- **REQ-003**: Preserve main's `list-messages` controls: `--page-token`, `--filter`, `--order-by`, `--all-pages`, and `--max-pages`. Carry `order_by` through Python, api-rs, googlechatbot, and the Google `orderBy` query parameter.
- **REQ-004**: Replace main's invalid quoted thread-filter fixture with the official unquoted grammar, for example `thread.name = spaces/AAAA/threads/TTTT`.
- **REQ-005**: Test all parity areas: ingress, identity, permissions, spaces, DMs, threads, messages, actions, reactions, files, Drive, rendering, durable state, recovery, ETL, deletion, RLS, retention, metrics, deployment, and agent CLI behavior.
- **REQ-006**: Run all deterministic gates and Kind fault tests before creating any VPS candidate workload.
- **REQ-007**: Build every candidate image from one clean candidate commit and deploy by immutable digest. Record the commit-to-digest mapping.
- **REQ-008**: Keep the production namespace `centaur`, release `centaur`, webhook hostname, Secrets, database, ingress objects, and existing sandbox pods unchanged.
- **REQ-009**: Use namespace and Helm release `centaur-gchat-parity-canary`. Use repository-cache host path `/var/lib/centaur/repos-gchat-parity-canary`; never mount `/var/lib/centaur/repos` into candidate workloads.
- **REQ-010**: Use `kubectl --kubeconfig="$HOME/.kube/config"` on `jaume@centaur-vps`. Do not use the unreadable `/etc/rancher/k3s/k3s.yaml` and do not use `sudo`.
- **REQ-011**: Use a dedicated non-production Google Cloud project, Chat app, Add-on configuration, service account, OAuth client, test spaces, and test Workspace users. Do not repoint the production Chat app.
- **REQ-012**: Use separate DWD test subjects for upload, reaction reads, Drive reads, and DM history/setup roles. Grant only the scopes named in the parity plan.
- **REQ-013**: After TASK-006 sets `CANDIDATE_SHA`, prefix every live-created Google resource and message marker with `centaur-parity-${CANDIDATE_SHA:0:12}`. Delete only resources carrying that exact ownership marker.
- **REQ-014**: Store only timestamps, status codes, enum values, byte counts, retry counts, hashes, image digests, and hashed resource identifiers in evidence. Do not store message bodies, email addresses, bearer tokens, service-account JSON, OAuth tokens, or raw event payloads.
- **REQ-015**: Compare structural outcomes rather than model prose: accepted/rejected status, acknowledgement latency, exactly one execution, exactly one final answer, thread placement, attachment hash, deletion convergence, and metric deltas.
- **REQ-016**: Keep candidate test data in the candidate database. Do not restore or clone production private-message data into the candidate.
- **REQ-017**: Keep the canary for at most 24 hours. Remove the canary release, namespace, ingress, test Chat configuration, test messages/files, DWD grants created for the test, and candidate repository-cache directory after evidence capture.
- **SEC-001**: Candidate sandboxes receive only a short-lived Console JWT. Google credentials and googlechatbot internal credentials must remain outside sandbox files, environment, command lines, logs, and API responses.
- **SEC-002**: Candidate NetworkPolicy must allow api-rs to googlechatbot and deny direct sandbox/workflow access to googlechatbot. Candidate services must not resolve or route to production services.
- **SEC-003**: Every unauthorized space, operation, DM target, attachment, and delegated subject must fail before the Google token exchange or upstream API call.
- **SEC-004**: Signed ingress must remain fail-closed in every live mode. Negative cases include wrong issuer, signer, audience, client ID, domain, subject, stale `iat`, invalid `exp`, missing bearer, and replay.
- **CON-001**: Do not restart, scale, roll out, delete, or patch production deployments or existing sandbox pods during this plan.
- **CON-002**: Do not treat old production logs as candidate evidence. Control logs establish baseline behavior only.
- **CON-003**: Do not deploy until the semantic conflict with main commit `bb37a153` is fixed and its original query-control acceptance tests pass on the scoped-proxy architecture.
- **CON-004**: Do not claim release verification while any required live Workspace, DWD, browser, or same-immutable-evidence test remains pending.
- **CON-005**: The four running production sandbox proxy sidecars on `sha-980e5e3b05ede1c4ec1b11b68ed53cba30bca05a` remain untouched. Candidate comparisons use newly created candidate sandboxes only.
- **GUD-001**: Execute phases in order. Stop at the first failed phase and preserve redacted diagnostics before cleanup.
- **GUD-002**: Reuse `scripts/verify-google-chat-network-policy-kind.sh`, `scripts/verify-google-chat-runtime-kind.sh`, `scripts/verify-google-chat-parity-ledger.sh`, and existing service test commands.
- **VER-001**: Every TEST item must emit a machine-readable pass/fail result plus candidate SHA, image digests, environment, start/end timestamps, and artifact hashes.
- **VER-002**: Abort candidate testing if production loses readiness for more than 60 seconds, produces a new Google Chat 5xx/authentication failure during the comparison window, or receives any candidate test event.
- **VER-003**: A successful canary does not authorize production rollout. Production rollout requires a separate explicit request.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Freeze the working production control and create a main-compatible candidate.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | From `jaume@centaur-vps`, capture a sanitized control manifest using `kubectl --kubeconfig="$HOME/.kube/config"`: Helm release revision, deployment generation/readiness, pod start times, image tags, image IDs, probe paths, and counts grouped by image. Assert googlechatbot, api-rs, Console, and the primary iron-proxy deployment use `sha-bb37a15396bcc2e823b95ea26c523be993bf167d`. Record the four older running sandbox proxy sidecars separately. Verification: TEST-001. | | |
| TASK-002 | Exercise only the designated production test space. Record one signed event, acknowledgement latency, one execution, one visible final, and zero duplicate finals without logging content. Run the deployed `google-chat list-messages --help` check and hash the live `cli.py` and `client.py`; require both hashes to match `origin/main`. Verification: TEST-002. | | |
| TASK-003 | Reconcile `tools/comms/google_chat/client.py`, `tools/comms/google_chat/cli.py`, `tools/comms/google_chat/tests/test_client.py`, and `tools/comms/google_chat/tests/test_cli.py` with `bb37a153`. Reuse the parity client's existing bounded scan helper for `--all-pages`; add `order_by` to the tool client, `GoogleChatListQuery` in `services/api-rs/crates/centaur-api-server/src/google_chat_proxy.rs`, the internal messages route in `services/googlechatbot/src/index.ts`, and `ChatEdgeClient.listMessages` forwarding. Preserve `page_token`, `filter`, bounds, continuation, and repeated-token rejection. Replace every quoted thread-resource filter fixture with unquoted official syntax. Verification: TEST-003. | | |
| TASK-004 | Separate the Slack fetch/SSE test repairs and `centaur-session-runtime` adoption-test-only edits from Google Chat product changes in commit history. Keep them only if their independent suites require them; exclude them from Google Chat feature claims and image-diff reporting. Verification: TEST-004. | | |
| TASK-005 | Fetch the current official Chat and Drive discovery documents. Assert Chat revision `20260809`, Drive revision `20260810`, messages-list query fields, create/setup IDs, `showDeleted`, upload maximum, User/Attachment schemas, Drive export and Vids contracts. Save only revisions and assertion results. Verification: TEST-005. | | |
| TASK-006 | Create one clean candidate commit on top of `bb37a153`; require `git merge-base --is-ancestor bb37a153 "$CANDIDATE_SHA"`, an empty `git status --short`, and `git diff --check`. Record `CANDIDATE_SHA` and never rebuild candidate tags from another tree. Verification: TEST-006. | | |

### Implementation Phase 2

- GOAL-002: Prove the immutable candidate locally and in disposable Kind before VPS use.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Run the Google Chat bot typecheck and isolated full suite three consecutive times, then run the signed fixture smoke. Require 0 failures on all runs and stable test counts. Commands: `pnpm --filter googlechatbot run check:types`, `pnpm --filter googlechatbot run test`, and `pnpm --filter googlechatbot run smoke`. Verification: TEST-007. | | |
| TASK-008 | Run `.github/scripts/run-tool-tests.sh`; the latest-main 10-test Google Chat query-control suite adapted to the proxy; Google ETL/workflow tests; Rust proxy/broker/SQLx tests; Console model/controller/migration/JWT tests; Slack reference typecheck/tests; Helm lint/schema/render; docs build; and `scripts/verify-google-chat-parity-ledger.sh`. Verification: TEST-008. | | |
| TASK-009 | Build googlechatbot, api-rs, Console, agent, and iron-proxy images from `CANDIDATE_SHA`. Tag them `sha-$CANDIDATE_SHA`, push once, resolve registry digests, and write a manifest mapping component, Git SHA, tag, digest, build timestamp, and source-tree hash. Reject mutable tags such as `latest`. Verification: TEST-009. | | |
| TASK-010 | Run `scripts/verify-google-chat-network-policy-kind.sh` and `scripts/verify-google-chat-runtime-kind.sh` using the digest-equivalent candidate images. Require two ready replicas, state readiness, api-rs-only internal access, sandbox/workflow denial, durable obligation recovery after killing the processing pod, exactly one final, and no stranded thinking message. Verification: TEST-010. | | |

### Implementation Phase 3

- GOAL-003: Provision an isolated VPS canary with no production dependency or route overlap.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-011 | Provision the dedicated Google test project/app, Add-on signer, OAuth client, service account, DWD test subjects/scopes, one named test space, one group chat, one human-to-app DM, one binary Drive file, and supported Google-native files. Record hashed identifiers and scope names only. Verification: TEST-011. | | |
| TASK-012 | Create a candidate Helm values file containing `fullnameOverride: centaur-gchat-parity-canary`, candidate image digests, `googlechatbot.replicaCount: 2`, a dedicated ingress hostname, `repoCache.hostPath: /var/lib/centaur/repos-gchat-parity-canary`, candidate-only Secret names, candidate Postgres, and production bots disabled. Render with `helm template`; reject any production hostname, Secret name, service name, selector, PVC, repository-cache path, or namespace. Verification: TEST-012. | | |
| TASK-013 | On the VPS create namespace `centaur-gchat-parity-canary`, install Helm release `centaur-gchat-parity-canary`, and wait for all candidate workloads. Require candidate digests, two ready googlechatbot replicas, `/health/live`, `/health/ready`, metrics scrape annotations, connected state, and zero references to production services. Do not patch production. Verification: TEST-013. | | |
| TASK-014 | Start a control guard that samples production deployment readiness, Google Chat error counters, and pod restarts every 15 seconds for the full canary window. The guard must stop the plan when VER-002 triggers. Record counts only. Verification: TEST-014. | | |

### Implementation Phase 4

- GOAL-004: Validate every official ingress and identity contract through the candidate endpoint.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-015 | Configure the candidate release for `chat_api_project`. Send real named-space, group-chat, DM, mention, slash-command, add/remove-space, and card-click events from the dedicated Chat app. Require correct acceptance/addressing and project-number audience. Verification: TEST-015. | | |
| TASK-016 | Upgrade only the candidate release to `chat_api_url`. Send the same applicable event matrix. Require the exact endpoint audience and rejection of a project-number token. Verification: TEST-016. | | |
| TASK-017 | Upgrade only the candidate release to `workspace_addon`. Exercise message, button, app command, form/dialog submission, system token, verified user token, allowed DM identity, shared-space identity suppression, and domain denial. `widgetUpdatedPayload`, App Home, and dialog UI responses remain explicitly unsupported. Verification: TEST-017. | | |
| TASK-018 | Run the complete negative authentication matrix for all three modes plus redelivery. Require 401/403 as specified, durable dedupe across replicas, no bearer/user token in the persisted envelope or logs, and exactly one execution after duplicate delivery. Verification: TEST-018. | | |

### Implementation Phase 5

- GOAL-005: Validate permissions and the sandbox-visible agent surface against production behavior.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-019 | Through the candidate Console, create principal and role grants for one allowed space, one denied space, each operation flag, and one exact DM target. Verify API CRUD, OR merge, cache invalidation, short-lived JWT claims, malformed-resource rejection, target immutability, narrow/wide browser rendering, keyboard operation, and screenshots. Verification: TEST-019. | | |
| TASK-020 | From a newly created candidate sandbox, run `spaces`, `space-info`, `members`, `list-messages`, `thread`, `search`, `questions`, `dump`, and `feedback`. For `list-messages`, verify page token, unquoted filter, `DESC`, bounded all-pages, continuation at the cap, and repeated-token rejection. Prove the sandbox contains no Google/internal credential and every operation uses the candidate api-rs scoped proxy. Verification: TEST-020. | | |
| TASK-021 | Run exact-email DM setup/send, reuse, participant confirmation, requester-scoped history, invalid resource-name targets, ungranted email, wrong domain, and removed-subject denial. Require token exchange only after the target grant passes. Verification: TEST-021. | | |

### Implementation Phase 6

- GOAL-006: Validate messages, reactions, files, Drive, and historical convergence with owned test data.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-022 | Exercise named-space and DM sends, thread replies, mention/follow-up behavior, cards, Markdown conversion, 32,000-byte splitting, stable IDs, status/final rendering, edit/delete ownership, stop/interrupt, sticky overrides, action dedupe, and exactly one canonical final. Compare structural outcomes with the production test-space baseline. Verification: TEST-022. | | |
| TASK-023 | Add and remove multi-page reactions. Verify delegated read scope, message-qualified paging, cross-replica 15/sec reservations, convergence after removal, denied reader behavior, and reaction summaries in agent/ETL output. Verification: TEST-023. | | |
| TASK-024 | Upload/download owned fixtures at below 25 MiB, 25 MiB, 25 MiB plus one byte, 100 MiB, and 100 MiB plus one byte. Verify multipart upload, author identity, metadata, chunk reconstruction, SHA-256, MIME/HTML/redirect rejection, wrong-space denial, aggregate limits, and cleanup. Verification: TEST-024. | | |
| TASK-025 | Test ordinary Drive download plus Docs, Sheets, Slides, Drawings, Apps Script, and Vids. Verify `alt=media`, export MIME/extensions, below-10-MB native export, above-10-MB safe classification, Vids metadata-only behavior, missing scope, `canDownload=false`, redirects, and byte ceilings. Verification: TEST-025. | | |
| TASK-026 | Run candidate ETL over the owned named space and DM. Verify pagination/continuation, edits, Cards v1/v2 text, attachments, reactions, company projection, owner RLS, retention dry-run/delete, metrics, and both shared-space and delegated-DM create→sync→delete→resync tombstone cascades. Verification: TEST-026. | | |

### Implementation Phase 7

- GOAL-007: Validate resilience and quota behavior without touching production workloads.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-027 | During an owned candidate conversation, kill the processing googlechatbot pod at each durable boundary: after accepted envelope, during session stream, after final creation, and before obligation deletion. Require recovery by the second replica, one execution, one final, no duplicate/stale status, bounded retry budget, and deleted obligation. Verification: TEST-027. | | |
| TASK-028 | Generate a controlled same-space candidate burst and inject 429/500/502/503/504/transport failures through a candidate-only fault proxy. Verify distributed 1/sec writes, 15/sec reaction reads, `Retry-After`, bounded exponential backoff, stable message IDs, no ambiguous multipart retry except 429, no duplicate final, and exported retry metrics. Verification: TEST-028. | | |

### Implementation Phase 8

- GOAL-008: Produce the release decision and remove all candidate-owned state.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-029 | Compare control and candidate evidence for readiness, ingress acceptance, acknowledgement latency, execution/final cardinality, thread placement, errors, and resource cleanup. Rerun every deterministic gate on `CANDIDATE_SHA`. Mark a parity row `Passed` only when its local and live evidence use the same immutable SHA/digests. Verification: TEST-029. | | |
| TASK-030 | Delete only resources with the exact candidate ownership marker, uninstall Helm release `centaur-gchat-parity-canary`, delete namespace `centaur-gchat-parity-canary`, remove the dedicated ingress/DWD grants/test app configuration, and delete `/var/lib/centaur/repos-gchat-parity-canary` after confirming no pod mounts it. Verify production images, readiness, restart counts, routes, Secrets, database, old sandboxes, and test-space behavior are unchanged from TEST-001 except expected control traffic. Verification: TEST-030. | | |

## 3. Alternatives

- **ALT-001**: Deploy the parity build directly over production and roll back on failure. Rejected because authentication, DWD, migrations, state, proxy, and deletion paths need evidence before they can safely replace the working control.
- **ALT-002**: Replay production webhook payloads into the candidate. Rejected because payloads can contain private content and a Google JWT does not bind the request body. Use synthetic fixtures and dedicated live Workspace resources instead.
- **ALT-003**: Run only local/Kind tests. Rejected because Workspace policies, DWD grants, signed Google tokens, attachment behavior, Drive export limits, and tombstone convergence require Google-controlled evidence.
- **ALT-004**: Mirror every production request to the candidate. Rejected because duplicate side effects and private-data propagation violate isolation. Structural A/B scenarios in dedicated spaces provide the needed comparison.
- **ALT-005**: Recycle the four older production sandbox proxies to homogenize versions. Rejected because it changes the working control and is unnecessary for candidate validation.

## 4. Dependencies

- **DEP-001**: SSH access to `jaume@centaur-vps` and readable `$HOME/.kube/config` with namespace-scoped create/read/delete permissions for `centaur-gchat-parity-canary` plus read-only access to production status/log counters.
- **DEP-002**: Registry permission to push candidate images and resolve immutable digests.
- **DEP-003**: A dedicated DNS/TLS hostname routing only to the candidate Google Chat ingress.
- **DEP-004**: A dedicated Google Cloud project with Chat API configuration, Workspace Add-on deployment, service account, OAuth client, and admin-approved test-only DWD scopes.
- **DEP-005**: Dedicated same-domain test users for DM setup/history, upload, reaction reads, and Drive reads; none may be a personal or production automation account.
- **DEP-006**: One dedicated production control test space and separate candidate named space, group chat, DM, and Drive fixtures.
- **DEP-007**: Disposable candidate Postgres storage and permission to run Console migrations `20260813000000`, SQLx migrations `0054` and `0055`, and candidate-only retention.
- **DEP-008**: Local Docker/Kind, Bun/pnpm, Rust, Ruby, Python/uv, Helm, kubectl, and the repository's existing test dependencies.

## 5. Files

- **FILE-001**: `plan/process-google-chat-parity-vps-canary-validation-1.md` — executable canary validation plan.
- **FILE-002**: `tools/comms/google_chat/client.py` — restore `order_by` and bounded query-control propagation on the scoped proxy.
- **FILE-003**: `tools/comms/google_chat/cli.py` — preserve all latest-main `list-messages` controls.
- **FILE-004**: `tools/comms/google_chat/tests/test_client.py` — proxy-aware query and official-filter tests.
- **FILE-005**: `tools/comms/google_chat/tests/test_cli.py` — combined latest-main and parity CLI tests.
- **FILE-006**: `services/api-rs/crates/centaur-api-server/src/google_chat_proxy.rs` — validate and forward `order_by` and unchanged paginated query controls.
- **FILE-007**: `services/googlechatbot/src/index.ts` — forward scoped list query controls to the REST client.
- **FILE-008**: `services/googlechatbot/src/chat/client.ts` — official `orderBy`, filter, page-token, and paging behavior.
- **FILE-009**: `contrib/chart/values-google-chat-parity-canary.example.yaml` — non-secret isolated candidate values and production-collision safeguards.
- **FILE-010**: `scripts/verify-google-chat-vps-canary.sh` — guarded, redacted automation for TEST-001 through TEST-030; it must refuse namespace `centaur` and any release other than `centaur-gchat-parity-canary`.
- **FILE-011**: `docs/google-chat-parity-verification.md` — immutable control/candidate evidence and final status.
- **FILE-012**: `docs/google-chat-official-spec-conformance.md` — Drive revision `20260810`, query-control evidence, and live candidate status.
- **FILE-013**: `docs/slack-vs-google-chat-n-to-n-comparison.md` — current main/VPS baseline and post-canary result.

## 6. Testing

- **TEST-001**: Assert the captured production control manifest matches `bb37a153`, all core workloads are Ready, immutable image IDs exist, and old sandbox sidecars are separately counted.
- **TEST-002**: Assert the production test-space event completes exactly once and live tool hashes/options match `origin/main`; record no message content.
- **TEST-003**: Run the combined query-control tests. Assert all five CLI controls, unchanged query parameters across pages, unquoted thread grammar, api-rs validation, bot forwarding, continuation, cap, and repeated-token rejection.
- **TEST-004**: Use `git diff --name-only` and image-layer/source manifests to prove Slack and test-only runtime edits are separated from Google Chat product claims.
- **TEST-005**: Run `jq -e` assertions against Chat discovery `20260809` and Drive discovery `20260810`; fail on a revision or modeled-contract change.
- **TEST-006**: Assert pinned-main ancestry, clean status, no conflict markers, `git diff --check`, and one recorded candidate SHA.
- **TEST-007**: Require three identical green bot runs, typecheck, and smoke with zero failure/background-error output.
- **TEST-008**: Require all repository service matrices named in TASK-008 to pass and store hashed logs tied to `CANDIDATE_SHA`.
- **TEST-009**: Verify registry digests, OCI revision labels, and source-tree hash all identify `CANDIDATE_SHA`; reject mutable or missing digests.
- **TEST-010**: Require both Kind scripts plus durable recovery assertions to pass with candidate-equivalent images.
- **TEST-011**: Verify dedicated app/project/users/spaces/files exist, scopes are least-privilege, identifiers are hashed in evidence, and no production identity is used.
- **TEST-012**: Parse rendered Kubernetes YAML and fail on any production namespace, hostname, Secret, service, selector, PVC, or repository path reference.
- **TEST-013**: Assert candidate-only names/digests, two ready bot replicas, connected state, probe/metric success, and zero production service endpoints.
- **TEST-014**: Assert the control guard sampled continuously and no abort threshold occurred.
- **TEST-015**: Require the complete project-number event matrix and wrong-audience rejection.
- **TEST-016**: Require the URL-audience event matrix, exact audience acceptance, and project-token rejection.
- **TEST-017**: Require Add-on system/user token, event-envelope, verified-DM identity, shared-space suppression, and domain-denial outcomes.
- **TEST-018**: Require every auth negative case, token-free persistence/logging, cross-replica dedupe, and exactly-one execution.
- **TEST-019**: Require Console/API/JWT permission assertions plus actual narrow/wide keyboard interaction and screenshots.
- **TEST-020**: Require every agent command, query control, scoped proxy route, truncation signal, denial case, and sandbox credential-absence assertion.
- **TEST-021**: Require allowed DM setup/reuse/history/send and every target/DWD denial without premature token exchange.
- **TEST-022**: Require all message/render/action/mutation cases, ownership denial, structural control comparison, and exactly one final.
- **TEST-023**: Require paged reaction convergence, distributed pacing, denied-reader classification, and agent/ETL projection.
- **TEST-024**: Require upload/download boundary, MIME, authorization, reconstruction, SHA-256, and cleanup assertions.
- **TEST-025**: Require all binary/native Drive paths, MIME/extensions, separate export ceiling, Vids classification, denial, and cleanup assertions.
- **TEST-026**: Require ETL continuation/edit/card/file/reaction/DM/RLS/retention/metric assertions and both deletion-convergence cascades.
- **TEST-027**: Require exactly-one recovery at each crash boundary with no stale status or obligation.
- **TEST-028**: Require distributed quota timing, bounded retry classes, stable IDs, no unsafe upload replay, and retry metrics.
- **TEST-029**: Require the control/candidate comparison and every TEST-001 through TEST-028 result on one immutable evidence set before a release recommendation.
- **TEST-030**: Require candidate resource cleanup and a post-cleanup production manifest equal to TEST-001 for all protected fields.

## 7. Risks & Assumptions

- **RISK-001**: A chart naming/selector collision could affect production. Mitigation: render-and-parse collision checks before namespace creation and exact namespace/release refusal guards in the VPS script.
- **RISK-002**: A test Chat app could be configured with the production endpoint. Mitigation: dedicated project and hostname; TEST-011 verifies endpoint and project separation before sending an event.
- **RISK-003**: DWD misconfiguration could grant broader tenant access. Mitigation: separate subjects, exact scopes, test-only users, denial cases, and removal during cleanup.
- **RISK-004**: Candidate database migrations could target production. Mitigation: candidate-only Secret/database and rendered DSN-host assertion before migration.
- **RISK-005**: Live file/export tests could leave Workspace data. Mitigation: exact ownership markers, hashed inventory, and cleanup verification.
- **RISK-006**: Fault injection could reach production. Mitigation: candidate-only fault proxy, NetworkPolicy, distinct service DNS, and no production service endpoints.
- **RISK-007**: Model nondeterminism prevents text equality. Mitigation: compare structural outcomes and sentinels, not prose.
- **RISK-008**: Existing production sandbox sidecars are version-mixed. Mitigation: preserve them as observed control state and use only newly created candidate sandboxes for parity validation.
- **RISK-009**: Google may change discovery during execution. Mitigation: TEST-005 fails closed and requires conformance review before further live testing.
- **ASSUMPTION-001**: `bb37a153` remains the intended control for this validation. If production changes, restart from TASK-001 and create a new plan version rather than editing recorded control evidence.
- **ASSUMPTION-002**: Candidate testing is authorized only in dedicated test spaces/users/files and does not authorize inspection of unrelated production content.
- **ASSUMPTION-003**: The candidate can use a dedicated public HTTPS ingress without changing the production ingress controller configuration.
- **ASSUMPTION-004**: Namespace deletion and candidate-owned Google resource cleanup are permitted after the validation window.

## 8. Related Specifications / Further Reading

- [Google Chat parity implementation plan](./feature-google-chat-slack-parity-1.md)
- [Slack vs Google Chat N-to-N comparison](../docs/slack-vs-google-chat-n-to-n-comparison.md)
- [Google Chat official-spec conformance](../docs/google-chat-official-spec-conformance.md)
- [Google Chat parity verification ledger](../docs/google-chat-parity-verification.md)
- [Google Chat messages.list](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/list)
- [Verify requests from Google Chat](https://developers.google.com/workspace/chat/verify-requests-from-chat)
- [Workspace Add-on alternate runtimes](https://developers.google.com/workspace/add-ons/guides/alternate-runtimes)
- [Google Chat usage limits](https://developers.google.com/workspace/chat/limits)
- [Download and export Drive files](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
