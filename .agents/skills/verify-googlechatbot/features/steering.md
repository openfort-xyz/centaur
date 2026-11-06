# Steering

While a turn is running in a shared space, the person who started it can mention the bot
again, and the new message joins the running execution instead of starting another one.
Anyone else who mentions the bot in that thread gets a "still running" notice, and their
message is not passed to the run.

## Sub-features

- `steer-same-user` appends the starter's follow-up to the active session and shows
  `_Centaur · added to the running turn…_`.
- `steer-other-user` refuses another user's follow-up with
  `_Centaur · someone else's turn is still running in this thread. Ask again once it finishes._`.
- `steer-final` delivers the run's answer on the original acknowledgement and deletes the
  steering notice.

## How to get to it (user POV)

- In a space thread where Centaur is working on your request, write `@Centaur` plus more
  instructions.
- As a different person, `@Centaur` in that same thread while it is still working.

## Driving it with gchat-verify

Preconditions:

- Baseline from the README. Space `ROOM` thread `T5` has not been used in this run.

- **Start.** `users/1001` mentions the bot. Run
  `"$G" event '{"kind":"mention","space":"ROOM","thread":"T5","id":"P1","text":"@Centaur refactor the parser"}'`.
  Then run `"$G" wait '.executions[-1].idempotencyKey == "spaces/ROOM/messages/P1"'` and
  `E=$("$G" state -r '.executions[-1].executionId')`.
- **Same user steers.** Run
  `"$G" event '{"kind":"mention","space":"ROOM","thread":"T5","id":"P2","text":"@Centaur also keep the old API"}'`.
  Then run `"$G" wait '[.messages[] | select(.thread.name == "spaces/ROOM/threads/T5" and .text == "_Centaur · added to the running turn…_")] | length == 1'`.
  `"$G" state '[.calls[] | select((.url|contains("api-rs")) and (.url|endswith("/messages"))) | .body.messages[].client_message_id]'`
  includes `spaces/ROOM/messages/P2`, and `.executions | length` did not grow.
- **Other user refused.** Run
  `"$G" event '{"kind":"mention","space":"ROOM","thread":"T5","id":"P3","text":"@Centaur do something else","user":"users/1002"}'`.
  Then run `"$G" wait '[.messages[] | select(.text | tostring | contains("still running in this thread"))] | length == 1'`.
  No api-rs `/messages` body contains `spaces/ROOM/messages/P3`.
- **Final.** Run `"$G" finish "$E" "Refactored; old API kept."` and then
  `"$G" wait '[.messages[] | select(.thread.name == "spaces/ROOM/threads/T5" and .text == "_Centaur · added to the running turn…_")] | length == 0'`.
  The thread holds the answer `Refactored; old API kept.` and the refusal notice.
- **Counters.** `"$G" metrics runs_total` shows `outcome="folded"` and
  `outcome="refused_other_requester"`.
- **Proof.** Run `"$G" snapshot steering`.

## Gotchas

- Same-user steering in a space depends on the sender's email from the directory lookup.
  If `admin.googleapis.com` calls are missing from `.calls`, every follow-up is refused.
- In a DM every follow-up steers (there is only one human), so a DM does not exercise
  `steer-other-user`.
- The appended steering body has no `forward_to_active_execution` field. Assert on the
  message id, not on that flag.
