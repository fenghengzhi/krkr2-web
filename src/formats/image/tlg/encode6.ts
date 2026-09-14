import type { Pixels } from '../../../engine/ports/graphics.ts'
import { BinaryWriter } from '../../binary/writer.ts'
import { dimensions } from './size.ts'
import { SlideEncoder } from './slide-encoder.ts'
import { BitOutput, writeGolomb, golombCost } from './golomb-encoder.ts'

function predict(a: number, b: number, c: number, average: boolean): number {
  if (average) return (a + b + 1) >>> 1
  const min = Math.min(a, b),
    max = Math.max(a, b)
  return c >= max ? min : c < min ? max : a + b - c
}
function filter(source: Uint8Array[], target: Uint8Array[], code: number): void {
  for (let i = 0; i < source[0]!.length; i++) {
    let b = source[0]![i]!,
      g = source[1]![i]!,
      r = source[2]![i]!
    switch (code) {
      case 1:
        b -= g
        r -= g
        break
      case 2:
        r -= g
        g -= b
        break
      case 3:
        b -= g
        g -= r
        break
      case 4:
        r -= g
        g -= b
        b -= r
        break
      case 5:
        g -= b
        b -= r
        break
      case 6:
        b -= g
        break
      case 7:
        g -= b
        break
      case 8:
        r -= g
        break
      case 9:
        b -= g
        g -= r
        r -= b
        break
      case 10:
        b -= r
        g -= r
        break
      case 11:
        g -= b
        r -= b
        break
      case 12:
        g -= r
        r -= b
        break
      case 13:
        g -= r
        r -= b
        b -= g
        break
      case 14:
        r -= b
        b -= g
        g -= r
        break
      case 15:
        g -= b * 2
        r -= b * 2
        break
    }
    target[0]![i] = b
    target[1]![i] = g
    target[2]![i] = r
    if (source[3]) target[3]![i] = source[3]![i]!
  }
}

export function* encodeTlg6(image: Pixels, alpha = true): Generator<void, Uint8Array> {
  const { width, height, data } = image
  dimensions(width, height)
  if (data.length !== width * height * 4) throw new Error('Invalid TLG source pixels')
  const colors = alpha ? 4 : 3,
    blocks = Math.ceil(width / 8),
    filters = new Uint8Array(blocks * Math.ceil(height / 8)),
    body = new BinaryWriter()
  let maxBits = 0
  for (let base = 0; base < height; base += 8) {
    const rows = Math.min(8, height - base),
      planes = Array.from({ length: colors }, () => new Uint8Array(width * rows))
    for (let bx = 0; bx < blocks; bx++) {
      const startX = bx * 8,
        columns = Math.min(8, width - startX),
        size = columns * rows,
        scratch = Array.from({ length: colors }, () => new Uint8Array(size)),
        best = Array.from({ length: colors }, () => new Uint8Array(size))
      let bestCost = Infinity,
        bestCode = 0
      for (let average = 0; average < 2; average++) {
        const residual = Array.from({ length: colors }, () => new Uint8Array(size))
        for (let row = 0; row < rows; row++)
          for (let column = 0; column < columns; column++) {
            const y = base + row,
              x = startX + column,
              at = (y * width + x) * 4,
              index =
                (bx & 1 ? rows - 1 - row : row) * columns + (y & 1 ? columns - 1 - column : column)
            for (let c = 0; c < colors; c++) {
              const channel = c < 3 ? 2 - c : 3,
                left = x ? data[at - 4 + channel]! : 0,
                above = y ? data[at - width * 4 + channel]! : 0,
                diagonal = x && y ? data[at - width * 4 - 4 + channel]! : 0
              residual[c]![index] = data[at + channel]! - predict(left, above, diagonal, !!average)
            }
          }
        for (let code = 0; code < 16; code++) {
          filter(residual, scratch, code)
          const cost = scratch.reduce((sum, plane) => sum + golombCost(plane), 0)
          if (cost < bestCost) {
            bestCost = cost
            bestCode = code * 2 + average
            for (let c = 0; c < colors; c++) best[c]!.set(scratch[c]!)
          }
          yield
        }
      }
      filters[(base / 8) * blocks + bx] = bestCode
      for (let c = 0; c < colors; c++) planes[c]!.set(best[c]!, startX * rows)
    }
    for (const plane of planes) {
      const bits = new BitOutput()
      yield* writeGolomb(plane, bits)
      maxBits = Math.max(maxBits, bits.length)
      body.u32(bits.length)
      body.append(bits.finish())
    }
  }
  const compressed = yield* new SlideEncoder(true).encode(filters, false),
    output = new BinaryWriter()
  output.ascii('TLG6.0\x00raw\x1a')
  output.u8(colors)
  output.u8(0)
  output.u8(0)
  output.u8(0)
  output.u32(width)
  output.u32(height)
  output.u32(maxBits)
  output.u32(compressed.bytes.length)
  output.append(compressed.bytes)
  output.append(body.finish())
  return output.finish()
}
