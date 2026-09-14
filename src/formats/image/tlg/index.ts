import type { DecodedImage } from '../../../engine/ports/graphics.ts'
import { BinaryReader } from '../../binary/reader.ts'
import { readTlg5 } from './tlg5.ts'
import { readTlg6 } from './tlg6.ts'

function signature(input: BinaryReader): string {
  return String.fromCharCode(...input.slice(11))
}

/** Strict UTF-8, independent of DOM codecs. Tags count bytes, not code points. */
function* utf8(bytes: Uint8Array): Generator<void, string> {
  let value = ''
  for (let at = 0, work = 0; at < bytes.length;) {
    const first = bytes[at++]!
    let point = first,
      extra = 0,
      min = 0
    if (first >= 0xc2 && first <= 0xdf) {
      extra = 1
      point &= 31
      min = 0x80
    } else if (first >= 0xe0 && first <= 0xef) {
      extra = 2
      point &= 15
      min = 0x800
    } else if (first >= 0xf0 && first <= 0xf4) {
      extra = 3
      point &= 7
      min = 0x10000
    } else if (first >= 0x80) throw new Error('Invalid UTF-8 in TLG tags')
    for (let i = 0; i < extra; i++) {
      const next = bytes[at++]
      if (next === undefined || (next & 0xc0) !== 0x80) throw new Error('Invalid UTF-8 in TLG tags')
      point = point * 64 + (next & 63)
    }
    if (point < min || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
      throw new Error('Invalid UTF-8 in TLG tags')
    value += String.fromCodePoint(point)
    if (++work >= 4096) {
      work = 0
      yield
    }
  }
  return value
}

function* tagString(input: BinaryReader): Generator<void, string> {
  let length = 0,
    digits = 0
  while (true) {
    const byte = input.u8()
    if (byte === 58 && digits) break
    if (byte < 48 || byte > 57 || ++digits > 7) throw new Error('Invalid TLG tag byte length')
    length = length * 10 + byte - 48
  }
  return yield* utf8(input.slice(length))
}

function* raw(input: BinaryReader, magic = signature(input)): Generator<void, DecodedImage> {
  const image =
    magic === 'TLG5.0\x00raw\x1a'
      ? yield* readTlg5(input)
      : magic === 'TLG6.0\x00raw\x1a'
        ? yield* readTlg6(input)
        : undefined
  if (!image) throw new Error('Unsupported TLG signature')
  if (input.remaining) throw new Error('Extra TLG image data')
  return image
}

function* read(bytes: Uint8Array): Generator<void, DecodedImage> {
  const input = new BinaryReader(bytes),
    magic = signature(input)
  if (magic !== 'TLG0.0\x00sds\x1a') return yield* raw(input, magic)
  const image = yield* raw(new BinaryReader(input.slice(input.u32())))
  let tagBytes = 0
  while (input.remaining) {
    const type = input.tag(),
      chunk = input.slice(input.u32())
    if (type === 'tags') {
      tagBytes += chunk.length
      if (tagBytes > 1024 * 1024) throw new Error('TLG tags exceed 1 MiB')
      const tags = new BinaryReader(chunk)
      while (tags.remaining) {
        const name = yield* tagString(tags)
        if (tags.u8() !== 61) throw new Error('Missing TLG tag equals sign')
        const value = yield* tagString(tags)
        if (tags.u8() !== 44) throw new Error('Missing TLG tag comma')
        const metadata = (image.metadata ??= new Map())
        metadata.set(name, value)
        if (metadata.size > 4096) throw new Error('TLG tags exceed 4096 entries')
        yield
      }
    }
    yield
  }
  return image
}

/** Unrecognized formats fall through to the host decoder; corrupt TLG does not. */
export function decodeTlg(bytes: Uint8Array): Generator<void, DecodedImage> | undefined {
  if (bytes[0] !== 84 || bytes[1] !== 76 || bytes[2] !== 71) return undefined
  return read(bytes)
}
