// ZIP method 9 shares the block and Huffman formats of DEFLATE, but uses a
// 64 KiB dictionary, two additional distances and a 16-bit length at code 285.
import type { ByteSource } from '../../engine/ports/storage.ts'
import { CompressionError } from '../binary/compression-error.ts'

const windowSize = 65536, mask = windowSize - 1
const lengthBases = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 3]
const lengthBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 16]
const codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

function invalid(reason: string): never {
  throw new CompressionError('inflate', 'Invalid Deflate64 stream: ' + reason)
}

class Bits {
  private loaded = 0
  private buffer: Uint8Array = new Uint8Array()
  private bit = 0
  constructor(private readonly source: ByteSource, private readonly start: number,
    private readonly length: number, private readonly check: () => void | Promise<void>) {}
  ready(bytes: number): boolean {
    return this.loaded === this.length || this.buffer.length * 8 - this.bit >= bytes * 8
  }
  async refill(): Promise<void> {
    const from = Math.floor(this.bit / 8), rest = this.buffer.subarray(from)
    await this.check()
    const count = Math.min(windowSize, this.length - this.loaded)
    const bytes = await this.source.read(this.start + this.loaded, count)
    await this.check()
    if (bytes.length !== count) throw new Error('Short compressed ZIP source read')
    if (rest.length) {
      const joined = new Uint8Array(rest.length + count)
      joined.set(rest); joined.set(bytes, rest.length)
      this.buffer = joined
    } else this.buffer = bytes
    this.bit %= 8
    this.loaded += count
  }
  peek(n: number): number {
    const i = Math.floor(this.bit / 8)
    // Zero-extension is only for table lookup. take() checks the actual bits
    // consumed, including the final short end-of-block symbol.
    const word = (this.buffer[i] ?? 0) | ((this.buffer[i + 1] ?? 0) << 8) | ((this.buffer[i + 2] ?? 0) << 16)
    return (word >>> (this.bit % 8)) & ((1 << n) - 1)
  }
  drop(n: number): void {
    if (this.bit + n > this.buffer.length * 8) invalid('truncated code')
    this.bit += n
  }
  take(n: number): number {
    const value = this.peek(n)
    this.drop(n)
    return value
  }
  align() { this.bit = Math.ceil(this.bit / 8) * 8 }
  bytes(n: number): Uint8Array {
    const at = this.bit / 8
    if (at + n > this.buffer.length) invalid('truncated stored block')
    this.bit += n * 8
    return this.buffer.subarray(at, at + n)
  }
  finish() {
    if (this.loaded !== this.length || Math.ceil(this.bit / 8) !== this.buffer.length) invalid('unused compressed bytes')
  }
}

/** A short prefix table handles the usual codes. Longer ones use canonical
 * intervals, keeping even a 15-bit dynamic alphabet proportional to its size. */
class Alphabet {
  private readonly count = new Uint16Array(16)
  private readonly first = new Uint16Array(16)
  private readonly offset = new Uint16Array(16)
  private readonly symbols: Uint16Array
  private readonly fast: Uint16Array
  private readonly fastBits: number
  private readonly max: number
  constructor(widths: Uint8Array, kind: 'codes' | 'literal' | 'distance') {
    let max = 0
    for (const n of widths) if (n) { this.count[n]++; max = Math.max(max, n) }
    this.max = max
    this.fastBits = Math.min(9, max)
    this.fast = new Uint16Array(1 << this.fastBits)
    this.symbols = new Uint16Array(widths.length)
    if (!max && kind === 'distance') return // Literal-only blocks can omit all distances.
    let free = 1
    for (let n = 1; n <= max; n++) {
      free = 2 * free - this.count[n]
      if (free < 0) invalid('oversubscribed Huffman alphabet')
      this.first[n] = (this.first[n - 1] + this.count[n - 1]) * 2
      this.offset[n] = this.offset[n - 1] + this.count[n - 1]
    }
    if (free && (kind === 'codes' || max !== 1)) invalid('incomplete Huffman alphabet')
    const next = this.offset.slice()
    for (let sym = 0; sym < widths.length; sym++) {
      const n = widths[sym]
      if (!n) continue
      const at = next[n]++, code = this.first[n] + at - this.offset[n]
      this.symbols[at] = sym
      if (n > this.fastBits) continue
      let reversed = 0
      for (let bit = 0; bit < n; bit++) reversed = (reversed << 1) | ((code >>> bit) & 1)
      for (let i = reversed; i < this.fast.length; i += 1 << n) this.fast[i] = (sym << 4) | n
    }
  }
  decode(input: Bits): number {
    const bits = input.peek(this.max), fast = this.fast[bits & (this.fast.length - 1)]
    if (fast) { input.drop(fast & 15); return fast >>> 4 }
    let code = 0
    for (let n = 1; n <= this.max; n++) {
      code = (code << 1) | ((bits >>> (n - 1)) & 1)
      const ordinal = code - this.first[n]
      if (n > this.fastBits && ordinal >= 0 && ordinal < this.count[n]) {
        input.drop(n)
        return this.symbols[this.offset[n] + ordinal]
      }
    }
    return invalid('unknown Huffman code')
  }
}

