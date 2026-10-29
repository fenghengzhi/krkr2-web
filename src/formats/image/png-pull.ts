import { crc32 } from '../binary/crc32.ts'
import { ImageDecodeError } from './selection.ts'
import type { ImageInflater } from '../../engine/ports/image-inflater.ts'

/** A native ReadBuffer short read is distinct from a libpng codec error.
 * TJSReadError holder mapping is still separate from this portable boundary. */
export class PngStreamReadError extends Error {
  constructor(readonly offset: number, readonly requested: number, readonly actual: number) {
    super('PNG stream short read')
    this.name = 'PngStreamReadError'
  }
}

/** Encoded-byte cursor and the original 8192-byte zlib input window. CRC is
 * checked when libpng consumes the end of an IDAT, never as a file preflight. */
export class PngPull {
  position: number
  private remaining: number
  private checksum = 0
  private initialized = false
  private input: Uint8Array = new Uint8Array(0)
  private ended = false
  constructor(private readonly bytes: Uint8Array, start: number, private readonly inflater: ImageInflater) {
    this.position = start
    this.remaining = this.u32()
    const name = this.take(4)
    if (String.fromCharCode(...name) !== 'IDAT') throw new Error('Expected first PNG IDAT')
  }
  take(length: number): Uint8Array {
    const offset = this.position, available = this.bytes.length - offset
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid PNG read size')
    this.position += Math.min(length, available)
    if (length > available) throw new PngStreamReadError(offset, length, available)
    return this.bytes.subarray(offset, offset + length)
  }
  u32(): number {
    const data = this.take(4)
    return new DataView(data.buffer, data.byteOffset, 4).getUint32(0)
  }
  private *initialize(): Generator<void, void> {
    if (this.initialized) return
    this.checksum = yield* crc32(Uint8Array.of(73, 68, 65, 84))
    this.initialized = true
  }
  private *finishCrc(): Generator<void, void> {
    yield* this.initialize()
    if (this.u32() !== this.checksum) throw new ImageDecodeError('png', 'IDAT: CRC error')
  }
  private *refill(): Generator<void, void> {
    yield* this.initialize()
    if (this.input.length) return
    while (!this.remaining) {
      yield* this.finishCrc()
      this.remaining = this.u32()
      const name = this.take(4)
      this.checksum = yield* crc32(name)
      if (String.fromCharCode(...name) !== 'IDAT')
        throw new ImageDecodeError('png', 'Not enough image data')
      // Zero-length chunks must remain cooperative and still verify their CRC.
      yield
    }
    const input = this.take(Math.min(8192, this.remaining))
    this.remaining -= input.length
    this.checksum = yield* crc32(input, this.checksum)
    this.input = input
  }
  private step(output: Uint8Array) {
    const result = this.inflater.step(this.input, output)
    if (!Number.isInteger(result.inputUsed) || result.inputUsed < 0 || result.inputUsed > this.input.length ||
        !Number.isInteger(result.outputUsed) || result.outputUsed < 0 || result.outputUsed > output.length)
      throw new Error('Invalid PNG inflater consumption')
    this.input = this.input.subarray(result.inputUsed)
    return result
  }
  *row(length: number): Generator<void, Uint8Array> {
    const bytes = new Uint8Array(length)
    let offset = 0
    do {
      yield* this.refill()
      const result = this.step(bytes.subarray(offset))
      offset += result.outputUsed
      if (result.status === 'end') {
        if (offset !== length || this.input.length || this.remaining)
          throw new ImageDecodeError('png', 'Extra compressed data')
        this.ended = true
        return bytes
      }
      if (result.status !== 'ok')
        throw new ImageDecodeError('png', result.nativeReason || 'Decompression error')
      if (!result.inputUsed && !result.outputUsed)
        throw new ImageDecodeError('png', 'Decompression error')
      yield
    } while (offset < length)
    return bytes
  }
  /** png_read_finish_row can fail after the final transformed caller row has
   * already been written. The caller completes/key-tiles only after this. */
  *finishRow(last: boolean): Generator<void, void> {
    if (!last) return
    if (!this.ended) {
      const extra = new Uint8Array(1)
      while (true) {
        yield* this.refill()
        const result = this.step(extra)
        if (result.status === 'end') {
          if (result.outputUsed || this.input.length || this.remaining)
            throw new ImageDecodeError('png', 'Extra compressed data')
          this.ended = true
          break
        }
        if (result.status !== 'ok')
          throw new ImageDecodeError('png', result.nativeReason || 'Decompression Error')
        if (result.outputUsed) throw new ImageDecodeError('png', 'Extra compressed data')
        if (!result.inputUsed) throw new ImageDecodeError('png', 'Decompression Error')
        yield
      }
    }
    if (this.remaining || this.input.length) throw new ImageDecodeError('png', 'Extra compression data')
  }
  *endImageData(): Generator<void, void> {
    if (!this.ended || this.remaining || this.input.length) throw new Error('Unfinished PNG image stream')
    yield* this.finishCrc()
  }
}
