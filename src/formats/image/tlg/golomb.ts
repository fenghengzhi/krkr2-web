const runs = [
  [3, 7, 15, 27, 63, 108, 223, 448, 130],
  [3, 5, 13, 24, 51, 95, 192, 384, 257],
  [2, 5, 12, 21, 39, 86, 155, 320, 384],
  [2, 3, 9, 18, 33, 61, 129, 258, 511],
]
const lengths = runs.map((row) => {
  const table = new Uint8Array(1024)
  let at = 0
  row.forEach((count, k) => {
    table.fill(k, at, at + count)
    at += count
  })
  return table
})

export function golombLength(a: number, n: number): number {
  const value = lengths[n]?.[a]
  if (value === undefined) throw new Error('Invalid TLG6 adaptive state')
  return value
}

class Bits {
  position = 0
  constructor(
    private readonly bytes: Uint8Array,
    private readonly length: number,
  ) {
    if (length < 1 || length > bytes.length * 8) throw new Error('Invalid TLG6 bit length')
  }
  read(count = 1): number {
    if (this.position + count > this.length) throw new Error('Truncated TLG6 bitstream')
    let value = 0
    for (let i = 0; i < count; i++, this.position++)
      value |= ((this.bytes[this.position >>> 3]! >>> (this.position & 7)) & 1) << i
    return value
  }
  gamma(): number {
    let zeros = 0
    while (!this.read()) if (++zeros > 15) throw new Error('TLG6 run exceeds row group')
    return (1 << zeros) + this.read(zeros)
  }
  quotient(): number {
    // The escape is anchored to the starting byte, not to the starting bit.
    const limit = 32 - (this.position & 7)
    for (let zeros = 0; zeros < limit; zeros++) if (this.read()) return zeros
    return this.read(8)
  }
}

export function* decodeGolomb(
  bytes: Uint8Array,
  bitLength: number,
  size: number,
): Generator<void, Uint8Array> {
  if (!Number.isInteger(size) || size < 1 || size > 4096 * 8)
    throw new Error('Invalid TLG6 row group size')
  const bits = new Bits(bytes, bitLength),
    output = new Uint8Array(size)
  let nonzero = bits.read(),
    at = 0,
    n = 3,
    a = 0,
    work = 0
  while (at < size) {
    const count = bits.gamma()
    if (count > size - at) throw new Error('TLG6 run exceeds row group')
    if (nonzero) {
      for (let end = at + count; at < end; at++) {
        const k = lengths[n]![a]
        if (k === undefined) throw new Error('Invalid TLG6 adaptive state')
        const value = (bits.quotient() << k) + bits.read(k)
        if (value > 254) throw new Error('Invalid TLG6 residual')
        output[at] = value & 1 ? (value >>> 1) + 1 : -(value >>> 1) - 1
        a += value >>> 1
        if (--n < 0) {
          a >>>= 1
          n = 3
        }
        if (++work >= 4096) {
          work = 0
          yield
        }
      }
    } else {
      at += count
      work += count
      if (work >= 4096) {
        work = 0
        yield
      }
    }
    nonzero ^= 1
  }
  return output
}
