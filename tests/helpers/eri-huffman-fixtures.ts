// Independent forward ERINA encoder for small authored frame8 fixtures.
// Source: archived ERINA1.0A common/cmperi.cpp1096–1269 and
// cpp/cmperib.cpp131–342; adaptive tree common/experi.cpp145–242 and
// cpp/experib.cpp260–341. No product entropy/reconstruction code is imported.
import { eriTrueRaw, eriTrueRgb, eriTrueRgba, eriTrueGray } from './eri-truecolor-fixtures.ts'
import { eriRgbNegative, eriRgbPositive, eriPaletteGray } from './eri-fixtures.ts'

const ROOT = 512, ESCAPE = 0x7fffffff
interface Node { weight: number; parent: number; child: number | null; symbol?: number }
class BitWriter {
  readonly bits: number[] = []
  put(value: number, count: number) { for (let b = count - 1; b >= 0; b--) this.bits.push((value >>> b) & 1) }
  gamma(value: number) {
    if (!Number.isInteger(value) || value < 1) throw new Error('Invalid authored Huffman length')
    for (const digit of value.toString(2).slice(1)) { this.put(1, 1); this.put(Number(digit), 1) }
    this.put(0, 1)
  }
  unterminatedGamma() {
    const end = (Math.floor(this.bits.length / 32) + 1) * 32
    for (let i = 0; this.bits.length < end; i++) this.put(i % 2 === 0 ? 1 : 0, 1)
  }
  bytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 32) * 4)
    this.bits.forEach((value, at) => { out[at >>> 3]! |= value << (7 - (at & 7)) })
    return out
  }
}
export interface HuffmanAuthoringStats {
  literals: number; hits: number; lengths: number; lengthHits: number; blocks: number
  rebuilds: number; replacements: number
}
const statsFor = (blocks: number): HuffmanAuthoringStats =>
  ({ literals: 0, hits: 0, lengths: 0, lengthHits: 0, blocks, rebuilds: 0, replacements: 0 })
/** Tree mutation follows the independent original encoder's shared routines,
 * including its ordered half-weight rebuild and full length-tree replacement.
 * Expected image values remain authored independently of this writer. */
