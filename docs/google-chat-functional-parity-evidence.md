# Google Chat functional parity evidence

The Google Chat parity implementation is deployed. Chrome live checks on
2026-10-30 prove original-message reactions, contextual replies without mentions,
manual cancellation through both the Stop button and text, silence after Stop,
fresh mention re-entry, a read-only operator-DM admin command, and restart
recovery. A cancellation wording defect found live was corrected, deployed and rechecked
in Chrome with the expected neutral result.

Plan: [feature-google-chat-functional-parity-2.md](../plan/feature-google-chat-functional-parity-2.md).
Source baseline: `8f40438219fee79e26e834eacbffdc64dc49ce74`.
Upstream comparison: `5e94d92e0fcefae03a799c3a018e6f6cd03d9f1d`.
Final implementation source: `e684dfa156241051e2b392eddd59c7ae1a10bb81`.
Its 69-file implementation manifest, excluding this record and the plan, hashes
to `b7491dadb329f8d496d35d6c182ee0b350d88058fa4dc0bb7bb13aafeb0fd146`.
The manifest is a sorted path-to-file-SHA256 JSON object with comma/colon
separators and no spaces.

The original implementation used Claude Code 2.1.312 with canonical model
`claude-fable-5-1`, confirmed in CLI usage results. After that account exhausted
its weekly quota, the user approved direct Codex follow-up corrections. These
corrected inferred Claude effort and the observed native cancellation wording.

## Publication and deployment