const fixed = {
  literal: new Alphabet(new Uint8Array(288).fill(8).fill(9, 144, 256).fill(7, 256, 280), 'literal'),
  distance: new Alphabet(new Uint8Array(32).fill(5), 'distance'),
}
function dynamic(input: Bits): typeof fixed {
  const literals = input.take(5) + 257, distances = input.take(5) + 1, count = input.take(4) + 4
  if (literals > 286) invalid('literal alphabet size')
  const widths = new Uint8Array(19)
  for (let i = 0; i < count; i++) widths[codeLengthOrder[i]] = input.take(3)
  const codes = new Alphabet(widths, 'codes'), all = new Uint8Array(literals + distances)
  for (let at = 0; at < all.length;) {
    const code = codes.decode(input)
    if (code < 16) { all[at++] = code; continue }
    if (code === 16 && !at) invalid('missing previous code length')
    const n = code === 16 ? 3 + input.take(2) : code === 17 ? 3 + input.take(3) : 11 + input.take(7)
    if (at + n > all.length) invalid('code length repeat exceeds alphabet')
    all.fill(code === 16 ? all[at - 1] : 0, at, at + n)
    at += n
  }
  if (!all[256]) invalid('missing end of block')
  return { literal: new Alphabet(all.subarray(0, literals), 'literal'), distance: new Alphabet(all.subarray(literals), 'distance') }
}

export async function* inflateDeflate64(source: ByteSource, start: number, size: number, check: () => void | Promise<void>) {
  const input = new Bits(source, start, size, check), history = new Uint8Array(windowSize)
  let written = 0, final = false
  while (!final) {
    await check()
    // The entire dynamic header fits in 512 bytes (at most 318 code lengths).
    if (!input.ready(512)) await input.refill()
    final = !!input.take(1)
    const type = input.take(2)
    if (type === 0) {
      input.align()
      let remaining = input.take(16)
      if ((remaining ^ input.take(16)) !== 0xffff) invalid('stored block length')
      if (!input.ready(remaining)) await input.refill()
      while (remaining) {
        const pos = written & mask, n = Math.min(remaining, windowSize - pos)
        history.set(input.bytes(n), pos)
        written += n; remaining -= n
        if (!(written & mask)) { await check(); yield history.slice() }
      }
      continue
    }
    if (type === 3) invalid('reserved block type')
    const { literal, distance } = type === 1 ? fixed : dynamic(input)
    for (;;) {
      // A length/distance pair needs at most 60 bits.
      if (!input.ready(8)) await input.refill()
      const sym = literal.decode(input)
      if (sym === 256) break
      if (sym < 256) {
        history[written++ & mask] = sym
        if (!(written & mask)) { await check(); yield history.slice() }
        continue
      }
      if (sym > 285) invalid('reserved length code')
      let length = lengthBases[sym - 257] + input.take(lengthBits[sym - 257])
      const slot = distance.decode(input), extra = slot < 4 ? 0 : (slot >>> 1) - 1
      const back = slot < 4 ? slot + 1 : ((2 + (slot & 1)) << extra) + 1 + input.take(extra)
      if (back > written) invalid('distance exceeds available history')
      while (length) {
        const pos = written & mask, n = Math.min(length, windowSize - pos)
        if (back === 1) history.fill(history[(pos - 1) & mask], pos, pos + n)
        else for (let i = pos; i < pos + n; i++) history[i] = history[(i - back) & mask]
        written += n; length -= n
        if (!(written & mask)) { await check(); yield history.slice() }
      }
    }
  }
  input.finish()
  if (written & mask) { await check(); yield history.slice(0, written & mask) }
}
