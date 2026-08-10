export const chatReplyLimits = {
  card: {
    headerTitleChars: 200,
    textParagraphChars: 8_000,
    maxCards: 10,
    // Google Chat hard limits per card: 100 widgets and 32 KB serialized.
    // Stay under both with margin so sections are never silently dropped.
    maxWidgetsPerCard: 90,
    maxCardBytes: 30_000
  },
  message: {
    // Google Chat hard-caps the plain `text` field at 4096 chars (unlike the
    // ~32 KB card envelope) — over it the send 400s. Keep margin; an answer
    // longer than this is routed to a card instead of being truncated.
    maxPlainTextChars: 4_000
  }
} as const
