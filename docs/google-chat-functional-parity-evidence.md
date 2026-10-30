# Google Chat functional parity evidence

The packaged candidate was verified locally on 2026-10-30, including the Workspace add-on Stop payload contract. The user subsequently approved publication, deployment and access setup. Live functional parity remains unproven because the candidate is not deployed and final image release plus candidate-driven live checks remain pending. The inferred Claude-effort difference found by provider evaluation is corrected below.

Plan: [feature-google-chat-functional-parity-2.md](../plan/feature-google-chat-functional-parity-2.md). Source baseline: `8f40438219fee79e26e834eacbffdc64dc49ce74`. Upstream comparison: `5e94d92e0fcefae03a799c3a018e6f6cd03d9f1d`. Implementation used Claude Code 2.1.312 with canonical model `claude-fable-5-1`, confirmed in CLI model-usage results. Fable applied the last ownership correction before reaching its weekly usage limit. After the quota limit, the user explicitly approved Codex applying the focused inferred Claude-effort correction directly. The rest of the implementation was written using the requested Fable model.

The tested implementation fingerprint is `1ccae8187d38d6bbf5daa0a5fd2f39d155e5011686528af1046732d4de695c9a`, SHA-256 of the sorted path/content-hash manifest for 67 changed files, excluding this evidence file and the plan. All 67 file hashes were rechecked after verification and matched. Earlier candidate image IDs, counts and fingerprints are superseded by this record. This fingerprint describes the corrected review candidate, using a sorted path-to-file-SHA256 JSON object with comma/colon separators and no spaces. Both this evidence file and the plan are excluded. The source was subsequently published through PR #198 and merged as `a6fe14effd3c497f86aba2f56e3157024623ee12`; a CI-only path filter addition makes shared harness changes run API tests. All six required production image-release checks passed on that main commit. No final image release or deployment has started.

## Approved rollout progress

