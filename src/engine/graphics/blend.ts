import { opacityTable } from './color.ts'

// TVP scalar arithmetic, including its /256 rounding and Photoshop variants.
// See docs/decisions/008-pixel-blending.md for reference scope and exceptions.
export const imageTypes = new Set([
  1,
  2,
  3,
  4,
  5,
  8,
  9,
  10,
  11,
  12,
  ...Array.from({ length: 16 }, (_, i) => i + 13),
])
export const usesAlpha = (type: number): boolean =>
  type === 2 || type === 12 || (type >= 13 && type <= 28)
export const autoFace = (type: number): number => (type === 12 ? 4 : usesAlpha(type) ? 0 : 1)
export const neutralColor = (type: number): number =>
  [18, 19, 20].includes(type)
    ? 0x00808080
    : [3, 8, 10, 11, 12, 13, 14, 17, 21, 22, 24, 26, 27, 28].includes(type)
      ? 0
      : 0x00ffffff
export const blendOpacity = (value: number): number => Math.max(0, Math.min(255, Math.trunc(value)))
export function validateBlend(mode: number, face: number): void {
  if (!imageTypes.has(mode)) throw new Error(`Invalid image operation mode: ${mode}`)
  if (![0, 1, 2, 3, 4].includes(face)) throw new Error('Invalid drawing face')
  // Basic/Photoshop operations select the RGB kernel independently of face.
  // Only the copy/alpha family chooses a destination-alpha representation.
  if ([1, 2, 12].includes(mode) && face !== 0 && face !== 1 && face !== 4)
    throw new Error('Copy and alpha operations require dfAlpha, dfOpaque or dfAddAlpha')
}
const mix = (d: number, s: number, a: number) => d + (((s - d) * a) >> 8)
const union = (d: number, s: number) => 255 - Math.floor(((255 - d) * (255 - s)) / 255)
const addAlpha = (d: number, s: number) => {
  const a = d + s - ((d * s) >> 8)
  return a - (a >> 8)
}
const dodge = (d: number, s: number) => (255 - s <= d ? 255 : Math.floor((d * 255) / (255 - s)))
let softLight: Uint8Array | undefined
function soft(d: number, s: number): number {
  if (!softLight) {
    softLight = new Uint8Array(65536)
    for (let source = 0; source < 256; source++)
      for (let dest = 0; dest < 256; dest++)
        softLight[source * 256 + dest] = Math.floor(
          Math.pow(dest / 255, source >= 128 ? 128 / source : (1 - source / 255) / 0.5) * 255,
        )
  }
  return softLight[s * 256 + d]!
}

/** Operate on raw RGBA bytes. Callers validate mode/face and clamp opacity once
 * per rectangle. Source may alias destination only when offsets are identical. */
