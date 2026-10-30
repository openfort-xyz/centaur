# Google Chat functional parity evidence

Verified locally on 2026-10-30. The final candidate passes the checks below, including the Workspace add-on Stop payload contract. Live functional parity remains unproven. The candidate is not deployed, delegated reaction writes are not authorized, and provider-backed classifier evaluation needs working API access.

Plan: [feature-google-chat-functional-parity-2.md](../plan/feature-google-chat-functional-parity-2.md). Source baseline: `8f40438219fee79e26e834eacbffdc64dc49ce74`. Upstream comparison: `5e94d92e0fcefae03a799c3a018e6f6cd03d9f1d`. Implementation used Claude Code 2.1.312 with canonical model `claude-fable-5-1`, confirmed in CLI model-usage results. Fable applied the last ownership correction before reaching its weekly usage limit. No substitute model wrote production changes.

The final implementation fingerprint is `da5cf33f6bb461245edfd5f8a5e15ef116c48c6ab5ba9c3bef31d391cda682b7`, SHA-256 of the sorted path/content-hash manifest for 65 changed files, excluding this evidence file and the plan. All 65 file hashes were rechecked after verification and matched. Earlier candidate image IDs, counts and fingerprints are superseded by this record. The source is an uncommitted reviewable worktree. No source commit, push, PR, deployment or OAuth grant was made.

## Exact tested artifacts

These are immutable local Docker image IDs, not published registry digests.

| Artifact | Image ID | Evidence |
| --- | --- | --- |
| Google Chat bot, `centaur-googlechatbot:parity-20261030-final` | `sha256:db648b3957683b0d4b1e1f6ae5865e7dccb2949ef89e558663107bc141c46577` | All seven packaged PostgreSQL proof scenarios passed; exact-image Kind crash/recovery check passed |
| Console, `centaur-console:parity-20261029` | `sha256:db4ccf6929091a601c96ffe90fddddce02896884928898a4973f85c9e49fc3f7` | Packaged affected Rails suites passed, 198 tests and 935 assertions |
| Sandbox, `centaur-agent:parity-20261029` | `sha256:5e8050a445e9eadceeeddb089c1c1537233f38dc4648be5ef4a263366bc8c33d` | Normal non-root startup, tool discovery, CLI help and packaged Pi turn passed |

All 32 production Google Chat TypeScript files and the packaged proof script matched the final bot image byte-for-byte. The runtime manifest SHA-256 is `77a6aa03eedb8174508d69ea618250dff25da8389264154c357092cadc239f48`.

The sandbox test ran packaged Pi 1.4.0 and harness-server with `claude-fable-5-1` against a local Anthropic SSE fixture and obtained the expected normalized sentinel. It was not a live provider call. Codex 0.165.0 and OMP 18.13.2 version checks passed. Console and sandbox files did not change after their packaged checks.

## Requirement audit

| Requirement | Concrete local evidence | Live evidence or remaining gate |
| --- | --- | --- |
| REQ-001, manual Stop | Signed ingress interrupts the fixture execution while its SSE remains open. Delayed session creation starts no execution; delayed execute is interrupted. Status edits retain the control and terminal output removes it. Stale controls cannot interrupt or disable a successor, including equal event timestamps. | Corrected disabled cards were accepted in the approved shared space and DM. Candidate callbacks and executions are not deployed. |
| REQ-002, contextual participation | Mention enables participation; classified follow-up can reply; decline/error stays silent; active execution cannot be steered by an unmentioned message. Stop disables participation. A delayed pre-Stop mention cannot re-enable it; a fresh post-Stop mention can. Cached decisions recheck current opt-in, runtime enablement and exact space policy at recovery/handoff boundaries. | Actual provider quality and unmentioned-message behavior remain unverified. |
| REQ-003, ordinary message collection | Bounded app-authenticated polling, exact spaces, pagination, nanosecond cursor, durable dedupe, bot suppression and verified requester tests pass. Failed acceptance does not advance the cursor. | Google accepted the candidate's strict greater-than nanosecond filter with HTTP 200. Candidate poller is not deployed. |
| REQ-004, original-message reactions | Fixture OAuth/Google endpoints verify delegated actor, exact write scope, original trigger, create/delete and terminal cleanup. Rejected/missing delegation does not fail execution. Packaged proof created and deleted five fixture reactions. | Actual OAuth exchange returned HTTP 401 `unauthorized_client` for the write scope. No live reaction or grant was created. Reactions will be authored by the configured Workspace user. |
| REQ-005, classifiers/models | Explicit flags, aliases, Decisions API contract, timeouts, unknown answers and failure behavior pass. Evaluation adapters call shipped Google classifiers using upstream Slack datasets. Fable 5.1, Sonnet 5.5, Haiku 5.5 and GPT-6.1 Terra mappings are covered. | Both provider-backed evaluation commands remain unrun because usable classifier API access is absent. Unit fixtures do not establish model quality. |
| REQ-006, drain/restart | Real PostgreSQL ownership checks, pending discovery beyond 2,000 later entries, monotonic Stop state, independent lease deadlines and bounded release pass. Exact-image Kind test killed the active owner during SSE with two replicas, recovered without re-execute, delivered one final, cleared obligations and restored two ready replicas. | Production rollout/restart was not performed. First rollout requires Recreate because old and new lease schemes do not coordinate. |
| REQ-007, DM administration | Packaged Rails tests cover linked active admin success, verified current requester/email match, exact DM identity, shared-space/non-admin/disabled/mismatch/token/namespace denial and existing Slack policy. Thin Google permission commands reuse the existing API. | A read-only database transaction confirmed the approved DM already links the matching active admin and verified email. A new live DM-to-sandbox admin operation is pending. |
| REQ-008, retained behavior | Shared rendering tests and full Slack regressions pass. Pi validation/pricing, sandbox startup, model restrictions and existing parity ledger checks pass. Pi's GPT-6.1 Terra restriction follows upstream; supported harness alternatives remain available. | These support retention, not a claim that every older production behavior was retested live. |
| SEC-001, verified event/action identity | Forged and unsigned ingress is rejected. Add-on cards bind to the verified human clicker in `chat.user`, not the bot author in `message.sender`. Wrong/missing human and malformed actions are rejected. Cancellation is bound to originating work/execution. | The real add-on callback has not been exercised against the candidate. |
| SEC-002 and CON-001/002, authorized boundary | Local Kubernetes checks use a dedicated explicit context. Actual Google tests stayed in the approved AI space and operator DM. Evidence excludes private identifiers and credentials. | No remote deployment, configuration change or publication occurred. Live release needs explicit authorization. |