class ForwardTree {
  readonly nodes: (Node | undefined)[] = []
  readonly lookup = new Map<number, number>()
  private escape: number | undefined
  private first = ROOT
  constructor(private readonly stats: HuffmanAuthoringStats) { this.nodes[ROOT] = { weight: 0, parent: -1, child: null } }
  private node(at: number): Node {
    const value = this.nodes[at]
    if (!value) throw new Error('Invalid authored Huffman tree node')
    return value
  }
  private recount(at: number) {
    const node = this.node(at)
    if (node.child === null) throw new Error('Cannot recount an authored leaf')
    node.weight = this.node(node.child).weight + this.node(node.child + 1).weight
  }
  private relocate(from: number, to: number) {
    const node = this.node(from)
    if (node.symbol !== undefined) {
      if (node.symbol === ESCAPE) this.escape = to
      else this.lookup.set(node.symbol & 255, to)
    } else {
      if (node.child === null) throw new Error('Invalid authored branch')
      this.node(node.child).parent = to; this.node(node.child + 1).parent = to
    }
  }
  private normalize(entry: number) {
    let work = 0
    while (entry < ROOT) {
      if (++work > 1024) throw new Error('Authored Huffman normalization exceeded bound')
      let swap = entry + 1
      while (swap < ROOT && this.node(swap).weight < this.node(entry).weight) swap++
      swap--
      if (swap === entry) { entry = this.node(entry).parent; this.recount(entry); continue }
      this.relocate(entry, swap); this.relocate(swap, entry)
      const a = { ...this.node(entry) }, b = { ...this.node(swap) }, ap = a.parent, bp = b.parent
      this.nodes[entry] = { ...b, parent: ap }; this.nodes[swap] = { ...a, parent: bp }
      this.recount(bp); entry = bp
    }
  }
  private increase(at: number) {
    this.node(at).weight++; this.normalize(at)
    if (this.node(ROOT).weight >= 0x4000) this.rebuild()
  }
  private rebuild() {
    // common/experi.cpp250–347: retain rounded-up half leaf weights in their
    // existing reverse order, then merge the two lightest and insert the new
    // branch before equal-weight nodes. This is the original encoder's tree.
    this.stats.rebuilds++
    let next = ROOT
    for (let at = ROOT - 1; at >= this.first; at--) if (this.node(at).symbol !== undefined) {
      this.node(at).weight = (this.node(at).weight + 1) >>> 1
      this.nodes[next--] = { ...this.node(at) }
    }
    next++
    for (let at = this.first; at < ROOT; at += 2) {
      this.nodes[at] = { ...this.node(next) }; this.nodes[at + 1] = { ...this.node(next + 1) }; next += 2
      this.relocate(at, at); this.relocate(at + 1, at + 1)
      const weight = this.node(at).weight + this.node(at + 1).weight
      if (next <= ROOT) {
        let insertion = next
        while (insertion <= ROOT && weight > this.node(insertion).weight) {
          this.nodes[insertion - 1] = { ...this.node(insertion) }; insertion++
        }
        const parent = this.node(insertion - 1).parent
        this.nodes[insertion - 1] = { weight, child: at, parent }; next--
      } else {
        this.nodes[ROOT] = { weight, parent: -1, child: at }
        this.node(at).parent = ROOT; this.node(at + 1).parent = ROOT
        return
      }
    }
    throw new Error('Authored Huffman rebuild did not close the root')
  }
  private add(symbol: number) {
    if (this.first <= 0) {
      const at = this.node(0).symbol === ESCAPE ? 1 : 0
      this.node(at).symbol = symbol; this.node(at).child = null
      // Original replacement intentionally does not update the low-byte
      // lookup. Length output falls back to the exact-symbol scan above it.
      this.stats.replacements++
      return
    }
    const at = this.first -= 2, root = this.node(ROOT)
    this.nodes[at] = { weight: 1, parent: ROOT, child: null, symbol }
    this.lookup.set(symbol & 255, at)
    if (root.child === null) {
      this.escape = at + 1
      this.nodes[at + 1] = { weight: 1, parent: ROOT, child: null, symbol: ESCAPE }
      root.weight = 2; root.child = at
    } else {
      const old = { ...this.node(at + 2) }
      this.nodes[at + 1] = { ...old, parent: at + 2 }
      if (old.symbol !== undefined) {
        if (old.symbol === ESCAPE) this.escape = at + 1
        else this.lookup.set(old.symbol & 255, at + 1)
      }
      this.node(at).parent = at + 2
      this.nodes[at + 2] = { weight: old.weight + 1, parent: old.parent, child: at }
      this.normalize(at + 2)
    }
  }
  private path(at: number, writer: BitWriter) {
    const bits: number[] = []
    for (let count = 0; at < ROOT; count++) {
      if (count >= 512) throw new Error('Authored Huffman path exceeded bound')
      const parent = this.node(at).parent
      bits.push(Number(this.node(parent).child !== at)); at = parent
    }
    for (let i = bits.length - 1; i >= 0; i--) writer.put(bits[i]!, 1)
  }
  escaped(writer: BitWriter) {
    if (this.escape !== undefined) { const at = this.escape; this.path(at, writer); this.increase(at) }
  }
  write(value: number, writer: BitWriter, length: boolean, stats: HuffmanAuthoringStats) {
    let at = this.lookup.get(value & 255)
    if (length && (at === undefined || this.node(at).symbol !== value)) {
      at = undefined
      for (let i = ROOT - 1; i >= this.first; i--) if (this.node(i).symbol === value) { at = i; break }
    }
    if (at !== undefined) {
      this.path(at, writer); this.increase(at)
      if (length) stats.lengthHits++; else stats.hits++
    } else {
      this.escaped(writer)
      if (length) writer.gamma(value); else writer.put(value, 8)
      this.add(value); stats.literals++
    }
    if (length) stats.lengths++
  }
}

