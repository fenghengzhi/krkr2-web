// Independent exact-interval authoring, not a port of the product decoder.
// The archived ERINA library has DecodeArithmeticCodes but no matching public
// encoder: common/experi.cpp410–493, cpp/experib.cpp540–655 and the fixed x86
// asm/experia.asm1372–1576 define the interval and model transitions used here.
import { eriTrueRaw, eriTrueRgb, eriTrueRgba, eriTrueGray } from './eri-truecolor-fixtures.ts'
import { eriRgbNegative, eriRgbPositive, eriPaletteGray } from './eri-fixtures.ts'

interface SymbolWeight { symbol: number; weight: number }
interface Model { symbols: SymbolWeight[]; total: number }
export interface ArithmeticStats { symbols: number; contexts: number; moves: number; rescales: number; shifts: number }

/** Construct an interior point in the desired symbol interval with exact
 * integers. No decoding, pixel reconstruction or product imports select it.
 * A real 64-bit zero tail covers all reader lookahead. This general interval
 * route avoids the separate 32-ones stuffing escape; a literal, independently
 * proven zero-raster control exercises that escape below. */
function intervalBits(values: readonly number[], bitCount: number) {
  if (!Number.isInteger(bitCount) || bitCount < 1 || bitCount > 8)
    throw new Error('Authored arithmetic bit count must be1..8')
  const size = 1 << bitCount, mask = size - 1, models = new Map<number, Model>(),
    stats: ArithmeticStats = { symbols: values.length, contexts: 0, moves: 0, rescales: 0, shifts: 0 }
  let context = 0, lower = 0n, range = 0xffffffffn
  for (const value of values) {
    const symbol = value & mask
    let model = models.get(context)
    if (!model) {
      model = { total: size, symbols: Array.from({ length: size }, (_, symbol) => ({ symbol, weight: 1 })) }
      models.set(context, model)
    }
    let index = model.symbols.findIndex((entry) => entry.symbol === symbol), cumulative = 0
    if (index < 0) throw new Error('Authored arithmetic symbol is absent')
    for (let i = 0; i < index; i++) cumulative += model.symbols[i]!.weight
    const selected = model.symbols[index]!, total = BigInt(model.total),
      product = range * BigInt(cumulative), offset = (product + total - 1n) / total
    lower += offset
    range = range * BigInt(selected.weight) / total
    if (!range) throw new Error('Authored arithmetic interval became empty')
    while (range < 0x80000000n) { range <<= 1n; lower <<= 1n; stats.shifts++ }
    // Original ordering: the incremented entry moves before equal weights.
    selected.weight++
    while (index > 0 && model.symbols[index - 1]!.weight <= selected.weight) {
      model.symbols[index] = model.symbols[index - 1]!; index--; stats.moves++
    }
    model.symbols[index] = selected
    if (++model.total >= 0x10000) {
      model.total = 0
      for (const entry of model.symbols) { entry.weight = (entry.weight + 1) >>> 1; model.total += entry.weight }
      stats.rescales++
    }
    context = symbol
  }
  stats.contexts = models.size
  const length = 32 + stats.shifts
  for (const delta of [range / 2n, range / 4n, 3n * range / 4n, 1n, range - 1n]) {
    const candidate = (lower + delta).toString(2).padStart(length, '0')
    if (candidate.length !== length) throw new Error('Authored arithmetic interval escaped its original range')
    if (!candidate.includes('1'.repeat(32))) return { bits: candidate + '0'.repeat(64), stats }
  }
  throw new Error('Authored arithmetic control needs an independently audited stuffing escape')
}
const concatenate = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0
  for (const part of parts) { result.set(part, at); at += part.length }
  return result
}
const words = (...values: number[]) => {
  const bytes = new Uint8Array(values.length * 4), view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true)); return bytes
}
const record = (name: string, bytes: Uint8Array) => concatenate(new TextEncoder().encode(name), words(bytes.length, 0), bytes)
const packed = (bits: string) => {
  const bytes = new Uint8Array(Math.ceil(bits.length / 32) * 4)
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') bytes[i >>> 3]! |= 1 << (7 - (i & 7))
  return bytes
}

