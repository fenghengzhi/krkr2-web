/** Native opaque transitions operate on RGB bytes, independently of both
 * source masks. -1/256 select a complete source pixel; 0..255 blend RGB and
 * clear the unused mask byte, as TVPConstAlphaBlend_SD/TVPUnivTransBlend do. */
export function opaqueUniversalOpacity(phase: number, vague: number, rule: number): number {
  const lower = phase - vague
  if (vague < 512) {
    if (rule >= phase) return -1
    if (rule < lower) return 256
  }
  if (rule < lower) return 255
  if (rule >= phase) return 0
  return 255 - Math.trunc(((rule - lower) * 255) / vague)
}

export function blendOpaqueTransitionPixel(
  target: Uint8Array,
  at: number,
  before: Uint8Array,
  after: Uint8Array,
  opacity: number,
): void {
  if (opacity === -1 || opacity === 256) {
    const source = opacity === -1 ? before : after
    target.set(source.subarray(at, at + 4), at)
    return
  }
  for (let channel = 0; channel < 3; channel++) {
    const old = before[at + channel]!
    target[at + channel] = old + (((after[at + channel]! - old) * opacity) >> 8)
  }
  target[at + 3] = 0
}
