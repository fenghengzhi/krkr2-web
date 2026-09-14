export interface TlgCase {
  id: string
  version: number
  colors: number
  filter: number
  predictor: number
  width: number
  height: number
  data: Uint8Array
}

function vector(
  version: number,
  colors: number,
  width: number,
  height: number,
  pattern: string,
  filter = -1,
  predictor = -1,
): TlgCase {
  const data = new Uint8Array(width * height * 4)
  let seed = 0x31415926
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      for (let c = 0; c < 4; c++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0
        data[at + c] =
          pattern === 'solid'
            ? [202, 53, 17, 128][c]!
            : pattern === 'zero'
              ? 0
              : pattern === 'noise'
                ? seed >>> 24
                : (x * (c * 11 + 3) + y * (c * 23 + 7) + c * 67) & 255
      }
      if (colors === 1) data[at + 1] = data[at + 2] = data[at]!
      if (colors < 4) data[at + 3] = 255
    }
  return {
    id: `${version}-${colors}-${pattern}-${width}x${height}-${filter < 0 ? 'auto' : `${filter}-${predictor}`}`,
    version,
    colors,
    width,
    height,
    filter,
    predictor,
    data,
  }
}

export function* tlgCases(): Generator<TlgCase> {
  for (const version of [5, 6])
    for (const colors of version === 5 ? [3, 4] : [1, 3, 4])
      for (const [width, height] of [
        [1, 1],
        [1, 17],
        [17, 1],
        [7, 9],
        [8, 8],
        [9, 17],
        [17, 9],
        [67, 19],
        [129, 65],
      ])
        for (const pattern of ['zero', 'solid', 'gradient', 'noise'])
          yield vector(version, colors, width!, height!, pattern)
  for (const colors of [3, 4])
    for (let filter = 0; filter < 16; filter++)
      for (let predictor = 0; predictor < 2; predictor++)
        for (const [width, height] of [
          [17, 9],
          [9, 18],
        ])
          yield vector(6, colors, width!, height!, 'noise', filter, predictor)
  for (const predictor of [0, 1]) yield vector(6, 1, 17, 9, 'noise', 0, predictor)
}
