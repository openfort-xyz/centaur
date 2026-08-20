import { createHash } from 'node:crypto'

export type GoogleChatHarnessAssignment = {
  experiment: string
  requestedHarness: string
  cohort: string
  rolloutPercent: number
}

export function resolveHarnessRollout(input: {
  modelOverride?: string
  requestedHarness: string
  rolloutPercent: number
  threadId: string
}): { assignment?: GoogleChatHarnessAssignment; harnessType: string } {
  if (
    input.requestedHarness !== 'codex' ||
    input.rolloutPercent <= 0 ||
    Boolean(input.modelOverride?.trim())
  ) {
    return { harnessType: input.requestedHarness }
  }

  const bucket = createHash('sha256').update(input.threadId).digest().readUInt32BE(0)
  const harnessType =
    input.rolloutPercent >= 100 || bucket < input.rolloutPercent * 2 ** 32 / 100
      ? 'nanocodex'
      : 'codex'
  return {
    assignment: {
      experiment: 'codex_nanocodex_ab',
      requestedHarness: input.requestedHarness,
      cohort: harnessType,
      rolloutPercent: input.rolloutPercent
    },
    harnessType
  }
}
