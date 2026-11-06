------------------------- MODULE GoogleChatThreadTurn -------------------------
(***************************************************************************)
(* One Google Chat thread in services/googlechatbot: mentions that start  *)
(* or steer a turn, a mentioned "stop", and one Stop-card click, racing   *)
(* each other and the api-rs execution. Every action names the code it    *)
(* models (src/index.ts unless noted). One action = one await in the code,*)
(* except where a comment says steps were merged and why that is safe.    *)
(*                                                                         *)
(* Scope: a DM thread (canFoldIntoActiveRun is always true), one bot      *)
(* process, Google and api-rs calls always succeed, no crash/recovery.    *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT Msgs           \* mentions sent in the thread, e.g. {"m1","m2","m3"}

None == "none"

VARIABLES
  now,          \* Google's clock: each send (mention, stop, click) ticks it
  sentAt,       \* event_time of each mention (0 = not sent yet)
  pc,           \* where each mention's work obligation is
  snap,         \* createSession(...).activeExecution seen by that mention
  foldKind,     \* "checked" (session said active) or "conflict" (execute 409)
  apiRun,       \* api-rs: the thread's one active execution, named by its mention
  forwardedTo,  \* api-rs forward_messages_to_active_execution target, or None
  bubble,       \* the mention's eager ack message as the user sees it
  binding,      \* Stop-control bindings (persistStopControl / clearStopControl)
  lock,         \* withThreadHandoff holder: a mention, "stop", "card", or None
  ts,           \* GoogleChatThreadState fields this model needs (src/state.ts)
  held,         \* finishThreadRun's local copy of steeringAckMessageNames
  workStop,     \* requestWorkStop markers (src/state.ts), by mention
  stopPc, stopReq, stopHits,               \* handleStopCommand -> requestStop
  cardPc, cardAt, cardTarget, cardHits,    \* handleStopCard -> requestStop
  staleWhileRunning, killedNewer, cardHitOther  \* observations for invariants

clockV == <<now, sentAt>>
msgV   == <<snap, foldKind, forwardedTo, held>>
stopV  == <<stopPc, stopReq, stopHits>>
cardV  == <<cardPc, cardAt, cardTarget, cardHits>>
ghostV == <<staleWhileRunning, killedNewer, cardHitOther>>
vars   == <<clockV, msgV, stopV, cardV, ghostV,
            pc, apiRun, bubble, binding, lock, ts, workStop>>

Max(a, b) == IF a > b THEN a ELSE b
SetPc(m, p) == pc' = [pc EXCEPT ![m] = p]
SetBubble(m, b) == bubble' = [bubble EXCEPT ![m] = b]

Init ==
  /\ now = 0
  /\ sentAt = [m \in Msgs |-> 0]
  /\ pc = [m \in Msgs |-> "unsent"]
  /\ snap = [m \in Msgs |-> FALSE]
  /\ foldKind = [m \in Msgs |-> None]
  /\ apiRun = None
  /\ forwardedTo = [m \in Msgs |-> None]
  /\ bubble = [m \in Msgs |-> "none"]
  /\ binding = {}
  /\ lock = None
  /\ ts = [active |-> FALSE, activeId |-> None, acks |-> {},
           stopAt |-> 0, lastExecAt |-> 0]
  /\ held = [m \in Msgs |-> {}]
  /\ workStop = {}
  /\ stopPc = "unsent" /\ stopReq = 0 /\ stopHits = FALSE
  /\ cardPc = "unsent" /\ cardAt = 0 /\ cardTarget = None /\ cardHits = FALSE
  /\ staleWhileRunning = FALSE /\ killedNewer = FALSE /\ cardHitOther = FALSE

(* processWorkObligation: the mention is accepted, the eager "thinking"   *)
(* ack (with Stop card) is created, persistStopControl binds it. Merged:  *)
(* a click between the ack and the binding is stale, which is what a      *)
(* click on a not-yet-bound card should be.                               *)
Arrive(m) ==
  /\ pc[m] = "unsent"
  /\ now' = now + 1
  /\ sentAt' = [sentAt EXCEPT ![m] = now + 1]
  /\ SetBubble(m, "thinking")
  /\ binding' = binding \cup {m}
  /\ SetPc(m, "acked")
  /\ UNCHANGED <<msgV, stopV, cardV, ghostV, apiRun, lock, ts, workStop>>

(* driveSession -> withThreadHandoff (src/state.ts) *)
HandoffAcquire(m) ==
  /\ pc[m] = "acked" /\ lock = None
  /\ lock' = m
  /\ SetPc(m, "locked")
  /\ UNCHANGED <<clockV, msgV, stopV, cardV, ghostV, apiRun, bubble, binding, ts, workStop>>

(* handoffTurn: createSession returns session.activeExecution *)
CreateSession(m) ==
  /\ pc[m] = "locked"
  /\ snap' = [snap EXCEPT ![m] = (apiRun # None)]
  /\ SetPc(m, "session")
  /\ UNCHANGED <<clockV, foldKind, forwardedTo, held, stopV, cardV, ghostV,
                 apiRun, bubble, binding, lock, ts, workStop>>

(* handoffTurn: re-read `latest` and workStopRequestedAt; stopRequestedFor *)
(* or a card marker means stopped-before-start: clearStopControl,          *)
(* deliverStoppedBeforeStart, updateThreadState, then the lock is released.*)
(* Merged: all under the handoff lock, and nothing outside the lock reads  *)
(* this mention's bubble or the cutoff in between. Otherwise branch on     *)
(* session.activeExecution: fold (steer) or execute.                       *)
StopCheck(m) ==
  /\ pc[m] = "session"
  /\ IF ts.stopAt >= sentAt[m] \/ m \in workStop
       THEN LET superseded == ts.lastExecAt > sentAt[m] \/ ts.active
                cut == Max(ts.stopAt, IF m \in workStop THEN cardAt ELSE 0)
            IN /\ binding' = binding \ {m}
               /\ SetBubble(m, "stopped")
               /\ ts' = IF superseded THEN ts ELSE [ts EXCEPT !.stopAt = cut]
               /\ lock' = None
               /\ SetPc(m, "done")
               /\ UNCHANGED foldKind
       ELSE /\ IF snap[m]
                 THEN /\ SetPc(m, "foldAppend")
                      /\ foldKind' = [foldKind EXCEPT ![m] = "checked"]
                 ELSE /\ SetPc(m, "execute")
                      /\ UNCHANGED foldKind
            /\ UNCHANGED <<binding, bubble, ts, lock>>
  /\ UNCHANGED <<clockV, snap, forwardedTo, held, stopV, cardV, ghostV, apiRun, workStop>>

(* handoffTurn: executeSession. api-rs rejects a second active execution  *)
(* (409 -> classifyExecuteConflict 'conflict' -> foldIntoActiveRun).       *)
Execute(m) ==
  /\ pc[m] = "execute"
  /\ IF apiRun # None
       THEN /\ SetPc(m, "foldAppend")
            /\ foldKind' = [foldKind EXCEPT ![m] = "conflict"]
            /\ UNCHANGED apiRun
       ELSE /\ apiRun' = m
            /\ SetPc(m, "started")
            /\ UNCHANGED foldKind
  /\ UNCHANGED <<clockV, snap, forwardedTo, held, stopV, cardV, ghostV,
                 bubble, binding, lock, ts, workStop>>

(* handoffTurn after execute: appendSessionMessagesBestEffort (forward    *)
(* false, so no steering), updateThreadState({activeExecution: true,      *)
(* activeExecutionId, lastExecutedAt}), persistWork(executionId), release.*)
(* Merged: all under the handoff lock; the append steers nothing.          *)
RecordStart(m) ==
  /\ pc[m] = "started"
  /\ ts' = [ts EXCEPT !.active = TRUE, !.activeId = m, !.lastExecAt = sentAt[m]]
  /\ lock' = None
  /\ SetPc(m, "rendering")
  /\ UNCHANGED <<clockV, msgV, stopV, cardV, ghostV, apiRun, bubble, binding, workStop>>

(* appendSessionMessages (forward default true). api-rs                    *)
(* append_messages_with_forwarding -> forward_messages_to_active_execution *)
(* steers the execution active at this instant, or silently none.          *)
FoldAppend(m) ==
  /\ pc[m] = "foldAppend"
  /\ forwardedTo' = [forwardedTo EXCEPT ![m] = apiRun]
  /\ SetPc(m, "foldHold")
  /\ UNCHANGED <<clockV, snap, foldKind, held, stopV, cardV, ghostV,
                 apiRun, bubble, binding, lock, ts, workStop>>

(* holdSteeringAck: the ack is edited to STEERING_STATUS, card removed. *)
FoldHold(m) ==
  /\ pc[m] = "foldHold"
  /\ SetBubble(m, "steering")
  /\ SetPc(m, "foldRecord")
  /\ UNCHANGED <<clockV, msgV, stopV, cardV, ghostV, apiRun, binding, lock, ts, workStop>>

(* updateThreadState({activeExecution: true (checked path only),          *)
(* steeringAckMessageNames: [ack]}), noRun -> clearStopControl, release.  *)
(* Merged: under the handoff lock; a card checks the binding before it    *)
(* takes the lock, so it cannot observe the gap.                           *)
FoldRecord(m) ==
  /\ pc[m] = "foldRecord"
  /\ ts' = [ts EXCEPT !.acks = @ \cup {m},
                      !.active = IF foldKind[m] = "checked" THEN TRUE ELSE @]
  /\ binding' = binding \ {m}
  /\ lock' = None
  /\ SetPc(m, "noRun")
  /\ UNCHANGED <<clockV, msgV, stopV, cardV, ghostV, apiRun, bubble, workStop>>

(* processWorkObligation -> finishWork deletes the obligation; until then *)
(* a Stop card's boundTo still finds it (stage 'thinking', no executionId).*)
WorkFinished(m) ==
  /\ pc[m] = "noRun"
  /\ SetPc(m, "done")
  /\ UNCHANGED <<clockV, msgV, stopV, cardV, ghostV, apiRun, bubble, binding, lock, ts, workStop>>

(* renderTurn: the event stream is terminal once api-rs ended the run;    *)
(* clearStopControl, finalizeRender PATCHes the ack into the answer.      *)
FinalRender(m) ==
  /\ pc[m] = "rendering" /\ apiRun # m
  /\ binding' = binding \ {m}
  /\ SetBubble(m, "answer")
  /\ SetPc(m, "finishLock")
  /\ UNCHANGED <<clockV, msgV, stopV, cardV, ghostV, apiRun, lock, ts, workStop>>

(* finishThreadRun -> withThreadHandoff (src/state.ts) *)
FinishAcquire(m) ==
  /\ pc[m] = "finishLock" /\ lock = None
  /\ lock' = m
  /\ SetPc(m, "finishClear")
  /\ UNCHANGED <<clockV, msgV, stopV, cardV, ghostV, apiRun, bubble, binding, ts, workStop>>

(* finishThreadRun under the handoff lock: read the thread state; when a   *)
(* newer execution owns it (activeExecutionId set and not ours) leave it;  *)
(* else updateThreadState({activeExecution: false, activeExecutionId:      *)
(* null, steeringAckMessageNames: []}) and keep the read names; release.   *)
(* Merged: every write of activeExecution, activeExecutionId, and          *)
(* steeringAckMessageNames runs under this lock, so nothing lands between  *)
(* the read and the clear.                                                 *)
FinishClear(m) ==
  /\ pc[m] = "finishClear"
  /\ IF ts.activeId # None /\ ts.activeId # m
       THEN /\ held' = [held EXCEPT ![m] = {}]
            /\ UNCHANGED ts
       ELSE /\ held' = [held EXCEPT ![m] = ts.acks]
            /\ ts' = [ts EXCEPT !.active = FALSE, !.activeId = None, !.acks = {}]
  /\ lock' = None
  /\ SetPc(m, "finishDelete")
  /\ UNCHANGED <<clockV, snap, foldKind, forwardedTo, stopV, cardV, ghostV,
                 apiRun, bubble, binding, workStop>>

(* finishThreadRun: removeAck for each held name. *)
FinishDelete(m) ==
  /\ pc[m] = "finishDelete"
  /\ bubble' = [a \in Msgs |-> IF a \in held[m] THEN "deleted" ELSE bubble[a]]
  /\ SetPc(m, "done")
  /\ UNCHANGED <<clockV, msgV, stopV, cardV, ghostV, apiRun, binding, lock, ts, workStop>>

(* api-rs: the execution finishes on its own, at any time. *)
RunCompletes ==
  /\ apiRun # None
  /\ apiRun' = None
  /\ UNCHANGED <<clockV, msgV, stopV, cardV, ghostV, pc, bubble, binding, lock, ts, workStop>>

(* ---- mentioned "stop": classifyWork 'stop-text' -> handleStopCommand ---- *)
StopSent ==
  /\ stopPc = "unsent"
  /\ now' = now + 1
  /\ stopReq' = now + 1
  /\ stopPc' = "sent"
  /\ UNCHANGED <<sentAt, msgV, stopHits, cardV, ghostV, pc, apiRun, bubble, binding, lock, ts, workStop>>

(* requestStop: persistIntent before the lock (stopRequestedAt only rises). *)
StopPersist ==
  /\ stopPc = "sent"
  /\ ts' = [ts EXCEPT !.stopAt = Max(@, stopReq)]
  /\ stopPc' = "persisted"
  /\ UNCHANGED <<clockV, msgV, stopReq, stopHits, cardV, ghostV, pc, apiRun, bubble, binding, lock, workStop>>

StopAcquire ==
  /\ stopPc = "persisted" /\ lock = None
  /\ lock' = "stop"
  /\ stopPc' = "locked"
  /\ UNCHANGED <<clockV, msgV, stopReq, stopHits, cardV, ghostV, pc, apiRun, bubble, binding, ts, workStop>>

(* requestStop under the lock: newerTurnActive from the thread state. *)
StopDecide ==
  /\ stopPc = "locked"
  /\ stopHits' = ~(ts.active /\ ts.lastExecAt > stopReq)
  /\ stopPc' = "decided"
  /\ UNCHANGED <<clockV, msgV, stopReq, cardV, ghostV, pc, apiRun, bubble, binding, lock, ts, workStop>>

(* interruptSessionExecution: api-rs interrupts whatever run is active. *)
StopInterrupt ==
  /\ stopPc = "decided"
  /\ IF stopHits
       THEN /\ killedNewer' = (killedNewer \/ (apiRun # None /\ sentAt[apiRun] > stopReq))
            /\ apiRun' = None
       ELSE UNCHANGED <<killedNewer, apiRun>>
  /\ lock' = None
  /\ stopPc' = "done"
  /\ UNCHANGED <<clockV, msgV, stopReq, stopHits, cardV, staleWhileRunning, cardHitOther,
                 pc, bubble, binding, ts, workStop>>

(* ---- Stop card: googleChatWorkflowEvent 'stop-card' -> handleStopCard ---- *)
(* The card is on the ack while it still shows "thinking" (status edits    *)
(* keep it; steering, stopped, busy, and final edits drop it).             *)
CardClick(m) ==
  /\ cardPc = "unsent" /\ bubble[m] = "thinking"
  /\ now' = now + 1
  /\ cardAt' = now + 1
  /\ cardTarget' = m
  /\ cardPc' = "clicked"
  /\ UNCHANGED <<sentAt, msgV, stopV, cardHits, ghostV, pc, apiRun, bubble, binding, lock, ts, workStop>>

(* handleStopCard: the binding must exist; then requestWorkStop. Merged:   *)
(* the marker only matters to the target's own StopCheck, which a binding  *)
(* cleared in between has already passed.                                  *)
CardIntent ==
  /\ cardPc = "clicked"
  /\ IF cardTarget \in binding
       THEN /\ workStop' = workStop \cup {cardTarget}
            /\ cardPc' = "intent"
       ELSE /\ cardPc' = "done"
            /\ UNCHANGED workStop
  /\ UNCHANGED <<clockV, msgV, stopV, cardAt, cardTarget, cardHits, ghostV,
                 pc, apiRun, bubble, binding, lock, ts>>

CardAcquire ==
  /\ cardPc = "intent" /\ lock = None
  /\ lock' = "card"
  /\ cardPc' = "locked"
  /\ UNCHANGED <<clockV, msgV, stopV, cardAt, cardTarget, cardHits, ghostV,
                 pc, apiRun, bubble, binding, ts, workStop>>

(* requestStop with boundTo: the target work must exist and not be final;  *)
(* with an executionId it must be ts.activeExecutionId, without one the    *)
(* thread must not be marked active. Then clearStopControl, persistIntent, *)
(* and newerTurnActive from the same snapshot. Merged: under the lock.     *)
CardDecide ==
  /\ cardPc = "locked"
  /\ LET t == cardTarget
         live == pc[t] \notin {"done", "finishLock", "finishClear", "finishDelete"}
         bound == live /\ IF pc[t] = "rendering" THEN ts.activeId = t ELSE ~ts.active
     IN IF bound
          THEN /\ binding' = binding \ {t}
               /\ ts' = [ts EXCEPT !.stopAt = Max(@, cardAt)]
               /\ cardHits' = ~(ts.active /\ ts.lastExecAt > cardAt)
               /\ cardPc' = "decided"
               /\ UNCHANGED <<lock, staleWhileRunning>>
          ELSE /\ staleWhileRunning' = (staleWhileRunning \/ apiRun = t)
               /\ lock' = None
               /\ cardPc' = "done"
               /\ UNCHANGED <<binding, ts, cardHits>>
  /\ UNCHANGED <<clockV, msgV, stopV, cardAt, cardTarget, killedNewer, cardHitOther,
                 pc, apiRun, bubble, workStop>>

CardInterrupt ==
  /\ cardPc = "decided"
  /\ IF cardHits
       THEN /\ killedNewer' = (killedNewer \/ (apiRun # None /\ sentAt[apiRun] > cardAt))
            /\ cardHitOther' = (cardHitOther \/ apiRun \notin {None, cardTarget})
            /\ apiRun' = None
       ELSE UNCHANGED <<killedNewer, cardHitOther, apiRun>>
  /\ lock' = None
  /\ cardPc' = "done"
  /\ UNCHANGED <<clockV, msgV, stopV, cardAt, cardTarget, cardHits, staleWhileRunning,
                 pc, bubble, binding, ts, workStop>>

(* Nothing is in flight: api-rs idle, every obligation finished or unsent. *)
Quiet ==
  /\ apiRun = None
  /\ \A m \in Msgs : pc[m] \in {"unsent", "done"}
  /\ stopPc \in {"unsent", "done"}
  /\ cardPc \in {"unsent", "done"}

(* End state: everything sent and handled; a click is only possible on a   *)
(* "thinking" ack, so an unclicked card may remain once none is left.      *)
Done ==
  /\ Quiet
  /\ \A m \in Msgs : pc[m] = "done"
  /\ stopPc = "done"
  /\ cardPc = "done" \/ \A m \in Msgs : bubble[m] # "thinking"
  /\ UNCHANGED vars

Next ==
  \/ \E m \in Msgs :
       \/ Arrive(m) \/ HandoffAcquire(m) \/ CreateSession(m) \/ StopCheck(m)
       \/ Execute(m) \/ RecordStart(m)
       \/ FoldAppend(m) \/ FoldHold(m) \/ FoldRecord(m) \/ WorkFinished(m)
       \/ FinalRender(m) \/ FinishAcquire(m) \/ FinishClear(m) \/ FinishDelete(m)
       \/ CardClick(m)
  \/ RunCompletes
  \/ StopSent \/ StopPersist \/ StopAcquire \/ StopDecide \/ StopInterrupt
  \/ CardIntent \/ CardAcquire \/ CardDecide \/ CardInterrupt
  \/ Done

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants. Each is checked in its own TLC run by scripts/check.sh.     *)

(* A Stop card pressed on a turn that api-rs is still running is never    *)
(* refused as stale.                                                       *)
StopButtonStopsRunningTurn == ~staleWhileRunning

(* A Stop card only interrupts the turn its own ack belongs to.           *)
StopButtonOnlyStopsItsTurn == ~cardHitOther

(* A stop never interrupts a turn started by a mention sent after it      *)
(* ("an older stop never kills a newer turn", requestStop).               *)
StopNeverKillsNewerTurn == ~killedNewer

(* A mention shown "added to the running turn" was forwarded into a run.  *)
SteeringNoticeMeansForwarded ==
  \A m \in Msgs : bubble[m] = "steering" => forwardedTo[m] # None

(* Once the thread is quiet, no "added to the running turn" notice is left.*)
NoSteeringNoticeOnceQuiet ==
  Quiet => \A m \in Msgs : bubble[m] # "steering"

(* Once the thread is quiet, thread state does not claim a run is active. *)
ThreadMarkedIdleOnceQuiet == Quiet => ~ts.active

(* Once the thread is quiet, no ack is left at "thinking".                *)
EveryAckResolvedOnceQuiet ==
  Quiet => \A m \in Msgs : bubble[m] # "thinking"
=============================================================================
