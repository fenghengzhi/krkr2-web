import type { DecodedImage } from '../../../engine/ports/graphics.ts'
import { BinaryReader } from '../../binary/reader.ts'
import { SlideDecoder } from './slide.ts'
import { decodeGolomb } from './golomb.ts'
import { dimensions } from './size.ts'
import { ImageDecodeError, type ImageDecodeProgress } from '../selection.ts'

function predict(left: number, above: number, diagonal: number, average: boolean): number {
  if (average) return (left + above + 1) >>> 1
  const min = Math.min(left, above),
    max = Math.max(left, above)
  return diagonal >= max ? min : diagonal < min ? max : left + above - diagonal
}

export function* readTlg6(input: BinaryReader, selected = false, progress?: ImageDecodeProgress): Generator<void, DecodedImage> {
  const colors = input.u8()
  if (selected) {
    // The original reads the four-byte mark before checking any field.
    const flags = input.u8(), type = input.u8(), table = input.u8()
    if (colors !== 1 && colors !== 3 && colors !== 4)
      throw new ImageDecodeError('tlg', `Unsupported color count : ${colors}`)
    if (flags) throw new ImageDecodeError('tlg', 'Data flag must be 0 (any flags are not yet supported)')
    // Preserve the original reason's buf[1], even for the buf[2] condition.
    if (type) throw new ImageDecodeError('tlg', `Unsupported color type : ${flags}`)
    if (table) throw new ImageDecodeError('tlg', 'External golomb bit length table is not yet supported.')
  } else {
    if (colors !== 1 && colors !== 3 && colors !== 4) throw new Error('Unsupported TLG6 color count')
    if (input.u8() || input.u8() || input.u8()) throw new Error('Unsupported TLG6 flags or table')
  }
  const width = input.u32(),
    height = input.u32(),
    maxBits = input.u32()
  dimensions(width, height)
  progress?.size(width, height)
  const blocks = Math.ceil(width / 8),
    filters = yield* new SlideDecoder(true).decode(
      input.slice(input.u32()),
      blocks * Math.ceil(height / 8),
    ),
    data = new Uint8Array(width * height * 4)
  if (filters.some((value) => value > 31 || (colors === 1 && value > 1)))
    throw new Error('Unsupported TLG6 color filter')
  for (let baseY = 0; baseY < height; baseY += 8) {
    const rows = Math.min(8, height - baseY),
      planes: Uint8Array[] = []
    for (let c = 0; c < colors; c++) {
      const bits = input.u32()
      if (selected) {
        const count = bits & 0x3fffffff
        if (count > maxBits) throw new Error('TLG6 bit length exceeds header maximum')
        const payload = input.slice(Math.ceil(count / 8))
        // Native's ReadBuffer precedes its method switch: underflow retains
        // the stream error rather than becoming an entropy-format message.
        if (bits >>> 30) throw new ImageDecodeError('tlg', 'Unsupported entropy coding method')
        planes.push(yield* decodeGolomb(payload, count, width * rows))
        continue
      }
      if (bits >>> 30) {
        throw new Error('Unsupported TLG6 entropy method')
      }
      if (bits > maxBits) throw new Error('TLG6 bit length exceeds header maximum')
      planes.push(yield* decodeGolomb(input.slice(Math.ceil(bits / 8)), bits, width * rows))
    }
    for (let row = 0; row < rows; row++) {
      const y = baseY + row
      for (let bx = 0; bx < blocks; bx++) {
        const startX = bx * 8,
          columns = Math.min(8, width - startX),
          storedRow = bx & 1 ? rows - 1 - row : row,
          code = filters[(baseY / 8) * blocks + bx]!,
          average = !!(code & 1)
        for (let column = 0; column < columns; column++) {
          const x = startX + column,
            index = startX * rows + storedRow * columns + (y & 1 ? columns - 1 - column : column),
            at = (y * width + x) * 4,
            above = at - width * 4,
            b = planes[0]![index]!,
            g = planes[1]?.[index] ?? 0,
            r = planes[2]?.[index] ?? 0
          let blue = b,
            green = g,
            red = r
          switch (code >>> 1) {
            case 1:
              blue = b + g
              red = r + g
              break
            case 2:
              green = g + b
              red = r + b + g
              break
            case 3:
              blue = b + r + g
              green = g + r
              break
            case 4:
              blue = b + r
              green = g + b + r
              red = r + b + r + g
              break
            case 5:
              blue = b + r
              green = g + b + r
              break
            case 6:
              blue = b + g
              break
            case 7:
              green = g + b
              break
            case 8:
              red = r + g
              break
            case 9:
              blue = b + g + r + b
              green = g + r + b
              red = r + b
              break
            case 10:
              blue = b + r
              green = g + r
              break
            case 11:
              green = g + b
              red = r + b
              break
            case 12:
              green = g + r + b
              red = r + b
              break
            case 13:
              blue = b + g
              green = g + r + b + g
              red = r + b + g
              break
            case 14:
              blue = b + g + r
              green = g + r
              red = r + b + g + r
              break
            case 15:
              green = g + b * 2
              red = r + b * 2
              break
          }
          if (colors === 1) red = green = blue
          for (let c = 0; c < colors; c++) {
            // Plane order is BGR(A); preserve raw channels in engine RGBA order.
            const channel = colors === 1 ? 0 : c < 3 ? 2 - c : 3,
              residual = c === 0 ? blue : c === 1 ? green : c === 2 ? red : planes[3]![index]!
            data[at + channel] =
              residual +
              predict(
                x ? data[at - 4 + channel]! : 0,
                y ? data[above + channel]! : 0,
                x && y ? data[above - 4 + channel]! : 0,
                average,
              )
          }
          if (colors === 1) data[at + 1] = data[at + 2] = data[at]!
          if (colors < 4) data[at + 3] = 255
        }
      }
      progress?.row(y, data.subarray(y * width * 4, (y + 1) * width * 4))
      yield
    }
  }
  return { width, height, data, ...(colors === 1 ? { grayscale: true } : {}) }
}