const concatenate = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}
const words = (...values: number[]) => {
  const out = new Uint8Array(values.length * 4), view = new DataView(out.buffer)
  values.forEach((value, at) => view.setUint32(at * 4, value >>> 0, true)); return out
}
const record = (name: string, bytes: Uint8Array) => concatenate(new TextEncoder().encode(name), words(bytes.length, 0), bytes)
export interface EriHuffmanInput {
  width: number; height: number; raw: readonly number[]; alpha?: boolean; positive?: boolean
  table?: boolean; operations?: readonly number[]; badSeparator?: boolean; failAfterBlocks?: number
}

/** Authored2x2 source planes; true original encoder uses vertical prediction
 * for every operation and optionally horizontal prediction. Predictor input
 * is computed from literal source samples, never product reconstruction. */
export function eriHuffmanEncode(input: EriHuffmanInput) {
  const { width, height, raw, alpha = false, table = false } = input, channels = alpha ? 4 : 3,
    across = Math.ceil(width / 2), down = Math.ceil(height / 2), count = across * down,
    operations = input.operations ?? Array(count).fill(0xc0) as number[], blocks: number[][] = [],
    stats = statsFor(count),
    differences: Readonly<Record<number, readonly [number, readonly number[]]>> = {
      5: [0, [1]], 6: [0, [2]], 7: [0, [1, 2]], 9: [1, [0]], 10: [1, [2]], 11: [1, [0, 2]],
      13: [2, [0]], 14: [2, [1]], 15: [2, [0, 1]],
    }
  if (raw.length !== width * height * 4 || operations.length !== count || count > 40000)
    throw new Error('Invalid bounded authored ERINA dimensions')
  const sample = (x: number, y: number, channel: number) => x < 0 || y < 0 || x >= width || y >= height
    ? 0 : raw[(y * width + x) * 4 + [2, 1, 0, 3][channel]!]!
  for (let by = 0; by < down; by++) for (let bx = 0; bx < across; bx++) {
    const op = operations[blocks.length]!, plane: number[] = []
    if (!Number.isInteger(op) || op < 128 || op > 255) throw new Error('Fixture operations must be original encoder diff2/3')
    for (let channel = 0; channel < channels; channel++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      const sx = bx * 2 + x, sy = by * 2 + y,
        vertical = sample(sx, sy, channel) - sample(sx, sy - 1, channel),
        left = sample(sx - 1, sy, channel) - sample(sx - 1, sy - 1, channel)
      plane.push(vertical - ((op & 64) ? left : 0))
    }
    const difference = differences[op & 15]
    if (difference) for (const target of difference[1]) for (let p = 0; p < 4; p++)
      plane[target * 4 + p]! -= plane[difference[0] * 4 + p]!
    const order: number[] = [], arrangement = (op >>> 4) & 3
    if (arrangement < 2) for (let c = 0; c < channels; c++) {
      for (const p of arrangement ? [0, 2, 1, 3] : [0, 1, 2, 3]) order.push(c * 4 + p)
    } else for (const p of arrangement === 2 ? [0, 1, 2, 3] : [0, 2, 1, 3])
      for (let c = 0; c < channels; c++) order.push(c * 4 + p)
    blocks.push(order.map((index) => plane[index]! & 255))
  }
  const writer = new BitWriter(), opTree = new ForwardTree(stats), trees = new Map<number, ForwardTree>(),
    tree = (context: number) => {
      let value = trees.get(context)
      if (!value) { value = new ForwardTree(stats); trees.set(context, value) }
      return value
    }
  let context = 0
  const encode = (values: readonly number[]) => {
    for (let i = 0; i < values.length;) {
      const symbol = values[i++]!
      tree(context).write(symbol, writer, false, stats)
      if (symbol === 0) {
        let length = 1
        while (i < values.length && values[i] === 0) { i++; length++ }
        tree(256).write(length, writer, true, stats)
      }
      context = symbol
    }
  }
  writer.put(8, 8); writer.put(0, 8); writer.put(Number(table), 8); writer.put(8, 8)
  if (table) for (const op of operations) opTree.write(op, writer, false, stats)
  writer.put(Number(input.badSeparator), 1)
  if (table) encode(blocks.flat())
  else for (let i = 0; i < blocks.length; i++) {
    opTree.write(operations[i]!, writer, false, stats)
    if (i === input.failAfterBlocks) {
      tree(context).write(0, writer, false, stats)
      tree(256).escaped(writer); writer.unterminatedGamma(); break
    }
    // All257 trees and previous-symbol context persist between blocks, just
    // like the original EncodeERINACodes; only this call bounds zero runs.
    encode(blocks[i]!)
  }
  const frame = writer.bytes(), header = new Uint8Array(64)
  header.set([69, 110, 116, 105, 115, 26, 0, 0]); new DataView(header.buffer).setUint32(8, 0x03000100, true)
  header.set(new TextEncoder().encode('Entis Rasterized Image'), 16)
  const info = words(0x20200, 0x03020000, 0xfffffffc, alpha ? 0x04000001 : 1,
    width, input.positive ? height : -height, alpha ? 32 : 24, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0)
  return { frame, stats, bytes: concatenate(header,
    record('Header  ', concatenate(record('FileHdr ', words(0x20100, 1, 1, 1, 0)), record('ImageInf', info))),
    record('Stream  ', record('ImageFrm', frame))) }
}

