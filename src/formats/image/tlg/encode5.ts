import type { Pixels } from '../../../engine/ports/graphics.ts'
import { BinaryWriter } from '../../binary/writer.ts'
import { dimensions } from './size.ts'
import { SlideEncoder } from './slide-encoder.ts'

export function* encodeTlg5(image: Pixels, alpha = true): Generator<void, Uint8Array> {
  const { width, height, data } = image
  dimensions(width, height)
  if (data.length !== width * height * 4) throw new Error('Invalid TLG source pixels')
  const output = new BinaryWriter(),
    colors = alpha ? 4 : 3,
    blocks = Math.ceil(height / 4),
    slide = new SlideEncoder()
  output.ascii('TLG5.0\x00raw\x1a')
  output.u8(colors)
  output.u32(width)
  output.u32(height)
  output.u32(4)
  for (let i = 0; i < blocks; i++) output.u32(0)
  for (let base = 0; base < height; base += 4) {
    const rows = Math.min(4, height - base),
      planes = Array.from({ length: colors }, () => new Uint8Array(width * rows)),
      blockStart = output.length
    for (let row = 0; row < rows; row++) {
      const previous = new Int16Array(4),
        values = new Int16Array(4),
        y = base + row
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4,
          source = row * width + x
        for (let c = 0; c < colors; c++) {
          const channel = c < 3 ? 2 - c : 3,
            current = data[at + channel]! - (y ? data[at - width * 4 + channel]! : 0)
          values[c] = current - previous[c]!
          previous[c] = current
        }
        planes[0]![source] = values[0]! - values[1]!
        planes[1]![source] = values[1]!
        planes[2]![source] = values[2]! - values[1]!
        if (alpha) planes[3]![source] = values[3]!
      }
      yield
    }
    for (const plane of planes) {
      const encoded = yield* slide.encode(plane)
      output.u8(encoded.compressed ? 0 : 1)
      output.u32(encoded.bytes.length)
      output.append(encoded.bytes)
    }
    output.patch32(24 + (base / 4) * 4, output.length - blockStart)
  }
  return output.finish()
}
