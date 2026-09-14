import { BinaryWriter } from '../../binary/writer.ts'

/** Bounded hash-chain search over TLG's dictionary. Matches never overlap writes. */
export class SlideEncoder {
  private readonly dictionary = new Uint8Array(4096)
  private readonly heads = new Int16Array(65536)
  private readonly tails = new Int16Array(65536)
  private readonly previous = new Int16Array(4096)
  private readonly next = new Int16Array(4096)
  private readonly keys = new Uint16Array(4096)
  private write = 0
  constructor(filters = false) {
    if (filters)
      for (let i = 0, at = 0; i < 32; i++)
        for (let j = 0; j < 16; j++, at += 8) {
          this.dictionary.fill(i, at, at + 4)
          this.dictionary.fill(j, at + 4, at + 8)
        }
    this.rebuild()
  }
  private add(position: number): void {
    const key = this.dictionary[position]! | (this.dictionary[(position + 1) & 4095]! << 8),
      head = this.heads[key]!
    this.keys[position] = key
    this.previous[position] = -1
    this.next[position] = head
    if (head >= 0) this.previous[head] = position
    else this.tails[key] = position
    this.heads[key] = position
  }
  private remove(position: number): void {
    const key = this.keys[position]!,
      before = this.previous[position]!,
      after = this.next[position]!
    if (before < 0) this.heads[key] = after
    else this.next[before] = after
    if (after < 0) this.tails[key] = before
    else this.previous[after] = before
  }
  private rebuild(): void {
    this.heads.fill(-1)
    this.tails.fill(-1)
    for (let i = 4095; i >= 0; i--) this.add(i)
  }
  private put(value: number): void {
    const before = (this.write + 4095) & 4095
    this.remove(before)
    this.remove(this.write)
    this.dictionary[this.write] = value
    this.add(before)
    this.add(this.write)
    this.write = (this.write + 1) & 4095
  }
  *encode(
    input: Uint8Array,
    rawFallback = true,
  ): Generator<void, { bytes: Uint8Array; compressed: boolean }> {
    const saved = rawFallback ? this.dictionary.slice() : undefined,
      savedWrite = this.write,
      output = new BinaryWriter()
    let at = 0,
      work = 0
    while (at < input.length) {
      const tokens = new BinaryWriter(32)
      let flags = 0
      for (let bit = 0; bit < 8 && at < input.length; bit++) {
        let bestLength = 0,
          bestPosition = 0
        const maximum = Math.min(273, input.length - at)
        if (maximum >= 3) {
          const key = input[at]! | (input[at + 1]! << 8),
            tail = this.tails[key]!
          let candidate = tail,
            trials = 0
          while (candidate >= 0 && trials < 66) {
            const distance = (this.write - candidate + 4096) & 4095,
              limit = Math.min(maximum, distance)
            if (limit >= 3) {
              let length = 2
              while (
                length < limit &&
                this.dictionary[(candidate + length) & 4095] === input[at + length]
              ) {
                length++
                if (++work >= 4096) {
                  work = 0
                  yield
                }
              }
              if (length > bestLength) {
                bestLength = length
                bestPosition = candidate
              }
              if (length === maximum) break
            }
            candidate = trials++ === 0 ? this.heads[key]! : this.next[candidate]!
            if (++work >= 4096) {
              work = 0
              yield
            }
          }
        }
        const count = bestLength >= 3 ? bestLength : 1
        if (bestLength >= 3) {
          flags |= 1 << bit
          tokens.u16(bestPosition | (Math.min(bestLength - 3, 15) << 12))
          if (bestLength >= 18) tokens.u8(bestLength - 18)
        } else tokens.u8(input[at]!)
        for (let i = 0; i < count; i++) this.put(input[at++]!)
        work += count
        if (work >= 4096) {
          work = 0
          yield
        }
      }
      output.u8(flags)
      output.append(tokens.finish())
    }
    if (rawFallback && output.length >= input.length) {
      this.dictionary.set(saved!)
      this.write = savedWrite
      this.rebuild()
      return { bytes: input, compressed: false }
    }
    return { bytes: output.finish(), compressed: true }
  }
}