const reversed = (values: readonly number[], lanes: number) => [
  ...values.slice(6 * lanes), ...values.slice(3 * lanes, 6 * lanes), ...values.slice(0, 3 * lanes),
]
const base = { width: 3, height: 3, raw: eriTrueRaw } as const
export interface EriHuffmanCase {
  name: string; width: number; height: number; input: EriHuffmanInput; rgba: readonly number[]; gray: readonly number[]
}
export const eriHuffmanCases: readonly EriHuffmanCase[] = [
  { name: 'hc-rgb-inline.eri', ...base, input: { ...base, operations: [0xc0, 0xdb, 0xeb, 0xfb] }, rgba: eriTrueRgb, gray: eriTrueGray },
  { name: 'hc-rgb-table.eri', ...base, input: { ...base, table: true, operations: [0x80, 0x9b, 0xab, 0xbb] }, rgba: eriTrueRgb, gray: eriTrueGray },
  { name: 'hc-rgb-repeated-op.eri', ...base, input: base, rgba: eriTrueRgb, gray: eriTrueGray },
  { name: 'hc-rgba-inline.eri', ...base, input: { ...base, alpha: true, operations: [0xcb, 0xcb, 0xcb, 0xcb] }, rgba: eriTrueRgba, gray: eriTrueGray },
  { name: 'hc-rgba-table-positive.eri', ...base, input: { ...base, alpha: true, table: true, positive: true,
    operations: [0xff, 0x85, 0xad, 0x96] }, rgba: reversed(eriTrueRgba, 4), gray: reversed(eriTrueGray, 1) },
  { name: 'hc-zero-table.eri', ...base, input: { ...base, table: true, raw: Array(36).fill(0) },
    rgba: Array.from({ length: 9 }, () => [0, 0, 0, 255]).flat(), gray: Array(9).fill(0) },
  { name: 'hc-zero-inline.eri', ...base, input: { ...base, raw: Array(36).fill(0) },
    rgba: Array.from({ length: 9 }, () => [0, 0, 0, 255]).flat(), gray: Array(9).fill(0) },
]
export function eriHuffmanFiles(): Record<string, Uint8Array> {
  const files = Object.fromEntries(eriHuffmanCases.map((item) => [item.name, eriHuffmanEncode(item.input).bytes])),
    broken = eriHuffmanEncode({ ...base, alpha: true, failAfterBlocks: 1 }).bytes
  return { ...files, ...Object.fromEntries(eriHuffmanPaletteCases.map((item) => [item.name, paletteInput(item.positive)])),
    'hc-late-failure.eri': broken, 'hc-bad-separator.eri': eriHuffmanEncode({ ...base, badSeparator: true }).bytes,
    'hc-mask.eri': files['hc-rgb-inline.eri']!, 'hc-mask_m.eri': files['hc-rgba-inline.eri']!,
    'hc-mask-bad.eri': files['hc-rgb-inline.eri']!, 'hc-mask-bad_m.eri': broken }
}