export interface EriArithmeticInput {
  width: number; height: number; pixels: readonly number[]; frame?: 1 | 2 | 4; bitCount?: number
  alpha?: boolean; positive?: boolean; indexed?: boolean; badSeparator?: boolean; badInitialCode?: boolean
  operations?: readonly number[]; stuffedZero?: boolean
}
export function eriArithmeticEncode(input: EriArithmeticInput) {
  const { width, height, pixels, frame = 1, bitCount = 8, alpha = false, indexed = false } = input,
    channels = alpha ? 4 : 3, scalar = frame === 2, symbols: number[] = [],
    across = Math.ceil(width / 2), down = Math.ceil(height / 2),
    operations = input.operations ?? Array<number>(across * down).fill(0)
  if (width < 1 || height < 1 || width > 256 || height > 256 || pixels.length !== width * height * (scalar ? 1 : 4))
    throw new Error('Invalid bounded arithmetic fixture dimensions')
  if (scalar && bitCount !== 8) throw new Error('Frame2 arithmetic always uses8-bit source symbols')
  if (operations.length !== across * down || operations.some((value) => !Number.isInteger(value) || value < 0 || value >= (frame === 4 ? 64 : 16)))
    throw new Error('Invalid authored arithmetic operation table')
  if (scalar) symbols.push(...pixels.map((value) => value >= 128 ? value - 256 : value))
  else {
    const sample = (x: number, y: number, channel: number) => x < 0 || y < 0 || x >= width || y >= height
      ? 0 : pixels[(y * width + x) * 4 + [2, 1, 0, 3][channel]!]!
    // Independent forward ColorOperation from cpp/cmperib.cpp650–813 and
    // the literal2x2 InitializeArrangeTable orders. Alpha is never differenced
    // against a color plane; all block padding still participates.
    const differences: Readonly<Record<number, readonly [number, readonly number[]]>> = {
      5: [0, [1]], 6: [0, [2]], 7: [0, [1, 2]], 9: [1, [0]], 10: [1, [2]], 11: [1, [0, 2]],
      13: [2, [0]], 14: [2, [1]], 15: [2, [0, 1]],
    }, orders = [[0, 1, 2, 3], [0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2], [2, 1, 0, 3]]
    for (let by = 0; by < down; by++) for (let bx = 0; bx < across; bx++) {
      const operation = operations[by * across + bx]!,
        color = frame === 4 ? operation < 50 ? [0, 5, 6, 7, 9, 10, 11, 13, 14, 15][operation % 10]! : 0 : operation,
        order = orders[frame === 4 && operation < 50 ? Math.floor(operation / 10) : 0]!, planes: number[][] = []
      for (let c = 0; c < channels; c++) {
        const plane: number[] = []
        for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
          const sx = bx * 2 + x, sy = by * 2 + y
          plane.push(sample(sx, sy, c) - sample(sx - 1, sy, c) - sample(sx, sy - 1, c) + sample(sx - 1, sy - 1, c))
        }
        planes.push(plane)
      }
      const difference = differences[color]
      if (difference) for (const target of difference[1]) for (let i = 0; i < 4; i++)
        planes[target]![i]! -= planes[difference[0]]![i]!
      for (const plane of planes) for (const index of order) {
        const signed = ((plane[index]! + 128) & 255) - 128
        if (signed < -(1 << (bitCount - 1)) || signed >= 1 << (bitCount - 1))
          throw new Error('Authored residual is outside its selected signed symbol alphabet')
        symbols.push(signed)
      }
    }
  }
  if (input.stuffedZero && symbols.some((value) => value !== 0))
    throw new Error('The authored stuffing control requires all-zero source symbols')
  const encoded = intervalBits(symbols, bitCount),
    prefix = scalar ? '00000010000000000000000000000000'
      : frame.toString(2).padStart(8, '0') + '00000000' + bitCount.toString(2).padStart(8, '0') + '00000000'
        + operations.map((value) => value.toString(2).padStart(frame === 4 ? 6 : 4, '0')).join('')
        + (input.badSeparator ? '1' : '0'),
    // Defined invalid arithmetic point C=A=ffffffff: after its explicit0
    // stuffing bit, floor(C*N/A)=N exceeds the complete symbol alphabet.
    // Original Prepare: buffer=ffffffff followed by stuffing1 wraps buffer
    // to0 and increments code.32 subsequent shifts discard that carry,
    // leaving code0/buffer0. Zero source symbols keep code0 throughout.
    payload = input.badInitialCode ? '1'.repeat(32) + '0'.repeat(97)
      : input.stuffedZero ? '1'.repeat(33) + '0'.repeat(encoded.bits.length) : encoded.bits,
    entropy = packed(prefix + payload), header = new Uint8Array(64)
  header.set([69, 110, 116, 105, 115, 26, 0, 0]); new DataView(header.buffer).setUint32(8, 0x03000100, true)
  header.set(new TextEncoder().encode('Entis Rasterized Image'), 16)
  const kind = scalar ? indexed ? 0x01000001 : 2 : alpha ? 0x04000001 : 1,
    info = words(frame === 4 ? 0x20200 : 0x20100, 0x03020000, 32, kind, width, input.positive ? height : -height,
      scalar ? 8 : alpha ? 32 : 24, 0, 0, 0, 0, 0, 0, scalar ? 0 : 1, 0, 0, 0)
  const palette = Uint8Array.of(0, 0, 0, 0, 51, 34, 17, 7, 50, 100, 200, 99)
  return { frame: entropy, stats: encoded.stats, bytes: concatenate(header,
    record('Header  ', concatenate(record('FileHdr ', words(0x20100, indexed ? 0x11 : 1, 1, 1, 0)), record('ImageInf', info))),
    record('Stream  ', concatenate(...(indexed ? [record('Palette ', palette)] : []), record('ImageFrm', entropy)))) }
}

