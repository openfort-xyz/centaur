---
name: verify-googlechatbot
description: "Launch and drive the Google Chat bot (services/googlechatbot) locally the way a Chat user does: signed Workspace Add-on events into the real webhook, a disposable Postgres, and fake Google Chat / api-rs / classifier endpoints that record every reply the bot posts. Use to prove a googlechatbot change (DM turns, space mentions, Stop, steering, proactive replies) before pushing, or when unit tests pass but you need the real server path. Never touches real Google Chat, live Google APIs, or any cluster."
---

# Verify googlechatbot

The real `src/server.ts` runs unchanged. It starts with `bun --preload
scripts/verify-harness.ts`, which swaps `globalThis.fetch` for fakes before the server loads:

| Boundary | In this harness | Real code exercised |
| --- | --- | --- |
| Google → bot webhook | RS256 Add-on bearer signed by the harness, POSTed over HTTP to `/api/chat/events` | signature check, envelope parsing, dedupe, durable accept |
| Postgres state | real Postgres 14+ cluster in the run dir (`initdb`) | `@chat-adapter/state-pg`, leases, obligations, poll cursors |
| Google Chat REST, OAuth token, JWKS, Admin directory | in-process fakes (`src/test-session-mock.ts` plus `fakeGoogle` in the harness) | Chat client, token exchange, sender lookup, render/PATCH/DELETE |
| api-rs session API | `test-session-mock.ts`; the driver controls each SSE stream | session create, append, execute, interrupt, event-stream render |
| OpenAI Decisions (proactive classifier) | fake that answers what `gchat-verify decision` set | poller → classifier → run |

The bot runs with the deployed shape: `workspace_addon` ingress, signed requests on,
directory lookup on, `allowedDomain` empty, proactivity on for `spaces/PROACTIVE` only.
The fakes cover every outbound host. An unknown host throws `unexpected fetch in test`
inside the bot and never reaches the network. `doctor` checks for that line.

This harness does not reach api-rs, the sandbox, a harness/model, Helm wiring, or
Google's real wire behaviour. When you change api-rs or a cross-service contract, also
use the kind stack (`.agents/skills/e2e-testing`, Slack only). When you need Google's
real behaviour, use a live Workspace check. Results from this harness do not show either one.

All commands run from the repository root:

```bash
G=.agents/skills/verify-googlechatbot/scripts/gchat-verify
"$G" help
```

## Launch

Prerequisites: `bun`, `initdb`/`pg_ctl` (Postgres 14+), `jq`, `curl`, `openssl`, `lsof`,
and `trash` on PATH. Install dependencies once from the repo root with
`pnpm install --frozen-lockfile`. Never run `bun install` in the service dir: it breaks the
workspace links and leaves a stray `bun.lock`.

```bash
"$G" up
# run=20261106-153215-36986 bot=http://127.0.0.1:65490 control=http://127.0.0.1:65491
# evidence=/tmp/verify-googlechatbot/evidence/20261106-153215-36986
```

`up` picks three free ports and runs `initdb` into `/tmp/verify-googlechatbot/runs/<run>/pg`.
It generates a throwaway service-account key and starts the bot with `env -i`, so ambient
`DATABASE_URL`, `OPENAI_API_KEY`, or kube settings cannot leak in. It returns only after
`/health/ready` answers 200 (Postgres state connected) and the control API answers.
Readiness takes about 2 s. On failure it prints which log to read:
`runs/<run>/bot.log`, `postgres.log`, or `initdb.log`.

Isolation: every `up` is a separate run with its own ports, data dir, and evidence dir.
`/tmp/verify-googlechatbot/current` points at the latest run. Set
`GCHAT_VERIFY_RUN=<run>` to address an older one. Never drive a run you did not start.
Set `GCHAT_VERIFY_ROOT` to move everything off `/tmp`.

## Doctor

Read-only. Run it first, and again whenever anything looks off:

```bash
"$G" doctor
```

It checks seven things. The recorded pid is alive and running `verify-harness.ts`. That
pid owns the bot port (`lsof`). The control port is served by the same pid. Postgres is
running from this run's data dir. `/health/ready` reports `ok` and `database_connected`.
`/health/live` `commit` matches the checkout: HEAD plus a content hash of
`services/googlechatbot` and `packages`. Bun runs source, so an edit after `up` makes this
check fail; restart with `down` then `up`. Last, `bot.log` has no `unexpected fetch in test`.
Any `FAIL` exits 1.

## Drive

`event` builds a Workspace Add-on envelope, signs it, and POSTs it to the bot's real
webhook. It prints `{status, body, event}`. A healthy delivery is `200` with body `{}`.

```bash
"$G" event '{"kind":"dm","id":"M1","text":"what is 2+2?"}'
"$G" event '{"kind":"mention","space":"ROOM","thread":"T1","id":"R1","text":"@Centaur why?"}'
"$G" event '{"kind":"message","space":"ROOM","thread":"T1","id":"R2","text":"no mention"}'
"$G" event '{"kind":"added","space":"ROOM"}'
"$G" event '{"kind":"stop-click","ack":"spaces/DM/messages/client-centaur-ack-..."}'
```

