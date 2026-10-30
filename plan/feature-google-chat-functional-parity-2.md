---
goal: Implement and prove Google Chat equivalents of recent upstream Slack functionality
version: 1.0
date_created: 2026-10-29
last_updated: 2026-10-30
owner: Centaur maintainers
status: 'In progress'
tags: [feature, google-chat, slack, parity, verification]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

Implement functional parity against upstream `5e94d92e0fcefae03a799c3a018e6f6cd03d9f1d`, starting from fork `8f40438219fee79e26e834eacbffdc64dc49ce74`. Claude Code must use `claude-fable-5-1` for implementation. Preserve a reviewable working tree and evidence for the exact final code. The requested live destination is the existing operator-designated chat; resolve its exact resource before testing.

## 1. Requirements & Constraints

- **REQ-001**: A mentioned stop command and a Stop control on the thinking acknowledgement interrupt the actual api-rs execution while rendering remains open. A stop during execution startup prevents or interrupts that execution. A stale Stop control cannot stop a later execution.
- **REQ-002**: An explicit mention enables contextual participation for that thread. Unmentioned messages in eligible, enabled spaces are classified using recent thread history. Declines and classifier failures remain silent. Unmentioned messages never append to an active execution. Stop disables participation until a new mention.
- **REQ-003**: Obtain unmentioned space messages through an authenticated, bounded event source, using the existing Google API client and durable state. Merely accepting synthetic MESSAGE envelopes is insufficient. Preserve verified requester identity and exact space permissions. Deduplicate events and never process app/self messages.
- **REQ-004**: Support optional reactions on the original message, with cleanup on completion and stop. Google reaction writes require user authentication. Use an explicitly configured delegated reaction actor with the required scope, and document that actor identity. Keep the thinking message as the default fallback. Reaction failures must not block execution or rendering.
- **REQ-005**: Port upstream classifier and model-selection changes from #2082, #2087 and #2068 into Google Chat, preserving deterministic explicit flags, validation, timeouts and failure behavior. Include current alias mappings and GPT-6.1 Terra. Do not change the bot's default execution model solely because implementation uses Fable 5.1.
- **REQ-006**: Provide bounded graceful shutdown draining and safe durable restart recovery. Repair the pending-work discoverability and ownership-checked lease boundaries needed to substantiate recovery claims. Do not replace durable coordination with process-only state.
- **REQ-007**: Permit existing sandbox admin operations from an authenticated Google Chat DM linked to an active Console admin. Require the existing verified Google identity link, current requester's match and exact DM identity. Refuse shared spaces, other users, disabled users, non-admins, replay and cross-namespace access. Keep Slack authorization unchanged. Provide thin Google Chat space/DM permission set/remove commands equivalent to Slack channel permission administration, reusing GoogleChatPermissionApi validation.
- **REQ-008**: Retain already ported OMP, GPT-6.1 Sol, persona model pins, harness restrictions, source citations and paragraph boundaries. Document Slack-specific features with their functional Google equivalent.
- **SEC-001**: Verify events before identity extraction or mutation. Stop-card parameters and Google resource names are untrusted. Bind cancellation to its originating thread/execution and validate the sender's applicable authority.
- **SEC-002**: Never print, commit or place credentials in prompts or evidence. Use configured secret providers. Do not send messages outside the requested test destination.
- **CON-001**: Do not commit, push, open a PR, merge, deploy to production, restart production or change Google admin/OAuth configuration without a later explicit request. Local isolated stacks and test messages in the requested chat are within verification scope.
- **CON-002**: Run Kubernetes operations with an explicit local context. Ambient context at task start is production. Any live validation requiring deployment of new code must be recorded as a missing gate until authorized.
- **CON-003**: Prefer current repository helpers, standard library and installed dependencies. Avoid a broad upstream merge. Keep evidence claims narrower than the actual check.
- **PAT-001**: Follow root, services and nearest service AGENTS.md. Keep orchestration in api-rs, transport in googlechatbot, and admin authorization in Console.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Establish a concrete baseline, source contracts and reproducible cancellation failure.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create isolated branch `feat/google-chat-functional-parity-20261029` from origin/main. Record baseline and upstream SHAs. Confirm Claude Code reports canonical model `claude-fable-5-1`. | yes | 2026-10-29 |
| TASK-002 | Read services/googlechatbot/src/index.ts, state.ts, renderer.ts, config.ts, chat/client.ts, chat/types.ts and all callers before editing. Compare upstream #1973, #2081, #2082, #2083, #2087 and #2068. Read Console sandbox admin authentication and tests. | yes | 2026-10-29 |
| TASK-003 | Add a regression that holds a live rendering stream open, submits stop through the authenticated ingress, and asserts api-rs interrupt arrives before releasing that stream. Add startup-race and stale-card cases. | yes | 2026-10-29 |

### Implementation Phase 2

