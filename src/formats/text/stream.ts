import { BinaryReader } from '../binary/reader.ts'
import { CompressionError } from '../binary/compression-error.ts'
import { parseStreamMode, parseTextWriterMode } from './mode.ts'
import { TextStreamError } from './errors.ts'

export interface TextCodecs {
  narrow(bytes: Uint8Array, encoding?: string): string
  utf8(text: string): Uint8Array
  inflate(bytes: Uint8Array, length: number): Promise<Uint8Array>
  deflate(bytes: Uint8Array): Promise<Uint8Array>
}
const MAX_TEXT_BYTES = 64 * 1024 * 1024

export function modeOffset(mode: string): number {
  return parseStreamMode(mode).offset
}
function decodeUtf16(bytes: Uint8Array, littleEndian = true): string {
  if (bytes.length % 2) throw new Error('Truncated UTF-16 text stream')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunk: number[] = []
  let result = ''
  for (let offset = 0; offset < bytes.length; offset += 2) {
    chunk.push(view.getUint16(offset, littleEndian))
    if (chunk.length === 4096) {
      result += String.fromCharCode(...chunk)
      chunk.length = 0
    }
  }
  return result + String.fromCharCode(...chunk)
}
function utf16(text: string): Uint8Array {
  if (text.length * 2 > MAX_TEXT_BYTES) throw new Error('Text stream exceeds 64 MiB budget')
  const bytes = new Uint8Array(text.length * 2),
    view = new DataView(bytes.buffer)
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true)
  return bytes
}

export async function decodeTextStream(
  input: Uint8Array,
  codecs: TextCodecs,
  mode = '',
  defaultEncoding?: string,
): Promise<string> {
  const parsedMode = parseStreamMode(mode)
  const offset = parsedMode.offset
  if (offset > input.length) throw new Error('Text stream offset exceeds file length')
  const bytes = input.subarray(offset)
  if (bytes.length > MAX_TEXT_BYTES) throw new Error('Text stream exceeds 64 MiB budget')
  if (bytes[0] === 0xfe && bytes[1] === 0xfe) {
    const cipher = bytes[2]
    if (cipher !== 0 && cipher !== 1 && cipher !== 2)
      throw new TextStreamError('unsupported-cipher', `Unsupported text stream encoding ${cipher}`)
    if (bytes[3] !== 0xff || bytes[4] !== 0xfe)
      throw new TextStreamError('unsupported-cipher', 'Invalid encoded text stream header')
    if (cipher === 2) {
      const reader = new BinaryReader(bytes.subarray(5))
      // Native Win32 unsigned long is 32 bits. Check its explicit cipher
      // rejection before applying the separate, smaller Web resource budget.
      const sizes = reader.slice(16), view = new DataView(sizes.buffer, sizes.byteOffset, sizes.byteLength),
        packed64 = view.getBigUint64(0, true), length64 = view.getBigUint64(8, true)
      if (packed64 > 0xffffffffn || length64 > 0xffffffffn)
        throw new TextStreamError('unsupported-cipher', 'Encoded text stream sizes exceed native uint32 range')
      const packed = Number(packed64), length = Number(length64)
      if (length > MAX_TEXT_BYTES) throw new Error('Decoded text stream exceeds budget')
      const compressed = reader.slice(packed)
      let decoded: Uint8Array
      try { decoded = await codecs.inflate(compressed, length) }
      catch (error) {
        if (error instanceof CompressionError && error.operation === 'inflate')
          throw new TextStreamError('unsupported-cipher', 'Encoded text stream decompression failed', { cause: error })
        throw error
      }
      if (decoded.length !== length)
        throw new TextStreamError('unsupported-cipher', 'Encoded text stream decompressed size mismatch')
      return decodeUtf16(decoded)
    }
    const data = Uint8Array.from(bytes.subarray(5))
    if (data.length % 2) throw new Error('Truncated encoded text stream')
    const view = new DataView(data.buffer)
    for (let i = 0; i < data.length; i += 2) {
      let ch = view.getUint16(i, true)
      if (cipher === 0) {
        if (ch >= 0x20) ch ^= ((ch & 0xfe) << 8) ^ 1
      } else ch = ((ch & 0xaaaa) >>> 1) | ((ch & 0x5555) << 1)
      view.setUint16(i, ch, true)
    }
    return decodeUtf16(data)
  }
  const utf32le = bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0
  const utf32be = bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff
  if (utf32le || utf32be) {
    if (bytes.length % 4) throw new Error('Truncated UTF-32 text stream')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let result = ''
    for (let i = 4; i < bytes.length; i += 4) {
      const cp = view.getUint32(i, utf32le)
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
        throw new Error('Invalid UTF-32 code point')
      result += String.fromCodePoint(cp)
    }
    return result
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes.subarray(2), false)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return codecs.narrow(bytes, 'utf-8')
  return codecs.narrow(bytes, /utf-?8/i.test(parsedMode.mode) ? 'utf-8' : defaultEncoding)
}

export async function encodeTextStream(
  text: string,
  codecs: TextCodecs,
  mode = '',
): Promise<Uint8Array> {
  const parsedMode = parseTextWriterMode(mode)
  if (parsedMode.encoding === 'utf8') return codecs.utf8(text)
  const data = utf16(text)
  if (parsedMode.encoding === 'compressed') {
    // CompressionStream provides the host default level; the parsed native
    // level is retained as metadata, not a promise of an identical bitstream.
    let packed: Uint8Array
    try { packed = await codecs.deflate(data) }
    catch (error) {
      if (error instanceof CompressionError && error.operation === 'deflate')
        throw new TextStreamError('compression-failed', 'Text stream compression failed', { cause: error })
      throw error
    }
    const output = new Uint8Array(21 + packed.length)
    output.set([0xfe, 0xfe, 2, 0xff, 0xfe])
    const view = new DataView(output.buffer)
    view.setBigUint64(5, BigInt(packed.length), true)
    view.setBigUint64(13, BigInt(data.length), true)
    output.set(packed, 21)
    return output
  }
  if (parsedMode.encoding === 'simple') {
    const view = new DataView(data.buffer)
    for (let i = 0; i < data.length; i += 2) {
      const ch = view.getUint16(i, true)
      view.setUint16(i, ((ch & 0xaaaa) >>> 1) | ((ch & 0x5555) << 1), true)
    }
    const output = new Uint8Array(5 + data.length)
    output.set([0xfe, 0xfe, 1, 0xff, 0xfe])
    output.set(data, 5)
    return output
  }
  const output = new Uint8Array(2 + data.length)
  output.set([0xff, 0xfe])
  output.set(data, 2)
  return output
}
