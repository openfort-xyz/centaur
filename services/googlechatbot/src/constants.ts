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
    // `text` on a card-less reply carries the whole answer — allow most of the
    // 32 KB envelope instead of the old 4 KB clamp that silently dropped tails.
    maxPlainTextChars: 28_000,
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
