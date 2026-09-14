import type { ByteSource } from '../../engine/ports/storage.ts'
import { MAX_RESOURCE_BYTES } from '../../engine/ports/storage.ts'
import { BinaryWriter } from '../../formats/binary/writer.ts'

export class BlobSource implements ByteSource {
  readonly size: number
  constructor(private readonly blob: Blob) {
    this.size = blob.size
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > this.size ||
      length > this.size - offset
    )
      throw new Error('File read outside valid range')
    if (length > MAX_RESOURCE_BYTES) throw new Error('File read exceeds 64 MiB budget')
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer())
  }
}

export async function inflate(bytes: Uint8Array, expectedLength: number): Promise<Uint8Array> {
  if (expectedLength > MAX_RESOURCE_BYTES) throw new Error('Decompression exceeds 64 MiB budget')
  return inflateBounded(bytes, expectedLength)
}

export async function inflateRaw(
  bytes: Uint8Array,
  expectedLength: number,
  checkpoint?: () => Promise<void>,
): Promise<Uint8Array> {
  if (bytes.length > MAX_RESOURCE_BYTES || expectedLength > MAX_RESOURCE_BYTES)
    throw new Error('ZIP decompression exceeds 64 MiB budget')
  return inflateBounded(bytes, expectedLength, 'deflate-raw', checkpoint)
}

/** 16-bit RGBA PNG plus Adam7 scanline prefixes; output still becomes 8-bit RGBA. */
export async function inflateImage(bytes: Uint8Array, expectedLength: number): Promise<Uint8Array> {
  if (expectedLength > 128 * 1024 * 1024 + 8192)
    throw new Error('PNG decompression exceeds image budget')
  return inflateBounded(bytes, expectedLength)
}

export async function deflateImage(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length > 64 * 1024 * 1024 + 4096) throw new Error('PNG source exceeds image budget')
  const stream = new Blob([Uint8Array.from(bytes).buffer])
      .stream()
      .pipeThrough(new CompressionStream('deflate')),
    reader = stream.getReader(),
    output = new BinaryWriter()
  let ended = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        ended = true
        break
      }
      output.append(value)
    }
    return output.finish()
  } finally {
    // This reader and stream are private and never reused. EOF closes the
    // producer; errors must cancel it. Let the unreachable pair be collected:
    // releaseLock() can deadlock WebKit's reader GC visitor during allocation.
    if (!ended) await reader.cancel().catch(() => undefined)
  }
}

async function inflateBounded(
  bytes: Uint8Array,
  expectedLength: number,
  format: CompressionFormat = 'deflate',
  checkpoint?: () => Promise<void>,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0)
    throw new Error('Invalid decompression size')
  const stream = new Blob([Uint8Array.from(bytes).buffer])
    .stream()
    .pipeThrough(new DecompressionStream(format))
  const reader = stream.getReader()
  const output = new Uint8Array(expectedLength)
  let position = 0,
    ended = false
  try {
    while (true) {
      await checkpoint?.()
      const { value, done } = await reader.read()
      if (done) {
        ended = true
        break
      }
      if (value.length > expectedLength - position)
        throw new Error('Decompressed data exceeds declared size')
      output.set(value, position)
      position += value.length
    }
    if (position !== expectedLength) throw new Error('Decompressed size mismatch')
    return output
  } finally {
    // As above, no consumer needs to acquire this private stream afterwards.
    if (!ended) await reader.cancel().catch(() => undefined)
  }
}

export function decodeScript(bytes: Uint8Array): string | Uint8Array {
  if (bytes[0] === 0x54 && bytes[1] === 0x4a && bytes[2] === 0x53 && bytes[3] === 0x32) return bytes
  if (bytes[0] === 0xfe && bytes[1] === 0xfe)
    throw new Error('Encoded TJS text streams are not yet supported')
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('shift_jis', { fatal: true }).decode(bytes)
  }
}
