export const chatReplyLimits = {
  card: {
    headerTitleChars: 200,
    // Application chunk size, measured as UTF-8 bytes. Google doesn't publish a
    // textParagraph limit; small widgets make exact whole-message packing cheap.
    textParagraphBytes: 8_000,
    maxWidgetsPerCard: 100
  },
  message: {
    // Official create limit: the complete Message, including text and cards.
    maxBytes: 32_000
  }
} as const

/** The Stop button's action name. Chat API apps send it as
 * `onClick.action.function`; Workspace Add-ons must send the app's own HTTP
 * endpoint URL as `function` and carry the name as the `actionName`
 * parameter. CARD_CLICKED events echo whichever shape was sent. */
export const STOP_CARD_FUNCTION = 'centaur_stop'
