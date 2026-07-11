// Google Chat analog of services/slackbotv2/src/stop-command.ts (#911/#915):
// a bare "stop"/"kill"/"cancel" mention interrupts the thread's active run
// instead of being forwarded to the harness as a new turn. The pattern is
// kept byte-identical to the Slack one so both surfaces accept the same
// phrasings.
const STOP_COMMAND_PATTERN = new RegExp(
  [
    String.raw`^`,
    String.raw`(?:(?:please|pls)\s+)?`,
    String.raw`(?:(?:can|could|would|will)\s+you\s+)?`,
    String.raw`(?:stop+|kill(?:ed|ing|s)?|end(?:ed|ing|s)?|cancell?(?:ed|ing|s)?)`,
    String.raw`(?:\s+(?:it|this|that|now|please|pls|the\s+(?:run|execution|request|job|thread|turn)))*`,
    String.raw`[.!?]*$`
  ].join(''),
  'i'
)

export function isChatStopCommand(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  // normalize.ts already prefers argumentText (bot mention pre-stripped by
  // Google) and rewrites other <users/{id}> tokens to @{id} before the bot
  // sees the text. Strip raw tokens (defensive) and standalone @mentions;
  // mid-word @ (emails like user@example.com) is left alone.
  const withoutMentions = trimmed
    .replace(/<users\/[^>]+>/gi, ' ')
    .replace(/(^|\s)@[A-Za-z0-9._/-]+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return STOP_COMMAND_PATTERN.test(withoutMentions)
}