## Final checks

| Check | Result |
| --- | --- |
| Complete Google Chat suite with image-matching Bun 1.4.4 and PostgreSQL | 576 passed, zero failed, 2,005 assertions across 28 files |
| Packaged signed-ingress proof with real PostgreSQL | Seven scenarios passed, `result=PASS`, empty failures array |
| Parent independent cross-feature reproductions, memory state and mocked endpoints | Seven checks passed, covering startup opt-out/order, stale pending card, stale recovery, add-on human actor, cached policy and equal-timestamp ownership |
| Independent lease deadline reproductions | Hung renewal revoked after 300 ms; late success did not restore ownership; slow acquire refused; healthy renewal retained ownership; hung release returned after 301 ms; refused renewal revoked after 62 ms |
| Final bot image in isolated Kind | Authentication/probes, exact owner crash, one execute, recovered stream, one final, zero obligations, two ready replicas and pod replacement passed |
| Complete Slack suite, Bun 1.4.4 | 312 passed, one existing skip, zero failed; 2,096 assertions |
| Packaged Console affected suites | 198 tests, 935 assertions, zero failures/errors/skips |
| Shared rendering package | 45 passed, 117 assertions |
| Pi model validation and telemetry pricing | 21 passed in independent Rust check |
| Python admin client / sandbox prompt | 26 / 7 passed in implementation checks |
| Google Chat types and signed fixture smoke | Passed after final production edit |
| Helm/chart and deployment draft | Helm lint/render, static network policy, exact approved-space settings and offline production Kustomization passed |
| Affected Ruby/Python/Rust checks | RuboCop, Brakeman, ruff, rustfmt and strict Clippy passed |
| Existing parity ledger consistency | 31 rows and two exclusions verified; ledger test passed. This is metadata validation, not new live feature proof. |
| Whitespace | `git diff --check` passed |

The checked-in [verify-functional-parity.ts](../services/googlechatbot/scripts/verify-functional-parity.ts) generates fixture RSA/JWK material, verifies signed Hono ingress, uses real PostgreSQL and intercepts Google, OAuth and api-rs at the fetch boundary. Its seven scenarios cover active Stop, both startup races, traditional card lifecycle, verified follow-up steering, delegated reactions and Workspace add-on Stop. The Kind test runs real pods and PostgreSQL but uses Google/api-rs fixtures. Neither is a live Workspace execution proof.

Representative commands, with local database configuration supplied through the environment:

```sh
# services/googlechatbot; Bun 1.4.4 matches the bot image.
bun run check:types
bun run test
bun run smoke
bun scripts/verify-functional-parity.ts

# Same packaged proof, run inside the final image.
docker run --rm -e GOOGLECHATBOT_TEST_DATABASE_URL \
  centaur-googlechatbot:parity-20261030-final \
  bun scripts/verify-functional-parity.ts

# Repository root; use the dedicated local context, never an ambient context.
KUBECONFIG=<isolated-kubeconfig> \
  GOOGLE_CHAT_KIND_CONTEXT=<isolated-context> \
  GOOGLE_CHAT_KIND_IMAGE=centaur-googlechatbot:parity-20261030-final \
  bash scripts/verify-google-chat-runtime-kind.sh
helm lint contrib/chart
bash scripts/verify-google-chat-network-policy.sh
git diff --check
```

