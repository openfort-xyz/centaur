---
name: verify-googlechat-thread-state
description: "Model-check Google Chat thread turn, steering, and stop ordering in services/googlechatbot with TLA+/TLC. Use when a change touches handoffTurn, renderTurn, finishThreadRun, holdSteeringAck, foldIntoActiveRun, requestStop, handleStopCard, handleStopCommand, updateThreadState, withThreadHandoff, steeringAckMessageNames or activeExecution in GoogleChatThreadState, or api-rs steering/interrupt; or when asked whether stop, steering acks, or thread state can race."
---

# Verify Google Chat thread state

A TLA+ model of one Google Chat thread in `services/googlechatbot`: mentions that start
a turn or steer the running one, a mentioned `stop`, and a Stop-card press, all racing
each other and the api-rs execution. TLC checks every interleaving of those steps within
the bounds below. A pass covers the model and its bounds, not the whole bot.

Sync commit: `7eb5c1bc51fd206f6f29ceebb18830ded5e8bf87`

## What it checks

Each rule is an INVARIANT in `GoogleChatThreadTurn.tla`, checked in its own TLC run.

| Invariant | Rule, in plain words | Harm when broken |
| --- | --- | --- |
| `StopButtonStopsRunningTurn` | Pressing Stop on the bubble of a turn that is still running is never refused as stale. | The user presses Stop, gets no reply, and the agent keeps running. |
| `StopButtonOnlyStopsItsTurn` | A Stop press only interrupts the turn its own bubble belongs to. | Someone's Stop cancels a different turn. |
| `StopNeverKillsNewerTurn` | A stop never interrupts a turn started by a mention sent after the stop (`requestStop`: "an older stop never kills a newer turn"). | A newer request is cancelled by an older stop. |
| `SteeringNoticeMeansForwarded` | A bubble showing "added to the running turn" (`STEERING_STATUS`) means api-rs forwarded that message into a run. | The user is told the message joined the run; no run ever sees it and nothing answers it. |
| `NoSteeringNoticeOnceQuiet` | Once nothing is running or in flight, no "added to the running turn" bubble is left (SLACK_PARITY #1519: "the live run deletes the held notices when it finalizes"). | A stale steering notice stays in the thread. |
| `ThreadMarkedIdleOnceQuiet` | Once nothing is running, `GoogleChatThreadState.activeExecution` is not `true`. | Stop presses on not-yet-started turns are refused (`boundTo`), and proactive replies stay off (`proactiveStillCurrent`), until a later turn finishes. |
| `EveryAckResolvedOnceQuiet` | Once quiet, no eager ack still says "thinking". | A stranded "thinking" bubble. |

## Run

From the repository root:

```bash
.agents/skills/verify-googlechat-thread-state/scripts/check.sh
```

Needs Java 11+ on `PATH` (or `JAVA=/path/to/java`). The first run downloads
`tla2tools.jar` v1.7.4 into `~/.cache/centaur-tla/` and checks its SHA-256; nothing is
written to the repo. Default bounds (`MC.cfg`, two mentions) take about 15 seconds.
Outputs (one `<Invariant>.out` per rule, with the TLC trace) go to a fresh temp dir,
printed at the end; set `OUT_DIR=...` to choose it.

Exit codes: `0` the failing set equals the known findings below; `1` the set changed
(a new violation, or a known finding no longer reproduces); `2` a tool, parse, or
deadlock error, which is a modeling error until shown otherwise. The script also prints
a note when the covered files differ from the sync commit.

For a deeper run before shipping a change here, set `Msgs = {"m1", "m2", "m3"}` in
`MC.cfg` (about 42 million states, ~2.5 minutes per passing rule), then restore it.

## Read the results

Read every result with the pstack `/statechart` skill: give it
`GoogleChatThreadTurn.tla` with a config that lists the invariants, in a scratch folder
outside the repo, and point it at the same pinned jar. It tells each violation as its
shortest path in plain steps, and draws a chart when the rules pass. Write its view in
the words of someone in the Chat thread (bubble text, "agent running", "state says
idle"), not variable names.

Real bug or modeling error? Replay the path against the code, one step per action,
using the coverage table. If any step cannot happen in the code in that order (it
holds a lock it does not hold, reads a value the code does not read), the model is
wrong: fix the action, not the rule. Never weaken an invariant to make it pass.

## Known findings at the sync commit

`check.sh` expects exactly these to fail (`KNOWN_FAILING`). Each was read with
`/statechart` and replayed against the code.

1. **A steer that lands after the run ended is acknowledged but never delivered**
   (`SteeringNoticeMeansForwarded`). m2 sees an active run in `createSession` (or a 409
   from `executeSession`, then `foldIntoActiveRun`); the m1 run ends; m2's
   `appendSessionMessages` reaches api-rs `forward_messages_to_active_execution`, which
   finds no active execution and returns without forwarding. `holdSteeringAck` still shows
   "added to the running turn", and no run answers m2.

   The fix belongs in api-rs (report that nothing was forwarded), outside the Google Chat
   bot.

Every other rule passes, and no run deadlocks. Two earlier findings are fixed:
`finishThreadRun` now runs under `withThreadHandoff` and leaves a thread whose
`activeExecutionId` names a newer execution. Before that, an older turn's finish could
mark a newer running turn idle (so a stop killed it, or its own Stop card was refused as
stale), and a steering notice recorded between the finish's read and its clear was never
deleted and left the thread marked running.

## Coverage

`src/` is `services/googlechatbot/src/`. Each action is one await in the code unless the
spec comment says steps were merged and why.

| Model action | Code |
| --- | --- |
| `Arrive` | `processWorkObligation`: eager ack `createMessage(INITIAL_STATUS, stopControlCards)`, `persistStopControl` |
| `HandoffAcquire` | `driveSession` → `withThreadHandoff` (`src/state.ts`) |
| `CreateSession` | `handoffTurn` → `createSession` (`src/session-api.ts`) `activeExecution` |
| `StopCheck` | `handoffTurn`: `latest`, `workStopRequestedAt`, `stopRequestedFor`, `superseded`, `deliverStoppedBeforeStart`; else branch on `session.activeExecution` |
| `Execute` | `handoffTurn` → `executeSession`; 409 → `classifyExecuteConflict` → `foldIntoActiveRun` |
| `RecordStart` | `handoffTurn`: `appendSessionMessagesBestEffort` (no forward), `updateThreadState({activeExecution, activeExecutionId, lastExecutedAt})`, `work.executionId` |
| `FoldAppend` | `appendSessionMessages` → api-rs `append_messages_with_forwarding` → `forward_messages_to_active_execution` (`crates/centaur-session-runtime/src/lib.rs`) |
| `FoldHold` | `holdSteeringAck` (`STEERING_STATUS`) |
| `FoldRecord` | `updateThreadState({activeExecution: true, steeringAckMessageNames})` in `handoffTurn` fold branch, or `{steeringAckMessageNames}` after `foldIntoActiveRun`; `noRun` → `clearStopControl` |
| `WorkFinished` | `processWorkObligation` → `finishWork` |
| `FinalRender` | `renderTurn`: terminal stream, `clearStopControl`, `finalizeRender`, `stage = 'final'` |
| `FinishAcquire` / `FinishClear` / `FinishDelete` | `finishThreadRun`: `withThreadHandoff`; read the thread state, skip when `activeExecutionId` names another execution, else `updateThreadState({activeExecution: false, activeExecutionId: null, steeringAckMessageNames: []})`; release; `removeAck` each read name |
| `RunCompletes` | api-rs execution ends |
| `StopSent` … `StopInterrupt` | `classifyWork` 'stop-text' → `handleStopCommand` → `requestStop` (`persistIntent`, lock, `newerTurnActive`) → `interruptSessionExecution` → api-rs `interrupt_active_execution` |
| `CardClick` … `CardInterrupt` | `handleStopCard`: `stopControlKey` binding, `requestWorkStop`, `requestStop` with `boundTo`, `clearStopControl`, interrupt |
| `ts` record | `GoogleChatThreadState`: `activeExecution`, `activeExecutionId`, `steeringAckMessageNames`, `stopRequestedAt`, `lastExecutedAt`; merge rules of `updateThreadState` |

`check.sh` watches `src/index.ts`, `src/state.ts`, `src/fold-guard.ts`,
`src/session-api.ts`, and `crates/centaur-session-runtime/src/lib.rs` against the sync
commit.

## Bounds and assumptions

- Two mentions, one text stop, one Stop-card press, in one thread (`MC.cfg`).
- A DM thread: `canFoldIntoActiveRun` is always true, so other-requester refusal
  (`refuseFoldForOtherRequester`) and proactive turns are not modeled.
- One bot process; Google Chat and api-rs calls always succeed; no lease loss, crash,
  or `recoverWorkObligations`/`recoverFinalRender` replay; the render stream always
  reaches the terminal event (no `MAX_RESUME_ATTEMPTS` give-up, which would finish the
  thread while api-rs still runs).
- api-rs runs one execution per thread and its run can end at any moment.
- Not covered: Google message ordering beyond `event_time` ticks, harness behavior after
  a steer is forwarded, dedupe (`executedMessageIds`), `forwardedMessageIds`, transcript,
  overrides, personas, and reactions.

## When the code changes

1. If the change touches a row of the coverage table, edit that action so it again
   does what the code does, keeping one await per action.
2. Run `check.sh`. Read any change in the failing set with `/statechart` and replay it
   against the code.
3. A newly failing rule is a finding: report it in the code's words; do not change
   product code unless asked. A known finding that stops failing after an intended fix:
   remove it from `KNOWN_FAILING` in `scripts/check.sh` and from the findings above.
4. Move `Sync commit:` forward only after you have confirmed that every action still
   describes the code at the new commit.

The tool is TLC, pinned in `scripts/check.sh` (version and SHA-256). Upgrade by
changing both after verifying the new release's checksum.
