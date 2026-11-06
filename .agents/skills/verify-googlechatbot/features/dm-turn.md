# DM turn

A user writes to the bot in a 1:1 DM. The bot posts `_Centaur is thinking…_` in the
thread with a `⏹ Stop` button, edits that message with status lines while the agent
works, and finally replaces it with the answer and a small model footer card.

## Sub-features

- `dm-ack` posts one thinking acknowledgement carrying the Stop card.
- `dm-session` creates the api-rs session for the DM thread and executes the user's message.
- `dm-status` shows agent status on the acknowledgement while the run is open.
- `dm-final` replaces the acknowledgement with the answer and removes the Stop button.
- `dm-transcript` sends the delivered answer back to api-rs as an assistant message.
- `dm-duplicate` treats a redelivery of the same message as one turn.

## How to get to it (user POV)

- Open a DM with the Centaur app and send any message. No mention is needed in a DM.

## Driving it with gchat-verify

Preconditions:

- Baseline from the README. Thread `T1` in space `DM` has not been used in this run.

- **Send.** The user sends `what is 2+2?`. Fix the event time so the redelivery below
  can reuse it: `T=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)`. Then run
  `"$G" event "{\"kind\":\"dm\",\"thread\":\"T1\",\"id\":\"M1\",\"text\":\"what is 2+2?\",\"eventTime\":\"$T\"}"`.
  The response is `"status": 200` with `"body": "{}"`.
- **Acknowledgement.** Run `"$G" wait '[.messages[] | select(.thread.name == "spaces/DM/threads/T1") | select(.cardsV2[0].cardId == "centaur-stop")] | length == 1'`.
  One message named `spaces/DM/messages/client-centaur-ack-…` reads
  `_Centaur is thinking…_`.
- **Session.** Run `"$G" state -r '.executions[-1] | "\(.executionId) \(.threadKey) \(.idempotencyKey)"'`.
  It prints `exec-N chat:spaces:DM:spaces:DM:threads:T1 spaces/DM/messages/M1`.
- **Status.** Run `E=$("$G" state -r '.executions[-1].executionId')` and then
  `"$G" status "$E" "Reading the repo"`. Next run
  `"$G" wait '[.messages[] | select(.thread.name == "spaces/DM/threads/T1" and .text == "_Centaur · Reading the repo…_")] | length == 1'`.
  The Stop card is still on the message.
- **Final.** Run `"$G" finish "$E" "2+2 is 4."` and then
  `"$G" wait '[.messages[] | select(.thread.name == "spaces/DM/threads/T1" and .text == "2+2 is 4.")] | length == 1'`. The same
  acknowledgement now reads `2+2 is 4.`. Its only card is `actions`, holding the model
  line (for example `Sol 5.6 · Codex · Medium`). No `centaur-stop` card remains.
- **Transcript.** Run `"$G" state '[.calls[] | select(.method=="POST" and (.url|endswith("/messages")) and (.url|contains("api-rs"))) | .body.messages[0] | {role, text: .parts[0].text}]'`.
  It shows the `user` message `what is 2+2?` and the `assistant` message `2+2 is 4.`.
- **Duplicate.** Google redelivers the same event. Rerun the Send command with the same
  `$T`. The status is `200` with body `{}`, and
  `"$G" wait-metric 'dedupe_total\{outcome="duplicate"\}'` passes. `.executions` gains
  no entry and no second acknowledgement appears in the thread.
- **Proof.** Run `"$G" snapshot dm-turn`.

## Gotchas

- The first answer in a thread carries the footer card (response metadata mode `first`).
  Later answers in the same thread have none, so do not assert `actions` on a second turn.
- Status edits are throttled. Wait for the status text; do not read state right after
  `status`.
- The DM is confirmed with a `GET spaces/DM`, and the sender is resolved through
  `admin.googleapis.com/.../users/1001`. Both calls show up in `.calls`. Identity metadata
  is still suppressed (`allowlist_empty`), which matches the deployment.
