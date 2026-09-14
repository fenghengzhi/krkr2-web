import { BinaryReader } from '../../binary/reader.ts'

/** TLG's shared 4 KiB sliding dictionary; raw TLG5 planes leave it untouched. */
export class SlideDecoder {
  private readonly dictionary = new Uint8Array(4096)
  private write = 0

  constructor(filters = false) {
    if (filters) {
      let at = 0
      for (let i = 0; i < 32; i++)
        for (let j = 0; j < 16; j++) {
          this.dictionary.fill(i, at, at + 4)
          this.dictionary.fill(j, at + 4, at + 8)
          at += 8
        }
    }
  }

  *decode(bytes: Uint8Array, size: number): Generator<void, Uint8Array> {
    if (!Number.isSafeInteger(size) || size < 0 || size > 4096 * 4096)
      throw new Error('Invalid TLG dictionary output size')
    const input = new BinaryReader(bytes),
      output = new Uint8Array(size)
    let at = 0,
      work = 0
    while (at < size) {
      const flags = input.u8()
      for (let bit = 0; bit < 8 && at < size; bit++) {
        if (flags & (1 << bit)) {
          const code = input.u16()
          let source = code & 4095,
            length = (code >>> 12) + 3
          if (length === 18) length += input.u8()
          if (length > size - at) throw new Error('TLG dictionary match exceeds output')
          // Sequential copying is required for overlapping references and wraparound.
          for (let i = 0; i < length; i++) {
            const value = this.dictionary[source]!
            source = (source + 1) & 4095
            output[at++] = this.dictionary[this.write] = value
            this.write = (this.write + 1) & 4095
          }
          work += length
        } else {
          output[at++] = this.dictionary[this.write] = input.u8()
          this.write = (this.write + 1) & 4095
          work++
        }
        if (work >= 4096) {
          work = 0
          yield
        }
      }
    }
    if (input.remaining) throw new Error('Extra TLG dictionary data')
    return output
  }
}
