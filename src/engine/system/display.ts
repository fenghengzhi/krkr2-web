/** CSS pixels in the player's coordinate space, not host OS desktop pixels. */
export interface SystemDisplayMetrics {
  screenWidth: number
  screenHeight: number
  desktopLeft: number
  desktopTop: number
  desktopWidth: number
  desktopHeight: number
}

export interface SystemDisplayUpdate {
  revision: number
  metrics: SystemDisplayMetrics
}

export const systemDisplayProperties = [
  'screenWidth',
  'screenHeight',
  'desktopLeft',
  'desktopTop',
  'desktopWidth',
  'desktopHeight',
] as const satisfies readonly (keyof SystemDisplayMetrics)[]

/** A headless engine has no display. Browser players always supply real dimensions. */
const noDisplay: Readonly<SystemDisplayMetrics> = Object.freeze({
  screenWidth: 0,
  screenHeight: 0,
  desktopLeft: 0,
  desktopTop: 0,
  desktopWidth: 0,
  desktopHeight: 0,
})

export function copySystemDisplayMetrics(input?: SystemDisplayMetrics): SystemDisplayMetrics {
  if (input === undefined) return { ...noDisplay }
  if (!input || typeof input !== 'object') throw new Error('System display requires metrics')
  const result = {} as SystemDisplayMetrics
  for (const name of systemDisplayProperties) {
    // Read each value once so a caller's getter cannot alter the validated snapshot.
    const value = input[name],
      minimum = name === 'desktopLeft' || name === 'desktopTop' ? -0x80000000 : 0
    if (!Number.isInteger(value) || value < minimum || value > 0x7fffffff)
      throw new Error(
        `System display ${name} must be a ${minimum < 0 ? 'signed' : 'nonnegative'} 32-bit integer`,
      )
    result[name] = value
  }
  return result
}

export function copySystemDisplayUpdate(update: SystemDisplayUpdate): SystemDisplayUpdate {
  if (!update || typeof update !== 'object') throw new Error('System display requires an update')
  const revision = update.revision,
    metrics = update.metrics
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error('System display revision must be a nonnegative safe integer')
  if (metrics === undefined) throw new Error('System display update requires metrics')
  return { revision, metrics: copySystemDisplayMetrics(metrics) }
}

export class SystemDisplay {
  private metrics: SystemDisplayMetrics
  private revision = 0

  constructor(metrics?: SystemDisplayMetrics) {
    this.metrics = copySystemDisplayMetrics(metrics)
  }

  update(update: SystemDisplayUpdate): boolean {
    const next = copySystemDisplayUpdate(update)
    if (next.revision <= this.revision) return false
    this.metrics = next.metrics
    this.revision = next.revision
    return true
  }

  get(name: (typeof systemDisplayProperties)[number]): bigint {
    // Host numbers encode TJS real values; the original properties return integers.
    return BigInt(this.metrics[name])
  }
}