Publication and rollout were approved on 2026-10-30. [Source PR #198](https://github.com/openfort-xyz/centaur/pull/198) is merged. The existing classifier credential passed a real Decisions request with HTTP 200 and was connected through the deployment's existing shared-secret mechanism. No credential value was printed or committed.

The reaction-write delegation was updated through the user-prepared Chrome Admin page. All 11 existing scopes were preserved; only `https://www.googleapis.com/auth/chat.messages.reactions` was added. The console confirmed 12 scopes. The candidate client then created and deleted a real eyes reaction in each approved destination. These are actual Google API calls, recorded in `/tmp/centaur-parity-google-reaction-approved-result.json`. This replaces the earlier authorization blocker below; candidate-driven automatic reaction cleanup is still a separate live gate.

Provider-backed evaluations now ran with the original datasets and shipped production classifiers. No prompts were tuned on holdout cases.

| Classifier | Google Chat candidate | Unchanged upstream Slack comparison | Observation |
| --- | --- | --- | --- |
| Message overrides | 78 passed, six mismatches, zero provider errors, 84 cases | 83 passed, one mismatch, zero errors | Three Google mismatches are deterministic inferred Claude effort retained by Google and dropped by Slack. The shared prefilter misses the versioned pro alias. Two other Google mismatches involve probabilistic model/provider selection. |
| Contextual reply | 142 passed, four mismatches, one provider timeout, 147 cases | 144 passed, three mismatches, zero errors | All three shared holdout mismatches also fail upstream. The Google run additionally had one side-conversation mismatch and one 10-second timeout. |

Median latency was 535 ms for overrides and 510 ms for contextual classification. Google p95 was 775 ms and 653 ms. One contextual request exceeded the configured production deadline and timed out at the evaluation's 10-second limit; failures remain silent in production. The evaluations do not establish perfect semantic classification.

Raw results are `/tmp/centaur-parity-eval-message-overrides.json`, `/tmp/centaur-parity-eval-proactive-response.json` and the corresponding `eval-upstream-` files. Upstream comparison code and datasets were copied unchanged from the recorded comparison SHA; only dependency installation was shared.

The user approved applying the one-condition inferred Claude-effort correction directly after Claude Code reached its weekly limit. Codex removed Claude from the inferred-effort allowlist while retaining explicit flags. A new regression failed before the correction and passed afterward; 39 affected tests and typechecking pass. Packaged verification and release are now proceeding. The final artifact/test tables below include the direct correction.

The optional chart archive publication job failed because chart-releaser attempted to upload an asset after GitHub made the release immutable. Production consumes the Git-pinned chart and uses its separate six-gate image workflow. No immutable release was altered or safety check bypassed.

## Exact tested artifacts

These are immutable local Docker image IDs, not published registry digests.

| Artifact | Image ID | Evidence |
| --- | --- | --- |
| Google Chat bot, `centaur-googlechatbot:parity-20261030-release` | `sha256:d416b7bda0c78df50345a6d77669b1095ea1eb6013d078856b353e75211ece1e` | All seven packaged PostgreSQL proof scenarios passed; exact-image Kind crash/recovery check passed |
| Console, `centaur-console:parity-20261029` | `sha256:db4ccf6929091a601c96ffe90fddddce02896884928898a4973f85c9e49fc3f7` | Packaged affected Rails suites passed, 198 tests and 935 assertions |
| Sandbox, `centaur-agent:parity-20261029` | `sha256:5e8050a445e9eadceeeddb089c1c1537233f38dc4648be5ef4a263366bc8c33d` | Normal non-root startup, tool discovery, CLI help and packaged Pi turn passed |

All 32 production Google Chat TypeScript files and the packaged proof script matched the final bot image byte-for-byte. The runtime manifest SHA-256 is `a42ab454a5cc686841d9b3c0a5cf32f0e59b7177f228a3dca51a66e9d8e7038c`.

The sandbox test ran packaged Pi 1.4.0 and harness-server with `claude-fable-5-1` against a local Anthropic SSE fixture and obtained the expected normalized sentinel. It was not a live provider call. Codex 0.165.0 and OMP 18.13.2 version checks passed. Console and sandbox files did not change after their packaged checks.

## Requirement audit

| Requirement | Concrete local evidence | Live evidence or remaining gate |
| --- | --- | --- |
| REQ-001, manual Stop | Signed ingress interrupts the fixture execution while its SSE remains open. Delayed session creation starts no execution; delayed execute is interrupted. Status edits retain the control and terminal output removes it. Stale controls cannot interrupt or disable a successor, including equal event timestamps. | Corrected disabled cards were accepted in the approved shared space and DM. Candidate callbacks and executions are not deployed. |
| REQ-002, contextual participation | Mention enables participation; classified follow-up can reply; decline/error stays silent; active execution cannot be steered by an unmentioned message. Stop disables participation. A delayed pre-Stop mention cannot re-enable it; a fresh post-Stop mention can. Cached decisions recheck current opt-in, runtime enablement and exact space policy at recovery/handoff boundaries. | Provider evaluation results are recorded above, including shared holdout mismatches. Live unmentioned-message behavior remains unverified. |
| REQ-003, ordinary message collection | Bounded app-authenticated polling, exact spaces, pagination, nanosecond cursor, durable dedupe, bot suppression and verified requester tests pass. Failed acceptance does not advance the cursor. | Google accepted the candidate's strict greater-than nanosecond filter with HTTP 200. Candidate poller is not deployed. |
| REQ-004, original-message reactions | Fixture OAuth/Google endpoints verify delegated actor, exact write scope, original trigger, create/delete and terminal cleanup. Rejected/missing delegation does not fail execution. Packaged proof created and deleted five fixture reactions. | After the approved scope addition, actual reaction create/delete passed in both approved destinations. Automatic cleanup during a candidate execution remains pending. Reactions are authored by the configured Workspace user. |
| REQ-005, classifiers/models | Explicit flags, aliases, Decisions API contract, timeouts, unknown answers and failure behavior pass. Evaluation adapters call shipped Google classifiers using upstream Slack datasets. Fable 5.1, Sonnet 5.5, Haiku 5.5 and GPT-6.1 Terra mappings are covered. | Both provider-backed evaluations ran; results above expose the inferred Claude-effort parity correction. Unit fixtures do not establish model quality. |
| REQ-006, drain/restart | Real PostgreSQL ownership checks, pending discovery beyond 2,000 later entries, monotonic Stop state, independent lease deadlines and bounded release pass. Exact-image Kind test killed the active owner during SSE with two replicas, recovered without re-execute, delivered one final, cleared obligations and restored two ready replicas. | Production rollout/restart was not performed. First rollout requires Recreate because old and new lease schemes do not coordinate. |
| REQ-007, DM administration | Packaged Rails tests cover linked active admin success, verified current requester/email match, exact DM identity, shared-space/non-admin/disabled/mismatch/token/namespace denial and existing Slack policy. Thin Google permission commands reuse the existing API. | A read-only database transaction confirmed the approved DM already links the matching active admin and verified email. A new live DM-to-sandbox admin operation is pending. |
| REQ-008, retained behavior | Shared rendering tests and full Slack regressions pass. Pi validation/pricing, sandbox startup, model restrictions and existing parity ledger checks pass. Pi's GPT-6.1 Terra restriction follows upstream; supported harness alternatives remain available. | These support retention, not a claim that every older production behavior was retested live. |
| SEC-001, verified event/action identity | Forged and unsigned ingress is rejected. Add-on cards bind to the verified human clicker in `chat.user`, not the bot author in `message.sender`. Wrong/missing human and malformed actions are rejected. Cancellation is bound to originating work/execution. | The real add-on callback has not been exercised against the candidate. |
| SEC-002 and CON-001/002, authorized boundary | Local Kubernetes checks use a dedicated explicit context. Actual Google tests stayed in the approved AI space and operator DM. Evidence excludes private identifiers and credentials. | Source publication and the precise credential/delegation setup are approved and completed. Remote deployment and candidate-driven live verification remain pending. |

## Final checks

| Check | Result |
| --- | --- |
| Complete Google Chat suite with image-matching Bun 1.4.4 and PostgreSQL | 577 passed, zero failed, 2,010 assertions across 28 files |
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
  centaur-googlechatbot:parity-20261030-release \
  bun scripts/verify-functional-parity.ts

# Repository root; use the dedicated local context, never an ambient context.
KUBECONFIG=<isolated-kubeconfig> \
  GOOGLE_CHAT_KIND_CONTEXT=<isolated-context> \
  GOOGLE_CHAT_KIND_IMAGE=centaur-googlechatbot:parity-20261030-release \
  bash scripts/verify-google-chat-runtime-kind.sh
helm lint contrib/chart
bash scripts/verify-google-chat-network-policy.sh
git diff --check
```

Typechecking used the installed native host TypeScript checker. Attempting that host dependency tree in Linux lacks its native checker package; no dependency changes were made for that environment mismatch. The host's older Bun 1.2.10 also produced Slack timing failures. Only the complete image-matching Bun 1.4.4 result is counted above.

Raw final local results are `/tmp/centaur-parity-google-release-all.log`, `/tmp/centaur-parity-proof-release-image.log`, `/tmp/centaur-parity-kind-release.log`, `/tmp/centaur-parity-independent-repros-ready.json`, `/tmp/centaur-parity-types-release.log`, `/tmp/centaur-parity-slack-bun144-full.log`, `/tmp/centaur-parity-console-image-tests.log` and `/tmp/centaur-parity-agent-turn-result.log`. Artifact and source manifests are `/tmp/centaur-parity-artifacts-release.json` and `/tmp/centaur-parity-implementation-release.json`. These temporary files are local evidence; the scripts, hashes and results above retain the reproducible record for review.

## Defects reproduced and corrected

The baseline signed-ingress reproduction held the original SSE open, submitted Stop and observed no interrupt within 1.5 seconds. Separating cancellation/handoff coordination from rendering fixes that defect. Subsequent checks found hung lease renewal retaining authority and cleanup delaying interruption. The independent deadline and cancellation checks now pass.

The actual deployment uses Workspace add-on ingress. New HTTP add-on cards require a full callback endpoint and an action parameter. Traditional Chat apps use a function name. The candidate now selects the correct contract from existing configuration and validates the configured HTTPS endpoint. See the [Google conversion guide](https://developers.google.com/workspace/chat/convert?hl=en).

An add-on Stop click contains a bot-authored message and a human in `chat.user`. The previous identity check used the message sender. It now verifies the correct human actor for interactions while preserving sender verification for message events. The packaged proof signs the documented add-on payload and checks wrong, missing and unsigned actors. See [Google interaction events](https://developers.google.com/workspace/chat/receive-respond-interactions).

Cross-feature reproductions found startup Stop re-enabling participation, delayed mentions predating Stop, an old pending card interrupting a newer execution, stale recovery overwriting successor participation and cached classifier approval surviving opt-out. Dedicated tests cover the corrections. The final ownership guard distinguishes a successor when timestamps are equal or truncated to milliseconds. It preserves the newer execution, eligibility and cutoff.

## Actual Google API and Brave observations

The candidate ChatEdgeClient used the existing configured identity only in the approved shared space and operator DM. Google accepted the corrected full-URL add-on card with its explicit action parameter in both destinations. Buttons were disabled for transport checks. No Stop callback was clicked and no candidate execution ran.

Google rejected an empty cards-only PATCH body with HTTP 400. A nonempty text placeholder plus `updateMask=cardsV2` succeeded and preserved the exact existing text. The candidate helper added and removed the disabled controls in both destinations. Google rejected `createTime >=` with HTTP 400 and accepted `createTime >`; the candidate's one-nanosecond-lookback filter subsequently returned HTTP 200.

The initial reaction-write OAuth exchange returned HTTP 401 `unauthorized_client`. The approved scope addition and actual create/delete checks above have since resolved this gate. Both transport messages were observed in Brave, their final text states their protocol-only scope, and all disabled controls were removed. Private resources and credentials are excluded from this source record.

## Initial live gates and current remaining work

[AGENTS.md](../AGENTS.md) requires an explicit request before source publication or remote deployment. A separate uncommitted infrastructure draft is ready for review and passed candidate-chart and offline Kustomization checks. It enables polling only in the approved shared space, preserves ordinary DM handling, and configures Recreate with bounded draining. The approved classifier secret and reaction delegation changed as recorded above. No production image/source pins changed.

Initial read-only inspection found no configured classifier API key in the bot's shared secret; the approved connection above has now resolved this. An existing secret-provider reference does not prove usable API access. A connected Mercator search and its one safe health recovery both returned HTTP 401; no paid job or alternate model evaluation was submitted. A sanitized feedback draft was retained locally and was not sent.

To finish the live gate:

1. Authorize publication and deployment of the reviewed source and combined infrastructure release. The release workflow must move its image/source pins together after the required CI checks.
2. Connect working classifier API access through the existing secret mechanism and run both evaluation commands in [evals/README.md](../evals/README.md), retaining scores and provider errors separately.
3. Authorize the precise missing `https://www.googleapis.com/auth/chat.messages.reactions` delegation for the configured actor. App-authenticated message listing already works and needs no new user-delegation grant.
4. Use Brave in the approved shared space and DM to verify mention, unmentioned contextual reply, deliberate silence, active/startup Stop, stale Stop, original-message reaction cleanup and an authorized DM admin operation. Correlate each visible result with durable execution and final-delivery state.

Publication, credential connection, provider evaluation execution and reaction-write authorization above are now complete. The inferred Claude-effort correction, final image release/deployment and candidate-driven live execution checks remain open. Passing fixture endpoints or observing the older deployed image cannot establish the new candidate's live functional parity.

## Follow-up verification, approved direct correction

The inferred Claude-effort condition now matches upstream. A regression failed
before the edit and passed after it. All 39 affected tests passed with 148
assertions, and typechecking passed. Explicit Claude flags retain their effort.
The live model-selection evaluation now passes 81/84 cases with zero provider
errors; all three Claude-effort cases pass. Remaining differences are the shared
versioned-pro prefilter case and two model/provider decision mismatches. No
dataset expectations or holdout prompts were weakened. Contextual evaluation
remains 142/147 with four mismatches and one provider timeout.

The source CI path filter now runs the full suite on main pushes. The image
release requires successful API, sandbox and other named checks at the exact
release SHA; allowing path-filter skips would leave a Google-only follow-up
unreleasable. Pull request filtering remains in place. No release gate was
removed or bypassed.

Final direct-correction artifact verification passed: all 577 Google Chat tests
with 2,010 assertions, seven packaged real-PostgreSQL proof scenarios, and the
exact-image Kind owner-crash/recovery test. All 32 runtime source files and the
proof script match the final image byte-for-byte. The independent earlier
cross-feature reproductions cover code unchanged by this correction.