Typechecking used the installed native host TypeScript checker. Attempting that host dependency tree in Linux lacks its native checker package; no dependency changes were made for that environment mismatch. The host's older Bun 1.2.10 also produced Slack timing failures. Only the complete image-matching Bun 1.4.4 result is counted above.

Raw final local results are `/tmp/centaur-parity-google-ready-all.log`, `/tmp/centaur-parity-proof-ready-image.log`, `/tmp/centaur-parity-kind-ready.log`, `/tmp/centaur-parity-independent-repros-ready.json`, `/tmp/centaur-parity-types-ready.log`, `/tmp/centaur-parity-slack-bun144-full.log`, `/tmp/centaur-parity-console-image-tests.log` and `/tmp/centaur-parity-agent-turn-result.log`. Artifact and source manifests are `/tmp/centaur-parity-artifacts-ready.json` and `/tmp/centaur-parity-implementation-manifest.json`. These temporary files are local evidence; the scripts, hashes and results above retain the reproducible record for review.

## Defects reproduced and corrected

The baseline signed-ingress reproduction held the original SSE open, submitted Stop and observed no interrupt within 1.5 seconds. Separating cancellation/handoff coordination from rendering fixes that defect. Subsequent checks found hung lease renewal retaining authority and cleanup delaying interruption. The independent deadline and cancellation checks now pass.

The actual deployment uses Workspace add-on ingress. New HTTP add-on cards require a full callback endpoint and an action parameter. Traditional Chat apps use a function name. The candidate now selects the correct contract from existing configuration and validates the configured HTTPS endpoint. See the [Google conversion guide](https://developers.google.com/workspace/chat/convert?hl=en).

An add-on Stop click contains a bot-authored message and a human in `chat.user`. The previous identity check used the message sender. It now verifies the correct human actor for interactions while preserving sender verification for message events. The packaged proof signs the documented add-on payload and checks wrong, missing and unsigned actors. See [Google interaction events](https://developers.google.com/workspace/chat/receive-respond-interactions).

Cross-feature reproductions found startup Stop re-enabling participation, delayed mentions predating Stop, an old pending card interrupting a newer execution, stale recovery overwriting successor participation and cached classifier approval surviving opt-out. Dedicated tests cover the corrections. The final ownership guard distinguishes a successor when timestamps are equal or truncated to milliseconds. It preserves the newer execution, eligibility and cutoff.

## Actual Google API and Brave observations

The candidate ChatEdgeClient used the existing configured identity only in the approved shared space and operator DM. Google accepted the corrected full-URL add-on card with its explicit action parameter in both destinations. Buttons were disabled for transport checks. No Stop callback was clicked and no candidate execution ran.

Google rejected an empty cards-only PATCH body with HTTP 400. A nonempty text placeholder plus `updateMask=cardsV2` succeeded and preserved the exact existing text. The candidate helper added and removed the disabled controls in both destinations. Google rejected `createTime >=` with HTTP 400 and accepted `createTime >`; the candidate's one-nanosecond-lookback filter subsequently returned HTTP 200.

The reaction-write OAuth exchange returned HTTP 401 `unauthorized_client`. No reaction or delegation grant was created. Both transport messages were observed in Brave, their final text states their protocol-only scope, and all disabled controls were removed. Private resources and credentials are excluded from this source record.

## Remaining release and live verification gates

[AGENTS.md](../AGENTS.md) requires an explicit request before source publication or remote deployment. A separate uncommitted infrastructure draft is ready for review and passed candidate-chart and offline Kustomization checks. It enables polling only in the approved shared space, preserves ordinary DM handling, and configures Recreate with bounded draining. No live configuration or image/source pins changed.

Read-only inspection found no configured classifier API key in the bot's shared secret. An existing secret-provider reference does not prove usable API access. A connected Mercator search and its one safe health recovery both returned HTTP 401; no paid job or alternate model evaluation was submitted. A sanitized feedback draft was retained locally and was not sent.

To finish the live gate:

1. Authorize publication and deployment of the reviewed source and combined infrastructure release. The release workflow must move its image/source pins together after the required CI checks.
2. Connect working classifier API access through the existing secret mechanism and run both evaluation commands in [evals/README.md](../evals/README.md), retaining scores and provider errors separately.
3. Authorize the precise missing `https://www.googleapis.com/auth/chat.messages.reactions` delegation for the configured actor. App-authenticated message listing already works and needs no new user-delegation grant.
4. Use Brave in the approved shared space and DM to verify mention, unmentioned contextual reply, deliberate silence, active/startup Stop, stale Stop, original-message reaction cleanup and an authorized DM admin operation. Correlate each visible result with durable execution and final-delivery state.

These gates remain open. Passing fixture endpoints or observing the older deployed image cannot establish the new candidate's live functional parity.
