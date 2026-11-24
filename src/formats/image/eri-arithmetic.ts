/* ERINA lossless arithmetic decoding, derived from ERINA-Library 1.0A
 * Copyright (C) 2000-2002 Leshade Entis, Entis-soft. Attribution and original
 * distribution terms: docs/decisions/119-eri-png-and-hosted-codecs.md.
 * The EOF continuation below follows the original x86 decoder, not the
 * different virtual-tail count in the scalar C++ implementation. */
import { ImageDecodeError } from './selection.ts'
import type { EriBitSource } from './eri-truecolor.ts'

// Reserve the full original 256-context/256-symbol payload even though
// smaller bit widths and unused contexts allocate less. JS object overhead
// is separately bounded by this fixed context count, not measured as RSS.
export const ERI_ARITHMETIC_BYTES = 256 * (4 + 256 * 4)
const UINT32_MAX = 0xffffffff

function failed(): never { throw new ImageDecodeError('eri', 'ERIDecoder::DecodeImage failed.') }

interface Model {
  total: number
  frequencies: Uint16Array
  symbols: Int16Array
}

/** Unsigned 32-bit interval registers and adaptive previous-symbol models.
 * Every product is at most uint32 * 65535 (< 2^48), hence exactly represented
 * as a JS integer. For floor/ceil division, possible fractions are larger
 * than one binary64 ULP at their quotient's magnitude; no 64-bit rounding is
 * introduced by the native MUL/DIV equivalents used here. */
export class EriArithmeticDecoder {
  private readonly count: number
  private readonly mask: number
  private readonly models: (Model | undefined)[]
  private context = 0
  private code = 0
  private range = UINT32_MAX
  private buffer: number
  private virtualStarted = false
  private virtualRemaining = 0
  private work = 0

  constructor(private readonly bits: EriBitSource, bitCount: number) {
    // Native has only 256 model pointers. Wider alphabets overwrite that
    // array; zero bits degenerates to a single-symbol WORD-frequency model.
    // These are explicit safe Web boundaries, not invented codec rejects.
    if (!Number.isInteger(bitCount) || bitCount < 1 || bitCount > 8)
      throw new Error('ERI arithmetic symbol width exceeds the safe 1..8 bit range')
    this.count = 2 ** bitCount
    this.mask = this.count - 1
    this.models = new Array(this.count)
    this.buffer = bits.take(32) >>> 0
    for (let i = 0; i < 32; i++) {
      this.prepareStuffing()
      this.code = ((this.code << 1) | (this.buffer >>> 31)) >>> 0
      const bit = bits.next()
      // GetABit returns 0/-1 for actual bits, but +1 for EOF. Its &1 in
      // PrepareToDecodeArithmeticCode therefore shifts an EOF one here.
      this.buffer = ((this.buffer << 1) | (bit < 0 ? 1 : bit)) >>> 0
    }
    this.prepareStuffing()
  }
  private prepareStuffing(): void {
    if (this.buffer !== UINT32_MAX) return
    // Native subtracts GetABit()>>1: real one gives -1, zero/EOF give0.
    if (this.bits.next() === 1) {
      this.buffer = 0
      this.code = (this.code + 1) >>> 0
    }
  }
  private inputBit(): number {
    if (this.virtualRemaining > 0) { this.virtualRemaining--; return 0 }
    const bit = this.bits.next()
    if (bit >= 0) return bit
    if (this.virtualStarted) failed()
    // experia.asm overflow_label1/2 jumps past the usual Dec edi, installs
    // edi=128 and consumes one zero immediately. That is 129 shared virtual
    // bits total, including any stuffing bit, before the second EOF stops.
    this.virtualStarted = true
    this.virtualRemaining = 128
    return 0
  }
  private model(): Model {
    let model = this.models[this.context]
    if (!model) {
      const frequencies = new Uint16Array(this.count), symbols = new Int16Array(this.count)
      frequencies.fill(1)
      for (let i = 0; i < this.count; i++) symbols[i] = i < this.count / 2 ? i : i - this.count
      this.models[this.context] = model = { total: this.count, frequencies, symbols }
      this.work += this.count
    }
    return model
  }
  *read(output: Int32Array | Uint8Array): Generator<void> {
    for (let at = 0; at < output.length; at++) {
      const model = this.model(), frequencies = model.frequencies, symbols = model.symbols,
        total = model.total
      let accumulated = Math.floor(this.code * total / this.range), before = 0, index = 0
      if (accumulated >= 0x10000) failed()
      while (index < this.count && accumulated >= frequencies[index]!) {
        const frequency = frequencies[index++]!
        accumulated -= frequency
        before += frequency
        this.work++
      }
      if (index === this.count) failed()
      const frequency = frequencies[index]!
      this.code = (this.code - Math.ceil(this.range * before / total)) >>> 0
      this.range = Math.floor(this.range * frequency / total) >>> 0
      if (!this.range) throw new Error('ERI arithmetic interval reached an unsafe zero range')
      while (this.range < 0x80000000) {
        this.code = ((this.code << 1) | (this.buffer >>> 31)) >>> 0
        this.buffer = ((this.buffer << 1) | this.inputBit()) >>> 0
        if (this.buffer === UINT32_MAX) {
          this.buffer = (this.buffer + this.inputBit()) >>> 0
          if (this.buffer === 0) this.code = (this.code + 1) >>> 0
        }
        this.range = (this.range * 2) >>> 0
        this.work++
      }
      // Update precedes the caller-visible symbol. Equal weights move the
      // current symbol ahead of existing entries, including during ties.
      const symbol = symbols[index]!, updated = frequency + 1
      while (index > 0 && frequencies[index - 1]! <= updated) {
        frequencies[index] = frequencies[index - 1]!
        symbols[index] = symbols[index - 1]!
        index--
        this.work++
      }
      frequencies[index] = updated
      symbols[index] = symbol
      output[at] = symbol
      model.total++
      if (model.total >= 0x10000) {
        let total = 0
        for (let i = 0; i < this.count; i++) {
          const frequency = (frequencies[i]! + 1) >>> 1
          frequencies[i] = frequency
          total += frequency
        }
        model.total = total
        this.work += this.count
      }
      this.context = symbol & this.mask
      if (++this.work >= 4096) { this.work = 0; yield }
    }
  }
}

export function* decodeEriArithmeticIndices(bits: EriBitSource, width: number, height: number): Generator<void, Uint8Array> {
  if (width * height * 5 + ERI_ARITHMETIC_BYTES > 96 * 1024 * 1024)
    throw new Error('ERI palette exceeds the 96 MiB owned work budget')
  const plane = new Uint8Array(width * height), decoder = new EriArithmeticDecoder(bits, 8)
  for (let y = 0; y < height; y++) {
    yield* decoder.read(plane.subarray(y * width, (y + 1) * width))
    yield
  }
  return plane
}
