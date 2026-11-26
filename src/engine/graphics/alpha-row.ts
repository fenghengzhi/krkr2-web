/** Stock 2.32's MMX/EMMX TVPAlphaBlend and TVPAlphaBlend_o. Bitmap scanlines
 * start on 16-byte boundaries, so their logical x determines pair alignment.
 * The non-HDA kernels interpolate all four bytes, including the stored mask. */
export function blendAlphaRow(
  target: Uint8Array, at: number, source: Uint8Array, from: number,
  x: number, width: number, opacity: number,
): void {
  const full = opacity === 255, tail = full ? 4 : 2
  function pixel(weight: number) {
    for (let c = 0; c < 4; c++) {
      const d = target[at + c]!
      target[at + c] = d + (((source[from + c]! - d) * weight) >> 8)
    }
    at += 4
    from += 4
  }
  function single() {
    const alpha = source[from + 3]!
    if (full) pixel(alpha === 255 ? 256 : alpha)
    else {
      // The scalar prefix and tail multiply the whole unsigned ARGB word.
      const word = alpha * 0x1000000 + source[from]! * 0x10000 + source[from + 1]! * 0x100 + source[from + 2]!
      pixel(Math.floor((word * opacity) / 0x100000000))
    }
  }
  if (width > tail && (x & 1)) { single(); width-- }
  while (width > tail) {
    const a = source[from + 3]!, b = source[from + 7]!
    if (full) {
      const opaquePair = a === 255 && b === 255
      pixel(opaquePair ? 256 : a)
      pixel(opaquePair ? 256 : b)
    } else {
      pixel((a * opacity) >> 8)
      pixel((b * opacity) >> 8)
    }
    width -= 2
  }
  while (width-- > 0) single()
}
