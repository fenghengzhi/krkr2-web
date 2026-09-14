import type { Pixels } from '../../../engine/ports/graphics.ts'
import { BinaryReader } from '../../binary/reader.ts'
import { SlideDecoder } from './slide.ts'
import { dimensions } from './size.ts'

export function* readTlg5(input: BinaryReader): Generator<void, Pixels> {
  const colors = input.u8(),
    width = input.u32(),
    height = input.u32(),
    blockHeight = input.u32()
  dimensions(width, height)
  if (colors !== 3 && colors !== 4) throw new Error('Unsupported TLG5 color count')
  if (!blockHeight) throw new Error('Invalid TLG5 block height')
  const count = Math.ceil(height / blockHeight),
    sizes: number[] = []
  for (let i = 0; i < count; i++) sizes.push(input.u32())
  const data = new Uint8Array(width * height * 4),
    slide = new SlideDecoder()
  for (let yBase = 0, block = 0; yBase < height; yBase += blockHeight, block++) {
    const rows = Math.min(blockHeight, height - yBase),
      size = width * rows,
      start = input.position,
      planes: Uint8Array[] = []
    for (let c = 0; c < colors; c++) {
      const flag = input.u8(),
        bytes = input.slice(input.u32())
      if (flag === 0) planes.push(yield* slide.decode(bytes, size))
      else if (flag === 1 && bytes.length === size) planes.push(bytes)
      else throw new Error('Invalid TLG5 plane encoding or length')
    }
    if (input.position - start !== sizes[block]) throw new Error('Invalid TLG5 block size')
    for (let row = 0; row < rows; row++) {
      let red = 0,
        green = 0,
        blue = 0,
        alpha = 0
      const y = yBase + row
      for (let x = 0; x < width; x++) {
        const source = row * width + x,
          at = (y * width + x) * 4,
          above = at - width * 4,
          g = planes[1]![source]!
        blue = (blue + planes[0]![source]! + g) & 255
        green = (green + g) & 255
        red = (red + planes[2]![source]! + g) & 255
        data[at] = red + (y ? data[above]! : 0)
        data[at + 1] = green + (y ? data[above + 1]! : 0)
        data[at + 2] = blue + (y ? data[above + 2]! : 0)
        if (colors === 4) {
          alpha = (alpha + planes[3]![source]!) & 255
          data[at + 3] = alpha + (y ? data[above + 3]! : 0)
        } else data[at + 3] = 255
      }
      yield
    }
  }
  return { width, height, data }
}
