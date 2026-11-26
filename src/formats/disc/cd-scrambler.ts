// ECMA-130 §15 and Annex B. The 15-bit register starts at 1 after the
// 12 sync bytes of each data sector. Bits are transmitted least significant first.
const mask = new Uint8Array(2352)
let register = 1
for (let byte = 12; byte < mask.length; byte++) {
  mask[byte] = register & 255
  for (let bit = 0; bit < 8; bit++)
    register = (register >>> 1) | (((register ^ (register >>> 1)) & 1) << 14)
}

/** An aligned run may end in a partial sector when only its header is needed.
 * Sources may share their backing bytes between a data and an audio reader. */
export function descrambleCdSectors(raw: Uint8Array): Uint8Array {
  const decoded = Uint8Array.from(raw)
  for (let start = 0; start < decoded.length; start += mask.length) {
    const length = Math.min(mask.length, decoded.length - start)
    for (let i = 12; i < length; i++) decoded[start + i] = raw[start + i]! ^ mask[i]!
  }
  return decoded
}