| field | default | meaning |
| --- | --- | --- |
| `kind` | (required) | `dm`, `mention`, `message` (no mention), `added` (ADDED_TO_SPACE), `stop-click` |
| `space` | `DM` for `dm`, else `ROOM` | space id. Any id starting `DM` is a 1:1 DM, anything else a named SPACE |
| `thread` | `T1` | thread id under the space |
| `id` | (required for messages) | message id. Reusing one is a duplicate delivery |
| `user` | `users/1001` | sender. Numeric ids resolve to `user<id>@example.test`. Use `users/1002` as "someone else" |
| `ack` | (required for `stop-click`) | the acknowledgement message to click. The click replays the Stop action exactly as the bot rendered it |
| `eventTime` | now | RFC 3339 event time. Reuse an earlier one to replay a Google redelivery. It must be under 5 minutes old |

The bot is `users/123456789`. Mentions annotate that user.

Driving the agent side (the fake api-rs):

```bash
"$G" state -r '.executions[-1].executionId'          # exec-N, numbered per process
"$G" status exec-1 "Reading the repo"                # status line while the stream is open
"$G" finish exec-1 "2+2 is 4."                       # final answer, closes the stream
"$G" listed '{"id":"Q2","text":"thanks!"}'           # message only the poller sees (space PROACTIVE)
"$G" decision true                                   # fake classifier says respond (default false)
```

Observing:

```bash
"$G" state '.messages'      # every Chat message as last written, keyed by resource name
"$G" state '.executions'    # {threadKey, executionId, idempotencyKey} per execute
"$G" state '.interrupts'    # {threadKey, reason, whileOpen, executionId}
"$G" state '.open_streams'  # executions whose SSE stream is still open
"$G" state '.calls'         # every outbound request: method, url, parsed JSON body
"$G" metrics 'runs_total|stop_commands'
"$G" wait '<jq expression over state>' [timeout-seconds, default 15]
"$G" wait-metric '<regex over /metrics lines>' [timeout-seconds]
```

The bot processes events in the background after answering `{}`. Always `wait` on the
state you expect. A bare `sleep` is not enough. Acknowledgements are named
`spaces/<s>/messages/client-centaur-ack-<uuid>`. Find one by thread:

```bash
"$G" state -r '[.messages[] | select(.thread.name == "spaces/DM/threads/T1") | .name][0]'
```

Per-feature recipes live in [`features/`](features/README.md).

## Evidence

Location: `/tmp/verify-googlechatbot/evidence/<run>/`. `down` never deletes it.

- `actions.jsonl` is appended automatically by every `event`, `listed`, `decision`,
  `status`, and `finish`. Each line holds the request and the response, including the exact
  signed envelope the bot received.
- `"$G" snapshot <label>` writes `<label>.state.json` (every Chat message, execution,
  interrupt, and outbound call), `<label>.metrics.txt`, and `<label>.bot.log`.
- `down` adds `final.bot.log` and `final.postgres.log`.

Proof standards:

- Drive through `event` / `listed`. They are the user path: a signed webhook delivery, or a
  message the poller lists. Never call bot internals or the bot's `/api/chat/*` internal
  routes to stand in for a user action.
- Capture the action and the resulting state: the `actions.jsonl` line, then a snapshot
  after the `wait` succeeds. A 200 from the webhook only proves acceptance.
- Check side effects as well as the visible text: the `execute` and `messages` bodies sent
  to api-rs (`.calls`), `.interrupts`, and the metrics counters.
- The fakes stand only where a production network boundary already exists (Google, api-rs,
  OpenAI). A pass here proves the bot's side of those contracts, not the other side.

## Cleanup

```bash
"$G" down
```

`down` sends SIGTERM to the recorded pid, and only after checking that it still runs
`verify-harness.ts`. If the pid is still alive after 15 s it sends SIGKILL. It stops this
run's Postgres with `pg_ctl -D <run>/pg`, copies the final logs into the evidence dir,
then `trash`es `runs/<run>` and the `current` pointer. It never kills by process name.
Run it after every failed attempt too. If `up` died halfway, `down` still cleans up
whatever was started.

## Helpers

- `scripts/gchat-verify` is the only entry point. `"$G" help` lists every subcommand.
- `services/googlechatbot/scripts/verify-harness.ts` is the Bun preload. It holds the
  fakes and the control API on `127.0.0.1:<control port>`: `/health`, `/state`, `/event`,
  `/listed`, `/decision`, `/status`, `/finish`. `bun run check:types` covers it.
  It reuses `src/test-session-mock.ts` and `src/chat/test-jwt.ts`. Extend those for new
  fake behaviour; do not fork them.

## Gotchas

- The fake api-rs turns an interrupt into `session.execution_cancelled` with
  `{"error":"interrupted"}`. The acknowledgement then reads
  `⚠️ Centaur hit an error: interrupted`. Real api-rs may word this differently.
- The fake `spaces.messages.list` returns one global list (`listed`) for every space and
  ignores filters. Thread-history context and the poller both read it. Only add `listed`
  messages for the space you are testing.
- With `allowedDomain` empty (the deployed value), session identity is always suppressed
  (`googlechatbot_session_identity_suppressed reason: allowlist_empty`). A sender email
  still gates steering through the directory lookup. Do not set `GOOGLECHATBOT_ALLOWED_DOMAIN`
  for ordinary runs: only MESSAGE events resolve a sender email, so with an allowlist set,
  `added` events are rejected with 403 (`domain_not_allowlisted`).
- The proactive poller runs every second against `spaces/PROACTIVE`, so `.calls` grows by
  about 3 entries per second. Filter it with jq, and keep runs short.
