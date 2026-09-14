import type { Pixels, Rect } from '../../src/engine/ports/graphics.ts'
export interface ProcessingCase {
  operation: number
  source: Pixels
  clip: Rect
  rx: number
  ry: number
}
export function* processingCases(): Generator<ProcessingCase> {
  for (let operation = 0; operation < 3; operation++) {
    const source = { width: 256, height: 256, data: new Uint8Array(256 * 256 * 4) }
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++)
        source.data.set(
          operation === 2
            ? [x, y, (x * 17 + y * 29) & 255, (x + y) & 255]
            : [x, 255 - x, (x * 37) & 255, y],
          (y * 256 + x) * 4,
        )
    yield { operation, source, clip: { x: 0, y: 0, width: 256, height: 256 }, rx: 0, ry: 0 }
  }
  let seed = 0x5a17c932
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
  }
  for (const [width, height] of [
    [1, 1],
    [2, 3],
    [7, 5],
    [17, 19],
    [31, 29],
  ]) {
    const source: Pixels = {
      width: width!,
      height: height!,
      data: new Uint8Array(width! * height! * 4),
    }
    for (let at = 0; at < source.data.length; at += 4) {
      const p = random()
      source.data.set(
        [
          p & 255,
          (p >>> 8) & 255,
          (p >>> 16) & 255,
          at % 20 === 0 ? 0 : at % 12 === 0 ? 255 : p >>> 24,
        ],
        at,
      )
    }
    const clips = [
      { x: 0, y: 0, width: width!, height: height! },
      { x: Math.floor(width! / 2), y: Math.floor(height! / 2), width: 1, height: 1 },
      {
        x: 0,
        y: Math.min(1, height! - 1),
        width: Math.max(1, width! - 1),
        height: Math.max(1, height! - 1),
      },
    ]
    for (const [rx, ry] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 3],
      [-2, -1],
      [7, 7],
      [8, 8],
      [32, 0],
      [0, 32],
      [15, 15],
    ])
      for (const operation of [3, 4])
        for (const clip of clips) yield { operation, source, clip, rx: rx!, ry: ry! }
  }
}