[Source PR #198](https://github.com/openfort-xyz/centaur/pull/198) contains the
parity implementation. [PR #199](https://github.com/openfort-xyz/centaur/pull/199)
corrects inferred Claude effort and makes main-push CI run the full service
suite required by production image gates. It merged as
`a4c906bb362c1b010a40cef6ffbbb46bb977e505`.

All six production images were built, scanned and published by the normal
image-release workflow. The infrastructure release merged and its Helm upgrade
succeeded at 10:52:56 UTC. The production bot used
Recreate and the expected source-pinned image. The published bot's amd64
manifest is `sha256:67d6640b4c62bd7fbd2ce573e2e917e7fa4f10a3c0fbae237828dd9485d2e926`.
Its production source files matched the source byte-for-byte, and all seven
packaged PostgreSQL proof scenarios passed in that registry image.

The existing classifier credential passed a real Decisions API request with
HTTP 200 and was connected through the deployment's existing secret mechanism.
The precise `https://www.googleapis.com/auth/chat.messages.reactions` delegation
was added through Chrome, preserving all 11 existing scopes. Actual reaction
create/delete passed in both approved destinations. Credential values and
private deployment identities are excluded from this record.

[PR #200](https://github.com/openfort-xyz/centaur/pull/200) corrects the native
interrupted-turn renderer. Its exact merged source is the final implementation
SHA above. All six source checks and scanned image jobs passed on this SHA. Its coordinated
infrastructure release merged and Helm completed at 11:45:52 UTC. All seven
core workloads are ready at that source. The running bot index digest is
`sha256:cff850c9764d703916889909a8991b82d3471b62a185877fc9a4aa404eea0e54`;
its amd64 manifest is
`sha256:c00bfae6537bc3ad09925c3b27a182f5a5bce22b550c0d1e851a2b19772e25da`.
All 35 checked production source/proof/shared-mapper files match byte-for-byte,
and all seven packaged PostgreSQL proofs pass inside the published image.

## Live functional proof

Tests used Chrome in the approved shared space and operator DM. Controlled
turns explicitly selected Codex because the default Claude account was at its
weekly usage limit. The deployment default and provider credentials were
preserved.

| Behavior | Actual observed result |
| --- | --- |
| Original-message acknowledgement | Eyes appeared on the human trigger, including a contextual unmentioned message. The configured delegated user authored the reaction. |
| Workspace add-on Stop button | A real authenticated click cancelled the active execution in 1.129 seconds. The reaction and control were removed, pending work cleared and contextual participation disabled. |
| Text Stop | A real `stop` reply cancelled the active execution in 1.030 seconds and cleared pending work. |
| Silence after Stop | An unmentioned positive request produced no reaction, acknowledgement or execution over more than two polling intervals. |
| Fresh mention re-entry | A real app mention re-enabled participation and returned its exact sentinel. |
| Unmentioned contextual reply | A subsequent meaningful follow-up produced one execution and one exact final sentinel without a mention. This passed again on the final corrected release. |
| Deliberate silence | A closure message remained silent with no later execution or response. |
| Operator-DM administration | The read-only admin-principals command ran from the verified DM sandbox. Its durable command event records exit code zero and the expected final sentinel. Identity records were excluded from retained evidence. |
| Bot restart recovery | The bot was restarted while the controlled DM turn was the only active Google execution. A replacement pod resumed the same execution and updated the same acknowledgement with one final sentinel. No second execution was created. The reaction, Stop control and pending work were cleared. |

The restart test retained before/during/after database and Google API snapshots.
The replacement pod was created between the execution's start and completion.
The old ownership lease delayed final delivery until a recovery sweep acquired
it. The production lease is 120 seconds and sweeps run every 60 seconds.
This proves bounded recovery in the observed run, not instantaneous recovery.

The initial post-deployment health script passed eight checks. Its agent check
reported a timeout, but the durable execution finished after 2.65 seconds and
its terminal result contains the Claude weekly-limit error. This was a provider
quota failure, not a hung runtime. The limit resets on 2026-10-31 at 18:00 UTC.
No billing, credential, model-default or safety-gate change bypassed that limit.

## Native cancellation correction

The first Stop test exposed misleading final text, `Execution completed, but no
final text was captured.` Codex emits native `turn/completed` with
`status: interrupted` and no items before canonical `session.execution_cancelled`
with only a reason. The shared mapper finalized an empty success before seeing
the latter event.

The mapper now supplies its existing neutral `Execution interrupted` result
for that native terminal status when no final answer exists. Partial answers
remain intact. A regression reproduces the actual sequence, fails on the
deployed mapper and passes after the one-line correction. Both live delivery
and recovery persist this canonical answer before final delivery. The final
production Chrome check passed: the same acknowledgement reads exactly
`Execution interrupted`, its Stop control and original-message reaction are
removed, pending work is zero, and cancellation completed in 1.238 seconds.

## Verification scope

| Check | Result |
| --- | --- |
| Complete Google Chat suite, Bun 1.4.4 and real PostgreSQL | 578 passed, zero failed, 2,018 assertions across 28 files |
| Packaged signed-ingress proof with real PostgreSQL | Seven scenarios passed, empty failures array |
| Final local bot image | `sha256:b769c999f8e70311ad0082a6e2e929a5ba94889b5c07566df51fbfc74eafa286`; 35 production source/proof/shared-mapper files match byte-for-byte |
| Exact final image in isolated Kind | Active owner crash, two replicas, one execution, recovered stream, one final, zero pending obligations and pod replacement passed |
| Shared rendering | 45 passed, 117 assertions |
| Complete Slack suite, Bun 1.4.4 | 312 passed, one existing skip, zero failed, 2,096 assertions |
| Google Chat typechecking | Passed |
| Packaged Console affected suites | 198 tests, 935 assertions, zero failures/errors/skips |
| Pi model validation and telemetry pricing | 21 independent Rust checks passed |
| Python admin client / sandbox prompt | 26 / 7 passed |
| Other affected checks | RuboCop, Brakeman, ruff, rustfmt and strict Clippy passed |
| Deployment validation | Helm lint/render, network-policy checks, offline production Kustomization and full infrastructure pre-commit passed |
| Earlier independent cross-feature reproductions | Seven passed for startup Stop ordering, stale controls/recovery, verified add-on human, cached policy and equal-time ownership |
| Independent lease deadline checks | Hung/late/refused renewals revoke ownership, slow acquire refuses work, healthy renewal retains ownership, hung release is bounded |

The packaged proofs use mocked Google and control-plane endpoints with real
PostgreSQL. Kind uses the actual bot image and fixture endpoints. The live
Chrome/API/database observations above are separate, real-platform proof.
Sandbox Pi 1.4.0 and harness-server produced the expected normalized Fable 5.1
sentinel against a local Anthropic SSE fixture, not a live provider. Codex
0.165.0 and OMP 18.13.2 version checks, normal non-root startup and CLI discovery
passed. Console and sandbox implementation files did not change afterward.

Trust-boundary tests reject unsigned/forged ingress, wrong or missing clicker,
stale Stop controls and cross-requester steering. DM administration tests cover
verified current-requester identity, active linked admin success and shared-space,
non-admin, disabled, mismatch, token and namespace denials. Startup Stop, cached
policy rechecks, monotonic timestamps, obligation discovery past 2,000 later
entries, independent ownership deadlines and recovery idempotency are covered
by regressions and packaged proofs. Live tests did not impersonate another user
or manufacture Google callbacks.

Google rejected empty cards-only PATCH bodies; a nonempty placeholder with a
cards-only update mask preserved the existing text. Its list endpoint rejected
`createTime >=` and accepted the shipped strict `>` nanosecond-lookback filter.
These actual API findings are covered by client regressions.

## Provider-backed classification

Both production classifiers and the unchanged upstream code used real
`gpt-6-luna` calls with the original upstream datasets. No holdout prompts or
expected outputs were weakened.

| Classifier | Google Chat | Upstream Slack comparison |
| --- | --- | --- |
| Message overrides, after inferred-effort correction | 81/84, three mismatches, zero provider errors | 83/84, one mismatch, zero errors |
| Contextual participation | 142/147, four mismatches, one provider timeout | 144/147, three mismatches, zero errors |

The three inferred Claude-effort cases now pass. Remaining override differences
are a versioned pro-alias prefilter case also missed upstream and two model or
provider selections. All three upstream contextual holdout mismatches also
failed Google; Google additionally misclassified a side conversation and had
one timeout. Initial median latencies were 535 ms for overrides and 510 ms for
contextual replies, with p95 of 775 and 653 ms. Production deadlines are 1.5 and
2 seconds; errors/timeouts stay silent. These results establish tested behavior
and expose quality limits. They do not establish perfect semantic decisions.

## Evidence and limits

The requested functional checks are complete, including the deployed correction.
Retained evidence contains complete logs, source and image hashes, provider
results, controlled live snapshots and assertion results. Credentials and
unrelated business data are excluded. The default Claude quota and measured
classifier mismatches remain operational limits; the broader older 31-gate
certification matrix was not rerun in full. Startup and stale/forged callback
cases were tested through signed fixtures, PostgreSQL and the packaged image;
the live callback proof used a genuine authorized click.
