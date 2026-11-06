# googlechatbot verification map

This directory is the maintained source for verifying what a Google Chat user sees from
the Centaur bot. Read this index first, then use the matching feature file as the recipe.
Every recipe drives the real webhook through `gchat-verify` (see `../SKILL.md`).

## Baseline preconditions

- From the repository root: `G=.agents/skills/verify-googlechatbot/scripts/gchat-verify`.
- `"$G" up` has started a run in this session, and `"$G" doctor` reports seven `ok` lines.
- Execution ids (`exec-N`) count up per bot process. Read them from
  `"$G" state -r '.executions[-1].executionId'`. Do not assume `exec-1`.
- Spaces: `DM` (1:1 DM), `ROOM` (named space, no proactivity), `PROACTIVE` (named space
  with contextual replies on). Users: `users/1001` (default), `users/1002` (someone else).
- Never drive an instance this run did not start.

## Driving conventions

- One user action is one `"$G" event` or `"$G" listed` call. One agent-side step is one
  `"$G" status` or `"$G" finish` call.
- Use a fresh thread id per recipe (`T1`, `T2`, ...) so state from an earlier recipe
  cannot satisfy a `wait`.
- After every action, `"$G" wait` on the state you expect. Never assert right after the
  webhook returns.
- Finish or stop every execution you start before moving on. An open stream keeps that
  thread busy.

## Proof and skip reporting

- Proof = the `actions.jsonl` line for the action, plus `"$G" snapshot <feature-id>`
  taken after the final `wait` passes.
- Name the feature file and sub-feature ID with each snapshot label, for example
  `"$G" snapshot dm-turn.dm-final`.
- Check side effects in the snapshot, not only message text: `.calls` bodies to api-rs,
  `.interrupts`, and metrics.
- If a `wait` times out, report the expression, the last `"$G" state` output, and the
  matching `bot.log` lines. Never loosen the expression to make it pass.
- Do not report an entry point as verified through a different one (for example, a text
  `stop` does not verify the Stop button).

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible
behaviour. It then has exactly four H2 sections, in this order: `Sub-features`,
`How to get to it (user POV)`, `Driving it with gchat-verify` (starts with
`Preconditions:`), and `Gotchas`.

## Features

- [DM turn](./dm-turn.md): a 1:1 DM message gets a thinking acknowledgement with a Stop
  button, status edits, and a final answer on the same message.
- [Space mention](./space-mention.md): welcome on add, unmentioned messages ignored, and
  a mention answered in its thread.
- [Stop](./stop.md): a text `stop` and the Stop button each interrupt the open execution.
- [Steering](./steering.md): the starter's follow-up joins the running turn, and someone
  else's follow-up is refused.
- [Proactive replies](./proactive.md): after a mention, unmentioned thread messages found
  by the poller are classified and answered or ignored.

Not mapped yet: attachments, harness and model flags (`--claude`, `--persona`),
slash/app commands and dialogs, the internal `/api/chat/*` tool routes, restart recovery,
and the domain allowlist.
