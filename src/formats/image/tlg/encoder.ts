import type { Pixels } from '../../../engine/ports/graphics.ts'
import { BinaryWriter } from '../../binary/writer.ts'
import { encodeTlg5 } from './encode5.ts'
import { encodeTlg6 } from './encode6.ts'

function* utf8(text: string): Generator<void, Uint8Array> {
  const output = new BinaryWriter(1024 * 1024)
  let work = 0
  for (const character of text) {
    let code = character.codePointAt(0)!
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd
    if (code < 0x80) output.u8(code)
    else if (code < 0x800) {
      output.u8(0xc0 | (code >>> 6))
      output.u8(0x80 | (code & 63))
    } else if (code < 0x10000) {
      output.u8(0xe0 | (code >>> 12))
      output.u8(0x80 | ((code >>> 6) & 63))
      output.u8(0x80 | (code & 63))
    } else {
      output.u8(0xf0 | (code >>> 18))
      output.u8(0x80 | ((code >>> 12) & 63))
      output.u8(0x80 | ((code >>> 6) & 63))
      output.u8(0x80 | (code & 63))
    }
    if (++work >= 4096) {
      work = 0
      yield
    }
  }
  return output.finish()
}
export function* encodeTlg(
  image: Pixels,
  version: 5 | 6,
  alpha = true,
  metadata: ReadonlyMap<string, string> = new Map(),
): Generator<void, Uint8Array> {
  if (metadata.size > 4096) throw new Error('TLG tags exceed 4096 entries')
  const tags = new BinaryWriter(1024 * 1024)
  for (const [name, value] of metadata) {
    if (!name) continue
    const key = yield* utf8(name),
      text = yield* utf8(value)
    tags.ascii(key.length + ':')
    tags.append(key)
    tags.ascii('=' + text.length + ':')
    tags.append(text)
    tags.ascii(',')
    yield
  }
  const raw = yield* version === 5 ? encodeTlg5(image, alpha) : encodeTlg6(image, alpha)
  if (!tags.length) return raw
  const output = new BinaryWriter()
  output.ascii('TLG0.0\x00sds\x1a')
  output.u32(raw.length)
  output.append(raw)
  output.ascii('tags')
  output.u32(tags.length)
  output.append(tags.finish())
  return output.finish()
}