export function blendPixel(
  target: Uint8Array,
  at: number,
  source: Uint8Array,
  from: number,
  mode: number,
  face: number,
  opacity: number,
  hold: boolean,
): void {
  if (!opacity) return
  const da = target[at + 3]!,
    sa = source[from + 3]!,
    full = opacity === 255
  let alpha = full ? sa : (sa * opacity) >> 8
  if (
    (mode === 1 && full) ||
    (mode === 2 && face === 0 && full && (sa === 255 || (da === 0 && sa !== 0)))
  ) {
    for (let c = 0; c < 3; c++) target[at + c] = source[from + c]!
    target[at + 3] = mode === 1 ? (face === 1 ? (hold ? da : sa) : 255) : sa
    return
  }
  if (mode === 2 && face === 0 && full && !sa) return
  if (mode === 1 || mode === 2) {
    if (mode === 1) alpha = opacity
    if (face === 4) {
      for (let c = 0; c < 3; c++)
        target[at + c] = Math.min(
          255,
          (mode === 1 ? source[from + c]! : (source[from + c]! * alpha) >> 8) +
            ((target[at + c]! * (255 - alpha)) >> 8),
        )
      target[at + 3] = addAlpha(da, alpha)
    } else {
      const weight = face === 0 ? opacityTable[alpha * 256 + da]! : alpha
      for (let c = 0; c < 3; c++) target[at + c] = mix(target[at + c]!, source[from + c]!, weight)
      target[at + 3] = face === 0 ? union(da, alpha) : hold || (mode === 2 && full) ? da : 0
    }
    return
  }
  if (mode === 12) {
    const next = addAlpha(da, alpha)
    for (let c = 0; c < 3; c++) {
      const s = full ? source[from + c]! : (source[from + c]! * opacity) >> 8
      if (face === 0) {
        // Portable TVP has no additive-on-straight kernel. Compose in premul
        // space then convert; straight storage cannot retain excess emission.
        const premul = s + (((target[at + c]! * da) / 255) * (255 - alpha)) / 255
        target[at + c] = next ? Math.min(255, Math.round((premul * 255) / next)) : 0
      } else target[at + c] = Math.min(255, s + ((target[at + c]! * (255 - alpha)) >> 8))
    }
    target[at + 3] = face === 1 ? (hold ? da : alpha) : next
    return
  }
  let outAlpha = hold ? da : 0
  if (!hold) {
    if (mode === 3) outAlpha = full ? Math.min(255, da + sa) : da
    if (mode === 4) outAlpha = full ? Math.max(0, da + sa - 255) : da
    if (mode === 9 && full) outAlpha = Math.min(da, sa)
    if (mode === 10 && full) outAlpha = Math.max(da, sa)
    if (mode === 11 && full) outAlpha = 255
    if (mode === 27) outAlpha = da
  }
  for (let c = 0; c < 3; c++) {
    let d = target[at + c]!,
      s = source[from + c]!,
      value = d
    switch (mode) {
      case 3:
        value = Math.min(255, d + (full ? s : (s * opacity) >> 8))
        break
      case 4:
        value = Math.max(0, d - (full ? 255 - s : ((255 - s) * opacity) >> 8))
        break
      case 5:
        value = (d * (full ? s : 255 - (((255 - s) * opacity) >> 8))) >> 8
        break
      case 8: {
        const divisor = 255 - (full ? s : (s * opacity) >> 8)
        value = Math.min(255, (d * (divisor ? Math.floor(65536 / divisor) : 65536)) >> 8)
        break
      }
      case 9:
        value = full ? Math.min(d, s) : mix(d, Math.min(d, s), opacity)
        break
      case 10:
        value = full ? Math.max(d, s) : mix(d, Math.max(d, s), opacity)
        break
      case 11: {
        const product = ((255 - d) * (255 - (full ? s : (s * opacity) >> 8))) >> 8
        value = full || hold ? 255 - product : product
        break
      }
      case 13:
        value = mix(d, s, alpha)
        break
      case 14:
        value = mix(d, Math.min(255, d + s), alpha)
        break
      case 15:
        value = mix(d, Math.max(0, d + s - 255), alpha)
        break
      case 16:
        value = mix(d, (d * s) >> 8, alpha)
        break
      case 17:
        value = d + (((s - ((d * s) >> 8)) * alpha) >> 8)
        break
      case 18: {
        const product = Math.floor((d * s * 2) / 255)
        value = mix(d, d < 128 ? product : (s + d) * 2 - 255 - product, alpha)
        break
      }
      case 19: {
        const product = Math.floor((d * s * 2) / 255)
        value = mix(d, s < 128 ? product : (s + d) * 2 - 255 - product, alpha)
        break
      }
      case 20:
        value = mix(d, soft(d, s), alpha)
        break
      case 21:
        value = mix(d, dodge(d, s), alpha)
        break
      case 22:
        value = dodge(d, (s * alpha) >> 8)
        break
      case 23:
        value = mix(d, s <= 255 - d ? 0 : 255 - Math.floor(((255 - d) * 255) / s), alpha)
        break
      case 24:
        value = mix(d, Math.max(d, s), alpha)
        break
      case 25:
        value = mix(d, Math.min(d, s), alpha)
        break
      case 26:
        value = mix(d, Math.abs(d - s), alpha)
        break
      case 27:
        value = Math.abs(d - ((s * alpha) >> 8))
        break
      case 28:
        value = d + (((s - ((d * s) >> 7)) * alpha) >> 8)
        break
    }
    target[at + c] = value
  }
  target[at + 3] = outAlpha
}