export interface EriArithmeticCase {
  name: string; width: number; height: number; input: EriArithmeticInput
  rgba: readonly number[]; gray: readonly number[]; indexed?: boolean; indices?: readonly number[]
}
const base = { width: 3, height: 3, pixels: eriTrueRaw } as const
const reversed = (values: readonly number[], width: number, lanes: number) => {
  const result: number[] = []
  for (let at = values.length - width * lanes; at >= 0; at -= width * lanes) result.push(...values.slice(at, at + width * lanes))
  return result
}
const grayRgba = (values: readonly number[]) => values.flatMap((value) => [value, value, value, 255])
const lowRgb = [1, 0, 3, 255, 2, 1, 2, 255, 3, 1, 1, 255,
  2, 1, 3, 255, 3, 2, 2, 255, 4, 2, 1, 255, 3, 2, 3, 255, 4, 3, 2, 255, 5, 3, 1, 255] as const
const indices = [0, 1, 2, 2, 2, 1] as const
export const eriArithmeticCases: readonly EriArithmeticCase[] = [
  { name: 'ar-rgb8-table.eri', ...base, input: base, rgba: eriTrueRgb, gray: eriTrueGray },
  { name: 'ar-rgb8-positive.eri', ...base, input: { ...base, positive: true },
    rgba: reversed(eriTrueRgb, 3, 4), gray: reversed(eriTrueGray, 3, 1) },
  { name: 'ar-rgba8-table.eri', ...base, input: { ...base, alpha: true }, rgba: eriTrueRgba, gray: eriTrueGray },
  { name: 'ar-rgba8-v4-positive.eri', ...base, input: { ...base, frame: 4, alpha: true, positive: true, operations: [36, 16, 26, 46] },
    rgba: reversed(eriTrueRgba, 3, 4), gray: reversed(eriTrueGray, 3, 1) },
  { name: 'ar-low4.eri', ...base, input: { ...base, pixels: lowRgb, bitCount: 4 }, rgba: lowRgb, gray: [0, 1, 1, 1, 2, 2, 2, 3, 3] },
  { name: 'ar-bit1-white.eri', width: 2, height: 2, input: { width: 2, height: 2, pixels: Array(16).fill(255), bitCount: 1 },
    rgba: Array(16).fill(255), gray: [255, 255, 255, 255] },
  { name: 'ar-gray8-frame2.eri', width: 3, height: 2, input: { width: 3, height: 2, frame: 2, pixels: indices },
    rgba: grayRgba(indices), gray: indices },
  { name: 'ar-palette8-frame2.eri', width: 3, height: 2, input: { width: 3, height: 2, frame: 2, pixels: indices, indexed: true },
    rgba: eriRgbNegative, gray: eriPaletteGray, indexed: true, indices },
  { name: 'ar-palette8-positive.eri', width: 3, height: 2, input: { width: 3, height: 2, frame: 2, pixels: indices, indexed: true, positive: true },
    rgba: eriRgbPositive, gray: reversed(eriPaletteGray, 3, 1), indexed: true, indices: reversed(indices, 3, 1) },
  { name: 'ar-stuffed-zero.eri', ...base, input: { ...base, pixels: Array(36).fill(0), stuffedZero: true },
    rgba: Array.from({ length: 9 }, () => [0, 0, 0, 255]).flat(), gray: Array(9).fill(0) },
]
export function eriArithmeticFiles(): Record<string, Uint8Array> {
  const files = Object.fromEntries(eriArithmeticCases.map((item) => [item.name, eriArithmeticEncode(item.input).bytes])),
    bad = eriArithmeticEncode({ ...base, badInitialCode: true }).bytes
  return { ...files, 'ar-bad-initial.eri': bad,
    'ar-bad-separator.eri': eriArithmeticEncode({ ...base, badSeparator: true }).bytes,
    'ar-mask.eri': files['ar-rgb8-table.eri']!, 'ar-mask_m.eri': files['ar-rgba8-table.eri']!,
    'ar-mask-bad.eri': files['ar-rgb8-table.eri']!, 'ar-mask-bad_m.eri': bad }
}
export function eriArithmeticStress() {
  const width = 256, height = 256, pixels = Array<number>(width * height * 4).fill(0), rgba = pixels.slice()
  for (let at = 3; at < rgba.length; at += 4) rgba[at] = 255
  return { width, height, rgba, ...eriArithmeticEncode({ width, height, pixels, bitCount: 1 }) }
}
