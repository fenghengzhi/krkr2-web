// Fixed edge cases followed by reproducible, independently colored pixels.
// Packed little-endian RGBA: R | G << 8 | B << 16 | A << 24.
export function blendVectors(): Array<[number, number]> {
  const values: Array<[number, number]> = [
    [0, 0],
    [0x00ffffff, 0],
    [0, 0xffffffff],
    [0xffffffff, 0],
    [0xffffffff, 0xffffffff],
    [0xff000000, 0xffffffff],
    [0xffffffff, 0xff000000],
    [0x01020304, 0x01020304],
    [0x807f0080, 0x7f80ff7f],
    [0x007fff00, 0x008000ff],
    [0x017f80ff, 0xfeff8000],
    [0xfe00807f, 0x01017f80],
    [0x7fffffff, 0x7fffffff],
    [0x80ffffff, 0x80000000],
    [0xff7e7f80, 0x00807f7e],
    [0x007e7f80, 0xff807f7e],
  ]
  let seed = 0x9e3779b9
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
  }
  while (values.length < 64) values.push([random(), random()])
  return values
}
export function* blendCases() {
  // Keep the reference domain independent of the implementation's mode list.
  for (const mode of [
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
    for (const face of [0, 1, 2, 3, 4]) {
      if ([1, 2, 12].includes(mode) && (face === 2 || face === 3)) continue
      if (mode === 12 && face === 0) continue
      for (const hold of [false, true])
        for (const opacity of [0, 1, 63, 127, 254, 255])
          for (const [destination, source] of blendVectors())
            yield { mode, face, hold, opacity, destination, source }
    }
}
