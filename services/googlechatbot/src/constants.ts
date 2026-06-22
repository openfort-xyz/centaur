export const chatReplyLimits = {
  card: {
    headerTitleChars: 200,
    textParagraphChars: 8_000,
    maxCards: 10,
    maxSections: 50
  },
  message: {
    maxTextChars: 32_000,
    maxFallbackChars: 4_000
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