export const eriHuffmanPaletteCases = [
  { name: 'hp-indexed-negative.eri', width: 3, height: 2, positive: false,
    rgba: eriRgbNegative, gray: eriPaletteGray, indices: [0, 1, 2, 2, 2, 1] },
  { name: 'hp-indexed-positive.eri', width: 3, height: 2, positive: true,
    rgba: eriRgbPositive, gray: [117, 117, 31, 0, 31, 117], indices: [2, 2, 1, 0, 1, 2] },
] as const
function paletteInput(positive: boolean) {
  const writer = new BitWriter(), stats = statsFor(0), trees = new Map<number, ForwardTree>(),
    tree = (context: number) => {
      let found = trees.get(context)
      if (!found) { found = new ForwardTree(stats); trees.set(context, found) }
      return found
    }
  let context = 0
  writer.put(2, 8); writer.put(0, 24)
  // Original EncodeERINACodes256: previous resets per row, adaptive trees
  // and previous-symbol context do not. Row2 starts with the prior row's2,
  // but only its second2 requests a run suffix; this distinguishes the states.
  for (const row of [[0, 1, 2], [2, 2, 1]]) {
    let previous = ESCAPE
    for (let at = 0; at < row.length;) {
      const symbol = row[at++]!
      tree(context).write(symbol, writer, false, stats)
      if (symbol === previous) {
        let length = 1
        while (at < row.length && row[at] === symbol) { at++; length++ }
        tree(256).write(length, writer, true, stats)
      }
      previous = symbol; context = symbol
    }
  }
  const header = new Uint8Array(64)
  header.set([69, 110, 116, 105, 115, 26, 0, 0]); new DataView(header.buffer).setUint32(8, 0x03000100, true)
  header.set(new TextEncoder().encode('Entis Rasterized Image'), 16)
  return concatenate(header, record('Header  ', concatenate(record('FileHdr ', words(0x20100, 0x11, 1, 1, 0)),
    record('ImageInf', words(0x20200, 0x03020000, 0xfffffffc, 0x01000001, 3, positive ? 2 : -2, 8,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0)))), record('Stream  ', concatenate(
      record('Palette ', Uint8Array.of(0, 0, 0, 0, 51, 34, 17, 7, 50, 100, 200, 99)),
      record('ImageFrm', writer.bytes()))))
}

/** Sparse authored picture: one red1 point at a2x2 block's top-left,
 * separated by1..258 entirely-zero blocks. Mixed differences stay within the
 * marked block. Table encoding therefore has >256 distinct zero-run lengths
 * and >0x4000 identical operation symbols, without constructing expectations
 * by inverse entropy decoding. Kept out of the small browser fixture pack. */
export function eriHuffmanStress() {
  const across = 256, width = across * 2, marked: number[] = []
  let block = 0
  for (let gap = 1; gap <= 258; gap++) { marked.push(block); block += gap + 1 }
  const height = Math.ceil(block / across) * 2, raw = Array<number>(width * height * 4).fill(0)
  for (const at of marked) raw[((Math.floor(at / across) * 2) * width + (at % across) * 2) * 4] = 1
  const expected = raw.slice()
  for (let at = 3; at < expected.length; at += 4) expected[at] = 255
  return { width, height, rgba: expected, ...eriHuffmanEncode({ width, height, raw, table: true }) }
}
