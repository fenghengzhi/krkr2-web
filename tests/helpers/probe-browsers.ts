const names = ['chromium', 'firefox', 'webkit'] as const

/** A hosted job selects its own browser; unfiltered probes retain all three. */
export function probeBrowsers(): (typeof names)[number][] {
  const requested = process.env.KRKR_PROBE_BROWSER
  if (!requested) return [...names]
  const name = names.find((name) => name === requested)
  if (!name) throw new Error(`Unknown probe browser: ${requested}`)
  return [name]
}
