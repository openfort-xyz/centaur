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
