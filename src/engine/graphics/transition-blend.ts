import { opacityTable } from './color.ts'

/** The switch kernels copy complete pixels outside the rule ramp. The
 * unconditional kernels use table weights even when they reach 0 or 255. */
export function universalOpacity(phase: number, vague: number, rule: number): number {
  const lower = phase - vague
  if (vague < 512) {
    if (rule >= phase) return -1
    if (rule < lower) return 256
  }
  if (rule < lower) return 255
  if (rule >= phase) return 0
  return 255 - Math.trunc(((rule - lower) * 255) / vague)
}

export function blendTransitionPixel(
  target: Uint8Array,
  at: number,
  before: Uint8Array,
  after: Uint8Array,
  opacity: number,
  face: number,
  kind: 'crossfade' | 'universal',
  switchRule: boolean,
): void {
  if (opacity === -1 || opacity === 256) {
    const source = opacity === -1 ? before : after
    target.set(source.subarray(at, at + 4), at)
    return
  }
  const oldAlpha = before[at + 3]!, newAlpha = after[at + 3]!
  let weight = opacity
  let mask = 0
  if (face === 0) {
    // TVPConstAlphaBlend_SD_d adjusts crossfade weights above the midpoint.
    // The universal table already supplies the weight its own kernel expects.
    if (kind === 'crossfade' && opacity > 127) opacity++
    const oldCoverage = (oldAlpha * (256 - opacity)) >> 8
    const newCoverage = (newAlpha * opacity) >> 8
    weight = opacityTable[newCoverage * 256 + oldCoverage]!
    mask = switchRule
      ? 255 - Math.floor(((255 - newCoverage) * (255 - oldCoverage)) / 255)
      : oldAlpha + (((newAlpha - oldAlpha) * opacity) >> 8)
  } else if (face === 4) {
    // Additive-alpha stores the emission channels directly, including at A=0.
    mask = oldAlpha + (((newAlpha - oldAlpha) * opacity) >> 8)
  }
  for (let channel = 0; channel < 3; channel++) {
    const old = before[at + channel]!
    target[at + channel] = old + (((after[at + channel]! - old) * weight) >> 8)
  }
  target[at + 3] = mask
}
