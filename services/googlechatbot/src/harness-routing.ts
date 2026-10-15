import { STRATEGY_HARNESSES, validateStrategyOverrides, type HarnessOverrides } from './overrides'

export function parseEnabledHarnesses(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const harnesses = value.split(',').map(harness => harness.trim().toLowerCase())
  if (harnesses.some(harness => !STRATEGY_HARNESSES.has(harness))) {
    throw new Error('GOOGLECHATBOT_ENABLED_HARNESSES must contain known comma-separated harness types')
  }
  return [...new Set(harnesses)]
}

export function isHarnessEnabled(harness: string, enabledHarnesses?: readonly string[]): boolean {
  return enabledHarnesses === undefined || enabledHarnesses.includes(harness)
}

/** Apply the deployment gate after flags, sticky state, and space defaults resolve. */
export function resolveEnabledOverrides(
  overrides: HarnessOverrides,
  defaultHarness: string,
  enabledHarnesses?: readonly string[]
): HarnessOverrides {
  const selected = overrides.harnessType ?? defaultHarness
  const modelHarness = validateStrategyOverrides({ model: overrides.model }).harnessType ?? selected
  if (!isHarnessEnabled(selected, enabledHarnesses) || !isHarnessEnabled(modelHarness, enabledHarnesses)) {
    return { ...overrides, harnessType: defaultHarness, model: undefined, provider: undefined }
  }
  return overrides
}
