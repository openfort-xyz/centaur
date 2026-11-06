# Stop

While the bot is working, the user can stop the run in two ways: send `stop`, or press
the `⏹ Stop` button on the thinking message. Either way the bot interrupts the live
api-rs execution while its stream is still open. The acknowledgement then shows the
interrupted result, and the Stop button disappears.

## Sub-features

- `stop-text` interrupts the active execution when the user sends `stop`, and posts
  `⏹️ Stopped the current run.`.
- `stop-button` interrupts the active execution when the user clicks the rendered Stop
  button (Add-on callback to the endpoint with `actionName=centaur_stop`).
- `stop-render` replaces the acknowledgement with the interrupted result and drops the
  Stop card.

## How to get to it (user POV)

- Send `stop` in the thread while the bot is thinking. In a space, write `@Centaur stop`.
- Click `⏹ Stop` on the bot's thinking message.

## Driving it with gchat-verify

Preconditions:

- Baseline from the README. DM threads `T3` and `T4` have not been used in this run.

- **Start a run (text path).** Run
  `"$G" event '{"kind":"dm","thread":"T3","id":"S1","text":"keep working until told otherwise"}'`.
  Then run `"$G" wait '.executions[-1].idempotencyKey == "spaces/DM/messages/S1"'`.
- **Send stop.** Run `"$G" event '{"kind":"dm","thread":"T3","id":"S2","text":"stop"}'`.
  Then run `"$G" wait '[.interrupts[] | select(.threadKey == "chat:spaces:DM:spaces:DM:threads:T3" and .whileOpen)] | length == 1'`.
- **Text result.** Run
  `"$G" wait '[.messages[] | select(.thread.name == "spaces/DM/threads/T3") | .text] | (index("⏹️ Stopped the current run.") != null) and any(.[]; contains("interrupted"))'`.
  The acknowledgement has no `centaur-stop` card.
- **Start a run (button path).** Run
  `"$G" event '{"kind":"dm","thread":"T4","id":"B1","text":"long task"}'`. Then run
  `"$G" wait '.executions[-1].idempotencyKey == "spaces/DM/messages/B1"'` and
  `ACK=$("$G" state -r '[.messages[] | select(.thread.name == "spaces/DM/threads/T4") | .name][0]')`.
- **Rendered button.** Run `"$G" state ".messages[\"$ACK\"].cardsV2[0].card.sections[0].widgets[0].buttonList.buttons[0].onClick.action"`.
  It shows `function` `https://googlechatbot.verify.invalid/api/chat/events` with
  parameter `actionName=centaur_stop`.
- **Click Stop.** Run `"$G" event "{\"kind\":\"stop-click\",\"ack\":\"$ACK\"}"`. The
  response `event.commonEventObject` echoes that function and
  `"parameters": {"actionName": "centaur_stop"}`. Then run
  `"$G" wait '[.interrupts[] | select(.threadKey == "chat:spaces:DM:spaces:DM:threads:T4" and .whileOpen)] | length == 1'`.
- **Button result.** Run
  `"$G" wait "(.messages[\"$ACK\"].cardsV2 // [] | map(.cardId) | index(\"centaur-stop\")) == null"`.
  The acknowledgement text contains `interrupted`.
- **Counters.** Run `"$G" metrics stop_commands_total`. It shows
  `outcome="interrupted",source="text"` and `outcome="interrupted",source="card"`.
- **Proof.** Run `"$G" snapshot stop`.

## Gotchas

- The interrupted acknowledgement takes a few seconds to repaint. Wait for it; do not
  read state right after the interrupt.
- `stop-click` fails with `<ack> carries no Stop button` once the turn has finished or
  been stopped. That is the bot having removed the button, not a harness bug.
- The wording `⚠️ Centaur hit an error: interrupted` comes from the fake api-rs cancel
  payload (see SKILL.md Gotchas). Assert on `interrupted` and on the card being gone, not
  on the full sentence.
