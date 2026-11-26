import { makeOpacityTable } from './color.ts'

// Fixed 2.32stable TVPApplyColorMap65: full-opacity Win32 dispatch uses
// colormap.nas; the opacity/HDA/removal variants retain the scalar kernels.
// Input alpha is the lossless public TFT encoding min(255, coverage * 4).
const coverage65 = (value: number) => value === 255 ? 64 : value >>> 2
const opacity65 = makeOpacityTable(64)

export function colorMap65Row(target: Uint8Array, offset: number, source: Uint8Array, from: number,
  length: number, face: number, opacity: number, holdAlpha: boolean): void {
  const full = opacity === 255
  for (let x = 0; x < length; x++, offset += 4, from += 4) {
    // The native alpha-on-alpha loop skips a completely transparent pair.
    // Its odd trailing pixel still follows the table, including RGB at alpha0.
    if (face === 0 && full && x + 1 < length && !(x & 1) &&
        source[from + 3] === 0 && source[from + 7] === 0) {
      x++; offset += 4; from += 4; continue
    }
    const coverage = coverage65(source[from + 3]!), destinationAlpha = target[offset + 3]!
    if (opacity < 0) {
      const strength = -opacity
      target[offset + 3] = strength === 255 ? (destinationAlpha * (64 - coverage)) >> 6
        : (destinationAlpha * (16384 - coverage * (strength + (strength > 127 ? 1 : 0)))) >> 14
      continue
    }
    const amount = full ? coverage : (coverage * opacity) >> 8
    if (face === 0) {
      const weight = opacity65[amount * 256 + destinationAlpha]!
      for (let c = 0; c < 3; c++) {
        const value = target[offset + c]!
        target[offset + c] = value + (((source[from + c]! - value) * weight) >> 8)
      }
      target[offset + 3] = 255 - Math.floor((255 - destinationAlpha) * (255 - Math.min(255, amount * 4)) / 255)
    } else if (face === 4) {
      const alpha = Math.min(255, amount * 4)
      for (let c = 0; c < 3; c++) {
        const value = target[offset + c]!, ink = (source[from + c]! * amount) >> 6
        target[offset + c] = Math.min(255, full
          ? value - ((value * amount) >> 6) + ink : ((value * (255 - alpha)) >> 8) + ink)
      }
      const out = full ? destinationAlpha - ((destinationAlpha * amount) >> 6) + amount * 4
        : destinationAlpha + alpha - ((destinationAlpha * alpha) >> 8)
      target[offset + 3] = full ? Math.min(255, out) : out - (out >> 8)
    } else {
      for (let c = 0; c < 3; c++) {
        const value = target[offset + c]!
        target[offset + c] = value + (((source[from + c]! - value) * amount) >> 6)
      }
      if (!holdAlpha) target[offset + 3] = full ? (destinationAlpha * (64 - amount)) >> 6 : 0
    }
  }
}
