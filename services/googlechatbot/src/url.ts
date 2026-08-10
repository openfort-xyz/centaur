/** Strip trailing slashes without a `/+$/`-style regex, which CodeQL (rightly)
 * flags as quadratic-time on a long run of slashes. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end -= 1
  return value.slice(0, end)
}