- GOAL-002: Implement chat behavior, state and runtime wiring. Depends on Phase 1.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | In services/googlechatbot/src/index.ts and state.ts, separate cancellation from render serialization; persist stop intent and bind action cancellation to the expected execution. Add Stop cards through chat/types.ts, renderer.ts and chat/client.ts as required. | yes | 2026-10-30 |
| TASK-005 | Add upstream-equivalent proactivity classification, durable per-thread eligibility, configured space restrictions, identity resolution and bounded real event collection. Update config.ts, server.ts and chart values/templates/schema together. | yes | 2026-10-29 |
| TASK-006 | Add optional delegated create/delete reaction support in chat/client.ts and token scope selection. Add initial-message acknowledgement and steering cleanup with a harmless fallback when delegation is absent or rejected. Update configuration, chart and tests. | yes | 2026-10-29 |
| TASK-007 | Update overrides.ts, response-context.ts and message-overrides-strategy.ts to upstream selections/classifier contracts. Port relevant evaluation fixtures and regression cases without importing Slack transport dependencies. | yes | 2026-10-30 |
| TASK-008 | Add bounded drain in server.ts and runtime lifecycle. Replace bounded rolling discovery with authoritative pending-work discovery and atomic ownership-checked leases. Verify concurrent ownership, expiry, crash and replay against real PostgreSQL. | yes | 2026-10-29 |

### Implementation Phase 3

- GOAL-003: Implement Google Chat DM administration. May run independently of Phase 2 after baseline inspection.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-009 | Update services/console/app/controllers/concerns/sandbox_admin_authentication.rb and existing related policy/tool availability code to admit only a verified, linked Google Chat admin DM. Inspect all callers. Keep Slack home-workspace checks intact. | yes | 2026-10-29 |
| TASK-010 | Add Console authentication/authorization regressions covering admin DM success, shared-space denial, requester mismatch, disabled/non-admin users, missing identity, namespace isolation and existing Slack cases. Run the affected Rails suite using local PostgreSQL. | yes | 2026-10-29 |

### Implementation Phase 4

- GOAL-004: Verify the final change and record exact evidence. Depends on Phases 2 and 3.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-011 | Install root pnpm dependencies with the frozen lockfile. Run googlechatbot type checks, complete service tests, signed smoke, affected shared package/Slack regressions, classifier evaluations, Console focused checks and git diff --check. | yes | 2026-10-30 |
| TASK-012 | Build the changed googlechatbot runtime image using the repository Dockerfile. Extend scripts/verify-google-chat-runtime-kind.sh or a focused sibling to exercise real Postgres, HTTP ingress, open SSE, cancellation, event dedupe, restart and exactly one canonical final on the built image in explicit isolated Kind context. | yes | 2026-10-30 |
| TASK-013 | Resolve the requested Chat resource. With the existing authorized test identity, verify actual Google reaction/create/delete and card payload acceptance. Verify classifier decisions with the configured provider. Record separate gates for any feature that cannot run on the new code without an authorized deployment. | pending | |
| TASK-014 | Review the complete diff and connected callers. Fix failures, rerun affected checks, then write docs/google-chat-functional-parity-evidence.md with source hashes, runtime image digest, commands, observations, test counts and explicit missing gates. Update README.md, SLACK_PARITY.md and operator docs to match actual behavior. | yes | 2026-10-30 |

The final corrected local candidate passed 577 Google Chat tests across 28 files, all seven packaged PostgreSQL proof scenarios, and the exact-image two-replica Kind recovery check. Workspace add-on callback routing, human clicker verification, startup Stop ordering, cached classification policy and stale recovery ownership are corrected and covered by regressions. Provider evaluations ran and exposed inferred Claude effort differing from upstream Slack. The user approved the direct correction after Claude Code exhausted its quota. The correction, regression, affected checks, final packaged proof and exact-image Kind recovery all pass; TASK-007 and TASK-011 are complete. Provider decision mismatches remain documented as quality limitations, including the shared upstream holdout failures. TASK-013 remains pending for deployment and candidate-driven live execution verification; real reaction create/delete now passes after the approved grant. Corrected disabled Stop cards were accepted and removed by Google in both approved destinations; no callback was exercised. The evidence record identifies the exact final source and images. Source PR #198 is merged and the approved credential/delegation setup is complete; deployment has not started.

## 3. Alternatives

- **ALT-001**: Enable GOOGLECHATBOT_FOLLOW_UP_THREADS alone. Rejected because it neither collects ordinary space messages nor classifies whether a reply is appropriate.
- **ALT-002**: Treat Google's lack of bot-authenticated reaction writes as completed parity. Rejected. Implement delegated reactions with explicit authorship and preserve the app acknowledgement fallback.
- **ALT-003**: Copy Slack native Stop transport events. Rejected because Google uses card interactions; reuse the durable interrupt contract instead.
- **ALT-004**: Merge all upstream commits. Rejected because the goal requires focused Google Chat compatibility, not unrelated upstream changes.

## 4. Dependencies

