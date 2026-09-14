import { golombLength } from './golomb.ts'

export class BitOutput {
  private bytes: Uint8Array
  length = 0
  constructor(private readonly countOnly = false) {
    this.bytes = new Uint8Array(countOnly ? 0 : 256)
  }
  put(value: number, count: number): void {
    if (this.countOnly) {
      this.length += count
      return
    }
    const needed = Math.ceil((this.length + count) / 8)
    if (needed > 256 * 1024) throw new Error('TLG6 plane exceeds bitstream budget')
    if (needed > this.bytes.length) {
      const bytes = new Uint8Array(Math.max(needed, this.bytes.length * 2))
      bytes.set(this.bytes)
      this.bytes = bytes
    }
    for (let i = 0; i < count; i++, this.length++)
      this.bytes[this.length >>> 3]! |= ((value >>> i) & 1) << (this.length & 7)
  }
  gamma(value: number): void {
    const bits = 31 - Math.clz32(value)
    this.put(0, bits)
    this.put(1, 1)
    this.put(value - (1 << bits), bits)
  }
  finish(): Uint8Array {
    return this.bytes.slice(0, Math.ceil(this.length / 8))
  }
}
export function* writeGolomb(input: Uint8Array, output: BitOutput): Generator<void, void> {
  if (!input.length || input.length > 32768) throw new Error('Invalid TLG6 plane size')
  output.put(input[0] ? 1 : 0, 1)
  let at = 0,
    n = 3,
    a = 0,
    work = 0
  while (at < input.length) {
    const nonzero = !!input[at],
      start = at
    while (at < input.length && !!input[at] === nonzero) {
      at++
      if (++work >= 4096) {
        work = 0
        yield
      }
    }
    output.gamma(at - start)
    if (nonzero)
      for (let i = start; i < at; i++) {
        const signed = input[i]! > 127 ? input[i]! - 256 : input[i]!,
          value = signed > 0 ? 2 * signed - 1 : -2 * signed - 2,
          k = golombLength(a, n),
          q = value >>> k,
          limit = 32 - (output.length & 7)
        if (q >= limit) {
          output.put(0, limit)
          output.put(q, 8)
        } else {
          output.put(0, q)
          output.put(1, 1)
        }
        output.put(value, k)
        a += value >>> 1
        if (--n < 0) {
          n = 3
          a >>>= 1
        }
        if (++work >= 4096) {
          work = 0
          yield
        }
      }
  }
}
/** The block selection heuristic starts adaptive state fresh, like the reference. */
export function golombCost(input: Uint8Array): number {
  const output = new BitOutput(true),
    work = writeGolomb(input, output)
  while (!work.next().done) {}
  return output.length
}
