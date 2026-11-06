# Space mention

In a named space, the bot greets the space when it is added. It stays silent on ordinary
messages and answers an @mention inside the mentioned message's thread.

## Sub-features

- `space-welcome` posts the welcome text when the app is added to a space.
- `space-ignore` makes no session call and posts nothing for an unmentioned message.
- `space-mention` answers a mentioned message with an acknowledgement in the same
  thread, then the final answer.
- `space-history` fetches thread history from Chat before executing.

## How to get to it (user POV)

- Add the Centaur app to a space (Apps & integrations, Add apps).
- In a space thread, type `@Centaur` followed by the request.

## Driving it with gchat-verify

Preconditions:

- Baseline from the README. Space `ROOM` thread `T2` has not been used in this run.

- **Add app.** The user adds Centaur to `ROOM`. Run
  `"$G" event '{"kind":"added","space":"ROOM"}'`. Status is `200`. Then run
  `"$G" wait '[.messages[] | select(.text | tostring | startswith("Hi, Centaur at your service"))] | length >= 1'`.
- **Ordinary message.** The user posts without a mention. First run
  `N=$("$G" state '.executions | length')`. Then run
  `"$G" event '{"kind":"message","space":"ROOM","thread":"T2","id":"R0","text":"anyone around?"}'`.
  Status is `200`. Then run
  `"$G" wait-metric 'proactive_decisions_total\{outcome="skip_space"\}'`, which fires once
  the bot has decided not to answer. Now `"$G" state '.executions | length'` still equals
  `$N`, and no message has `thread.name == "spaces/ROOM/threads/T2"`.
- **Mention.** Run
  `"$G" event '{"kind":"mention","space":"ROOM","thread":"T2","id":"R1","text":"@Centaur why is the deploy red?"}'`.
  Then run `"$G" wait '.executions[-1].idempotencyKey == "spaces/ROOM/messages/R1"'`.
  An acknowledgement with `thread.name == "spaces/ROOM/threads/T2"` reads
  `_Centaur is thinking…_`.
- **History.** Run `"$G" state '[.calls[] | select(.method=="GET" and (.url|contains("spaces/ROOM/messages?"))) | .url] | length > 0'`.
  It prints `true`.
- **Answer.** Run `E=$("$G" state -r '.executions[-1].executionId')` and
  `"$G" finish "$E" "The migration timed out."`. Then run
  `"$G" wait '[.messages[] | select(.thread.name == "spaces/ROOM/threads/T2" and .text == "The migration timed out.")] | length == 1'`.
- **Proof.** Run `"$G" snapshot space-mention`.

## Gotchas

- The welcome message has no thread. Match it by text, not by `thread.name`.
- The `ROOM` space is not proactivity-enabled. Unmentioned messages there are ignored
  even after a mention (metric `googlechatbot_proactive_decisions_total{outcome="skip_space"}`).
- `added` returns 403 if you launch with `GOOGLECHATBOT_ALLOWED_DOMAIN` set: the
  ADDED_TO_SPACE event carries no sender email. The default launch leaves it empty.
