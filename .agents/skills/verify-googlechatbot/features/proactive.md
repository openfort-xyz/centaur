# Proactive replies

In a space with contextual replies enabled, mentioning Centaur opts the thread in. Later
messages in that thread that do not mention the bot are picked up by the poller. The
classifier decides whether each one deserves an answer: worthwhile ones get a normal
reply, and chatter stays silent.

## Sub-features

- `proactive-opt-in` makes a mention in an enabled space turn the thread eligible.
- `proactive-decline` classifies an unmentioned message the classifier declines; no run
  starts and nothing is posted.
- `proactive-respond` classifies an unmentioned message the classifier accepts and starts
  a run in the thread with the usual acknowledgement.
- `proactive-busy` stays silent for an unmentioned message seen while a run is active,
  without classifying it.

## How to get to it (user POV)

- In an enabled space, `@Centaur` once in a thread, then keep talking in that thread
  without mentioning it.

## Driving it with gchat-verify

Preconditions:

- Baseline from the README. Space `PROACTIVE` thread `T1` has not been used in this run.
  `PROACTIVE` is the only enabled space, and it is polled every second.

- **Opt in.** Run
  `"$G" event '{"kind":"mention","space":"PROACTIVE","thread":"T1","id":"Q1","text":"@Centaur why is the deploy red?"}'`.
  Then run `"$G" wait '.executions[-1].idempotencyKey == "spaces/PROACTIVE/messages/Q1"'`,
  `E=$("$G" state -r '.executions[-1].executionId')`, and
  `"$G" finish "$E" "The migration timed out."`.
- **Wait for the render.** Run
  `"$G" wait '[.messages[] | select(.thread.name == "spaces/PROACTIVE/threads/T1" and .text == "The migration timed out.")] | length == 1'`.
- **Decline.** Run `"$G" decision false` and `"$G" listed '{"id":"Q2","text":"thanks!"}'`.
  Then run `"$G" wait '[.calls[] | select(.url | endswith("/decisions"))] | length == 1'`.
  `"$G" metrics proactive_decisions_total` shows `outcome="decline"`, and the last entry
  in `.executions` is still for Q1.
- **Respond.** Run `"$G" decision true` and
  `"$G" listed '{"id":"Q3","text":"what about staging, is it red too?"}'`. Then run
  `"$G" wait '.executions[-1].idempotencyKey == "spaces/PROACTIVE/messages/Q3"'`. A new
  `_Centaur is thinking…_` acknowledgement appears in `spaces/PROACTIVE/threads/T1`.
- **Busy.** While that run is open, run `"$G" listed '{"id":"Q4","text":"and prod?"}'`.
  Then run `"$G" wait-metric 'proactive_collected_total\{outcome="active_execution"\}'`.
  The `/decisions` count is unchanged (still 2).
- **Close.** Run `"$G" finish "$("$G" state -r '.executions[-1].executionId')" "Staging is green."`.
- **Proof.** Run `"$G" snapshot proactive`.

## Gotchas

- `finish` closes the fake stream at once, but the bot marks the thread idle only after
  its final render. A message listed before the answer appears is counted
  `active_execution` and never classified. Always wait for the final text first.
- Count `/decisions` calls cumulatively across the run. Earlier recipes in the same run
  may already have made some.
- A listed message older than the poller's cursor (its createTime is before the poll
  started) is skipped. `listed` stamps the current time, so always add messages
  through it.
