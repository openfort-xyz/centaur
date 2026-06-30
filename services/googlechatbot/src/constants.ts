export const chatReplyLimits = {
  card: {
    headerTitleChars: 200,
    textParagraphChars: 8_000,
    maxCards: 10,
    maxSections: 50,
    // Google Chat hard limits per card: 100 widgets and 32 KB serialized.
    // Stay under both with margin so sections are never silently dropped.
    maxWidgetsPerCard: 90,
    maxCardBytes: 30_000
  },
  message: {
    maxTextChars: 32_000,
    // Google Chat hard-caps the plain `text` field at 4096 chars (unlike the
    // ~32 KB card envelope) — over it the send 400s. Keep margin; an answer
    // longer than this is routed to a card instead of being truncated.
    maxPlainTextChars: 4_000,
    // Short notification/summary shown above a card (kept tiny to avoid
    // rendering the answer twice).
    maxFallbackChars: 280
  },
  stream: {
    markdownChunkChars: 7_000,
    maxLiveTextChars: 22_000,
    maxPlanTasks: 24,
    taskTitleChars: 128,
    taskDetailsChars: 500,
    taskOutputChars: 500
  },
  finalPlan: {
    maxPayloadBytes: 240_000,
    maxTasks: 24,
    taskTitleChars: 140,
    taskDetailsCodeBlockLines: 4,
    taskOutputCodeBlockLines: 4,
    jsonPreviewChars: 420,
    outputPreviewChars: 2_200
  }
} as const