- **DEP-001**: Claude Code 2.1.312 and confirmed access to claude-fable-5-1.
- **DEP-002**: Existing Bun/pnpm workspace, Docker, Kind, Helm, local PostgreSQL and Console Ruby toolchain.
- **DEP-003**: A configured Google service account and a delegated actor with reaction-write authority for live reaction verification; no new credential may be requested or exposed.
- **DEP-004**: Authenticated unmentioned-message collection and classification provider access for live contextual-reply evidence.
- **DEP-005**: Exact requested Chat space resource and a route to test changed code without replacing production.

## 5. Files

- **FILE-001**: services/googlechatbot/src/{index,state,renderer,config,server,overrides,response-context,message-overrides-strategy}.ts and adjacent tests.
- **FILE-002**: services/googlechatbot/src/chat/{client,types,token,normalize}.ts and adjacent tests.
- **FILE-003**: services/googlechatbot/src/proactive-classifier.ts and focused event-collection/lifecycle modules only where existing code cannot hold the behavior clearly.
- **FILE-004**: contrib/chart/{values.yaml,values.schema.json,templates/googlechatbot.yaml}, services/googlechatbot/.env.example and Dockerfile if required.
- **FILE-005**: services/console/app/controllers/concerns/sandbox_admin_authentication.rb, config/routes.rb, existing Google permission concerns, tools/infra/centaur-console client/CLI/skill and relevant tests.
- **FILE-006**: scripts/verify-google-chat-runtime-kind.sh, existing smoke/evaluation fixtures and a focused parity proof script if needed.
- **FILE-007**: services/googlechatbot/{README.md,SLACK_PARITY.md}, docs/pages/reference/google-chat.mdx and docs/google-chat-functional-parity-evidence.md.

## 6. Testing

- **TEST-001**: Mentioned stop and Stop card reach interrupt while original SSE remains open; startup stop cancels the correct execution; stale card cannot cancel a newer execution. A mentioned follow-up by the active requester must append while the original stream is open, while a different requester must not steer that turn. Status PATCHes must retain the Stop control; terminal PATCHes must remove it.
- **TEST-002**: First mention enables eligibility; meaningful unmentioned follow-up responds; thanks/person-addressed text does not; active runs are never steered; stop disables; fresh mention re-enables.
- **TEST-003**: Real event collection handles authentication, pagination/cursors, reconnect, duplicate delivery, self/bot filtering, exact spaces and requester identity without a new trust bypass.
- **TEST-004**: Delegated reaction endpoints use correct create/delete scopes and actor. Missing delegation and API errors leave turn execution healthy. Terminal and stopped turns clean up reactions.
- **TEST-005**: Explicit flags, new aliases, natural-language selection, unknown answers, provider errors/timeouts and evaluation fixtures preserve expected model/harness/reasoning output.
- **TEST-006**: Pending obligations remain discoverable after more than 2,000 later saves. Lease owner cannot renew/delete a successor. Restart replays one execution and delivers one canonical final.
- **TEST-007**: Google admin DM success and all trust-boundary denials, plus unchanged Slack admin behavior.
- **TEST-008**: Built-image Kind integration exercises transport, database, concurrency, process termination/replacement and final message assertions. Live Google checks are labelled separately from mocked endpoints.

## 7. Risks & Assumptions

- **RISK-001**: A delegated reaction is authored by the chosen Workspace user, not the bot. This is a Google API constraint, not an identity equivalence claim.
- **RISK-002**: New behavior cannot be proven in production before deploying it. Deployment is outside the current authorization; retain a precise unpassed gate if no isolated live route exists.
- **RISK-003**: Automatic contextual replies consume classifier calls and can respond to human conversation if the decision policy is too permissive. Default to explicit opt-in and fail silent.
- **RISK-004**: Existing direct-user credential grants make requester identity security-critical. New event and admin routes must preserve this boundary.
- **ASSUMPTION-001**: Functional parity allows Google-native controls and explicitly attributed delegated reactions, while preserving equivalent user outcomes where the platform permits them.
- **ASSUMPTION-002**: The user-requested chat is the sole live testing destination; exact resource resolution is required before any message or reaction.

## 8. Related Specifications / Further Reading

- [Existing parity plan](feature-google-chat-slack-parity-1.md)
- [Current parity status](../services/googlechatbot/SLACK_PARITY.md)
- [Existing verification ledger](../docs/google-chat-parity-verification.md)
- [Google reaction authentication](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages.reactions/create)
- [Google interaction events](https://developers.google.com/workspace/chat/receive-respond-interactions)
- [Google space event subscriptions](https://developers.google.com/workspace/events/guides/events-chat)

Publication and rollout were approved on 2026-10-30. Source PR #198 merged as
`a6fe14effd3c497f86aba2f56e3157024623ee12` and passed all six image-release
CI gates. Classifier API access is configured. The precise reaction-write scope
was added while preserving all existing scopes; real create/delete passed in
both approved destinations. Candidate-driven live execution remains pending.
The evidence record contains Google/upstream provider results and the focused
direct correction approved after Claude Code's exhausted weekly quota; it is now verified.
