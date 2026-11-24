import { decodeUtf8 } from '../../text/utf8.ts'
import type { DecodedImage } from '../../../engine/ports/graphics.ts'
import { BinaryReader } from '../../binary/reader.ts'
import { readTlg5 } from './tlg5.ts'
import { readTlg6 } from './tlg6.ts'
import { ImageDecodeError, type ImageDecodeSelection, type ImageDecodeProgress } from '../selection.ts'
import { ImageReadError } from '../read-error.ts'

function signature(input: BinaryReader): string {
  return String.fromCharCode(...input.slice(11))
}

function* tagString(input: BinaryReader, nativePart?: 'name' | 'value'): Generator<void, string> {
  let length = 0,
    digits = 0
  while (true) {
    const byte = input.u8()
    if (byte === 58 && (digits || nativePart !== undefined)) break
    if (byte < 48 || byte > 57) {
      if (nativePart) throw new ImageDecodeError('tlg', `Malformed TLG SDS tag structure, missing colon after ${nativePart} length`)
      throw new Error('Invalid TLG tag byte length')
    }
    if (++digits > 7) throw new Error('Invalid TLG tag byte length')
    length = length * 10 + byte - 48
  }
  return yield* decodeUtf8(input.slice(length), () => new Error('Invalid UTF-8 in TLG tags'))
}

function* raw(
  input: BinaryReader,
  magic = signature(input),
  mode?: ImageDecodeSelection['mode'],
  progress?: ImageDecodeProgress,
  exactEnd = mode === undefined,
): Generator<void, DecodedImage> {
  if (mode !== undefined) {
    if (magic !== 'TLG5.0\x00raw\x1a' && magic !== 'TLG6.0\x00raw\x1a')
      throw new ImageDecodeError('tlg', 'Invalid TLG header or unsupported TLG version.')
    if (mode !== 'normal')
      throw new ImageDecodeError('tlg', 'TLG cannot be used as universal transition rule, province(_p) or mask(_m) images.')
  }
  const image =
    magic === 'TLG5.0\x00raw\x1a'
      ? yield* readTlg5(input, mode !== undefined, progress)
      : magic === 'TLG6.0\x00raw\x1a'
        ? yield* readTlg6(input, mode !== undefined, progress)
        : undefined
  if (!image) throw new Error('Unsupported TLG signature')
  if (exactEnd && input.remaining) throw new Error('Extra TLG image data')
  return image
}

function* read(bytes: Uint8Array, mode?: ImageDecodeSelection['mode'], progress?: ImageDecodeProgress): Generator<void, DecodedImage> {
  const input = new BinaryReader(bytes, mode === undefined ? undefined : (offset, requested, actual) =>
    new ImageReadError('tlg', offset, requested, actual, 'Truncated or invalid binary data')),
    magic = signature(input)
  if (magic !== 'TLG0.0\x00sds\x1a') return yield* raw(input, magic, mode, progress)
  const rawLength = input.u32()
  // Native reads the enclosed signature/mode before it uses rawLength to
  // seek to metadata. A missing pixel body must not mask a mode rejection.
  if (mode !== undefined && mode !== 'normal') return yield* raw(input, undefined, mode, progress)
  if (mode !== undefined) {
    // rawLength is a later seek target, not a bound on the source passed to
    // the native raw handler. ReadBuffer failures must come from the actual
    // source, never from a synthetic subspan ending at rawLength.
    const rawStart = input.position, image = yield* raw(input, undefined, mode, progress, false)
    input.position = rawStart + rawLength
    return yield* metadata(input, image, true)
  }
  // A truncated SDS body must reach the raw decoder's real size/row boundary.
  // Do not reject its advertised full length before any raw bytes are read.
  const image = yield* raw(new BinaryReader(input.slice(progress ? Math.min(rawLength, input.remaining) : rawLength)), undefined, mode, progress)
  if (progress && rawLength > bytes.length - 15) throw new Error('Truncated or invalid binary data')
  return yield* metadata(input, image, false)
}

function* metadata(input: BinaryReader, image: DecodedImage, selected: boolean): Generator<void, DecodedImage> {
  let tagBytes = 0
  while (input.remaining) {
    // Native reads the next four-byte chunk name with Read, not ReadBuffer.
    // EOF and a final 1..3 bytes simply end SDS scanning.
    if (selected && input.remaining < 4) break
    const type = input.tag(), length = input.u32()
    if (selected && type !== 'tags') { input.position += length; yield; continue }
    const chunk = input.slice(length)
    if (type === 'tags') {
      tagBytes += chunk.length
      if (tagBytes > 1024 * 1024) throw new Error('TLG tags exceed 1 MiB')
      const tags = new BinaryReader(chunk)
      while (tags.remaining) {
        const name = yield* tagString(tags, selected ? 'name' : undefined)
        if (tags.u8() !== 61) {
          if (selected) throw new ImageDecodeError('tlg', 'Malformed TLG SDS tag structure, missing equals after name')
          throw new Error('Missing TLG tag equals sign')
        }
        const value = yield* tagString(tags, selected ? 'value' : undefined)
        if (tags.u8() !== 44) {
          if (selected) throw new ImageDecodeError('tlg', 'Malformed TLG SDS tag structure, missing comma after a tag')
          throw new Error('Missing TLG tag comma')
        }
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

/** The caller selected TLG; even a foreign signature stays in this handler. */
export function decodeSelectedTlg(bytes: Uint8Array, mode: ImageDecodeSelection['mode'], progress?: ImageDecodeProgress): Generator<void, DecodedImage> {
  return read(bytes, mode, progress)
}
