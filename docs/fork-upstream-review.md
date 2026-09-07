# Fork review and cleanup

Reviewed on 2026-09-07 in branch `refactor/fork-unslop-2026-09-07`.

The cleanup corrects documentation and comments, repairs the evidence ledger,
and checks it in CI. Two existing recovery defects remain. They need runtime
fixes and fault tests before the fork can claim reliable delivery at every
crash boundary.

## Open findings

1. **P1: unfinished work can disappear from recovery.**
   [state.ts](../services/googlechatbot/src/state.ts#L148), `persistWork`, writes
   the obligation separately from a rolling index capped at 2,000 entries.
   Every save appends another index entry, including updates to the same work.
   `recoverWorkObligations` scans only that index. Enough later saves evict an
   unfinished obligation even though its record remains in Postgres. Completed
   work also keeps its index entries. A synthetic adapter reproduced an empty
   recovery scan with unfinished work still stored after 2,000 later saves.
   A crash between the record write and index append provides another route to
   an undiscoverable obligation. Use an authoritative pending-work query or
   atomically maintained pending index; do not fix this by raising the cap.

2. **P1: an expired lease owner can overwrite or delete its successor.**
   [state.ts](../services/googlechatbot/src/state.ts#L267), `acquireLease`, uses
   separate `get` and `set` calls for renewal and separate `get` and `delete`
   calls for release. If the lease expires and another worker acquires it
   between those calls, the old owner can mutate the new lease. A synthetic
   expiry between the release read and delete reproduced deletion of the
   successor's token. Renewal also suppresses errors without stopping the
   worker. Use atomic ownership-checked renewal/release and define how a worker
   stops after losing its lease. Verify paused-owner, successor, and delayed
   renewal cases with two real state adapters.

These reproductions exercise the current functions with controlled adapter
interleavings. They are not observations of a production incident. Runtime
behavior was left unchanged during this editorial and validation cleanup.

## Baseline and coverage

- Starting fork HEAD: `217f72f038644ee9c8b2d92b5b491980bbac55db`.
- Upstream: `d3143c354ea4df79f40961d8b0fe1b910caee286`.
- Upstream is an ancestor of that HEAD. The fork has 302 additional commits,
  including merges. The starting branch includes 27 commits beyond `origin/main`.
- Tree difference: 231 files, 35,954 inserted lines, 296 deleted lines.

The cleanup was subsequently rebased onto the sync branch at
`4d4e87ac53a87fd5fcf6eef852faf6f22ff113fd` for publication. Its two additional
commits port persona selection, model aliases, reasoning options, and Console
link gating. Their changes are preserved. The inventory above describes the
original review baseline.

| Area | Files | Added lines | Removed lines |
| --- | ---: | ---: | ---: |
| Google Chat bot | 57 | 18,412 | 0 |
| Rust API and SQLx | 44 | 4,205 | 41 |
| Console | 54 | 2,424 | 81 |
| Workflows and Python host | 13 | 3,683 | 10 |
| Tools | 17 | 2,431 | 12 |
| Harness | 4 | 389 | 41 |
| Documentation and plans | 9 | 1,854 | 0 |
| Build, chart, sandbox, CI, and other | 33 | 2,556 | 111 |

The review inventoried the full delta, traced the main Google Chat request,
authorization, recovery, and deployment paths, and inspected the smaller fork
changes. The checks below cover selected contracts, not every execution path
in every changed file.

The main service boundaries are useful and should stay. Google transport and
rendering belong in the bot; resource authorization and workflow forwarding
belong in api-rs; Console owns grants; the harness owns attachment staging;
ETL owns ingestion and projection. Large modules include substantial tests.
Splitting them by line count alone would not address the recovery defects.

The fork also carries independent changes for attachment integrity, isolated
local-sandbox environments, overlay tool precedence, moved repository tags,
Attio parent-object resolution, Notion pagination, investigation tooling,
security image rebuilds, and CI runners. The cleanup preserves those behaviors.

Eighteen upstream SQLx migrations have different filenames with identical
contents in this fork. They were not renumbered again. The migration-order
check passes against `origin/main`; that does not establish compatibility with
a database that already applied upstream's numbering.

## Cleanup applied

- Reconciled the service README, parity status, and operator reference with DM
  transcript replay, text versus image-card rendering, delegated ownership,
  execution timeouts, and restart replay from the beginning of an execution.
- Corrected email-source comments to name the verified Add-on user token and
  DM confirmation. Removed suggestions to disable signatures during rollback.
- Removed the claim that DM setup/send is atomic. It uses separate Google calls.
- Replaced unauthenticated ETL examples and local shell expansion of database
  credentials with authorized API calls using a header file and plain SQL.
- Labelled old comparisons, conformance results, and canary plans as historical.
  Preserved their dates and evidence; no result was promoted to release proof.
- Restored the missing procedure cells in eight verification-table rows. The
  checker now requires nine populated columns, accepts Markdown-wrapped SHAs,
  and retains its same-immutable-release rule.
- Added a runnable checker regression test and CI wiring. Google Chat CI now
  also reacts to its shared rendering/event packages and card-text fixture.
- Made two database tests report explicit skips when their URL is absent.
- Shortened repeated incident narratives and comments, while retaining trust,
  idempotency, and recovery constraints. Added Google Chat links to the root,
  architecture, configuration, and Console documentation.

## Validation

| Check | Result |
| --- | --- |
| Google Chat typecheck | Passed |
| Google Chat service tests | 466 passed, zero failures, including the local Postgres adapter test |
| Signed fixture smoke | Passed; mock Google/session endpoints |
| Google Chat CLI/client | 42 passed |
| Sandbox Python suite | 41 passed with Python 3.14 |
| Google Chat ETL, attachment projection, scheduled delivery | 56 passed, 2 explicit database skips |
| Python workflow host | 35 passed |
| Rust principal registration | 107 passed |
| Rust Google Chat proxy | 13 passed |
| Rust Google Chat workflow broker | 5 passed |
| Rust workspace formatting | Passed |
| Ledger checker and synthetic regression cases | Passed |
| Helm lint and static Google Chat policy verifier | Passed after fetching chart dependencies |
| SQLx/Rails migration order against `origin/main` | Passed |
| CI YAML and changed-path filter checks | Passed |
| Docs site build | Passed; 65 generated files |
| Whitespace and executable-equivalence checks | Passed |

TypeScript comment edits compile to identical JavaScript. Edited Python runtime
files have identical ASTs after removing docstrings, and the edited tool
manifest parses identically. Executable changes are confined to verification
and CI behavior.

After rebasing, the Google Chat typecheck, service tests, signed fixture smoke,
ledger checks, and TypeScript executable-equivalence check were repeated.
Other results above were obtained before the rebase.

The Console suite was not run: the configured Ruby 3.4.10 is not installed.
Database-dependent ETL tests need `SESSION_SQLX_TEST_DATABASE_URL`; their skips
are not RLS or retention evidence. No runtime image builds, live Workspace
operations, browser checks, or Kubernetes deployment tests were run. Bot tests
used local Bun 1.2.10, while the image pins 1.3.13. The docs build passed on
Node 26 despite its dependency's engine warning and the existing brand-asset
link warning. Official Google API contracts were not re-audited against the
current external documentation.

## Reproduce the recovery findings

Run from the repository root after `pnpm install --frozen-lockfile`. These
assertions demonstrate existing defects; they do not form a passing regression
suite for the intended behavior. The adapters model expiry and bounded-list
semantics without using a database or network.

```bash
bun - <<'TS'
import { strict as assert } from 'node:assert'
import { acquireLease, persistWork, workKey } from './services/googlechatbot/src/state.ts'

let owner: string | undefined
const lease = {
  setIfNotExists: async (_key, token) => { owner = token; return true },
  get: async () => { const old = owner; owner = 'successor'; return old },
  delete: async () => { owner = undefined }
}
const release = await acquireLease(lease as any, 'lease', 120_000, 60_000)
assert(release)
await release()
assert.equal(owner, undefined, 'old owner deleted its successor')

const records = new Map()
const index: string[] = []
const state = {
  set: async (key, value) => { records.set(key, value) },
  appendToList: async (_key, value, { maxLength }) => {
    index.push(value)
    index.splice(0, Math.max(0, index.length - maxLength))
  }
}
await persistWork(state as any, { workId: 'unfinished' } as any)
for (let n = 0; n < 2_000; n++) {
  const workId = `completed-${n}`
  await persistWork(state as any, { workId } as any)
  records.delete(workKey(workId))
}
assert(records.has(workKey('unfinished')))
assert(!index.includes('unfinished'), 'recovery lost the unfinished record')
assert.equal(index.filter(id => records.has(workKey(id))).length, 0)
console.log('Both existing recovery defects reproduced')
TS
```
