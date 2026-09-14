// TVP scalar colorRect arithmetic (tvpgl.cpp / tvpgl.h): 8-bit fixed-point
// factors and the original opacity table. This deliberately is not CSS blending.
export const opacityTable = new Uint8Array(65536)
for (let source = 0; source < 256; source++)
  for (let destination = 0; destination < 256; destination++) {
    let weight = 255
    if (destination) {
      const a = Math.fround(destination / 255),
        b = Math.fround(source / 255)
      let c = Math.fround(b / a)
      c = Math.fround(c / (1 - b + c))
      weight = Math.min(255, Math.trunc(Math.fround(c * 255)))
    }
    opacityTable[source * 256 + destination] = weight
  }
export function blendColor(
  data: Uint8Array,
  at: number,
  color: readonly number[],
  opacity: number,
  face: number,
): void {
  const amount = Math.max(0, Math.min(255, Math.trunc(Math.abs(opacity)))),
    alpha = data[at + 3]!
  if (!amount) return
  if (opacity < 0) {
    if (face !== 0) throw new Error('Negative opacity requires dfAlpha')
    data[at + 3] = (alpha * (255 - amount)) >> 8
    return
  }
  if (amount === 255) {
    for (let c = 0; c < 3; c++) data[at + c] = color[c]!
    if (face !== 1) data[at + 3] = 255
    return
  }
  if (face === 4) {
    let next = alpha + amount - ((alpha * amount) >> 8)
    next -= next >> 8
    data[at + 3] = next
    for (let c = 0; c < 3; c++)
      data[at + c] = Math.min(
        255,
        ((color[c]! * amount) >> 8) + ((data[at + c]! * (255 - amount)) >> 8),
      )
  } else {
    const weight = face === 1 ? amount : opacityTable[amount * 256 + alpha]!
    for (let c = 0; c < 3; c++)
      data[at + c] = data[at + c]! + (((color[c]! - data[at + c]!) * weight) >> 8)
    if (face !== 1) data[at + 3] = 255 - (((255 - alpha) * (255 - amount)) >> 8)
  }
}
