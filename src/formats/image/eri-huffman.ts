/* ERINA adaptive runlength-Huffman decoding, derived from ERINA-Library 1.0A
 * Copyright (C) 2000-2002 Leshade Entis, Entis-soft. Attribution and original
 * distribution terms: docs/decisions/119-eri-png-and-hosted-codecs.md. */
import { ImageDecodeError } from './selection.ts'
import type { EriBitSource } from './eri-truecolor.ts'

const ROOT = 0x200, NIL = 0x8000, LEAF = 0x80000000, ESCAPE = 0x7fffffff, MAX_WEIGHT = 0x4000
// Worst-case typed-array payload for the operation tree and 257 lazy data/
// length trees. Native's reverse symbol lookup is encoder-only and omitted.
// This is not a measurement of JavaScript object overhead.
export const ERI_HUFFMAN_BYTES = 258 * 513 * 8
export interface EriHuffmanWork { value: number }

function failed(): never { throw new ImageDecodeError('eri', 'ERIDecoder::DecodeImage failed.') }
function treeBounds(): never { throw new Error('ERI Huffman tree exceeded its bounded structure') }

/** Ordered sibling tree, including escape entries, least-weight replacement,
 * exact equal-weight ordering, and the original half-weight rebuild. */
export class EriHuffmanTree {
  private readonly weight = new Uint16Array(ROOT + 1)
  private readonly parent = new Uint16Array(ROOT + 1)
  private readonly child = new Uint32Array(ROOT + 1)
  private start = ROOT
  constructor(private readonly work: EriHuffmanWork) {
    this.parent[ROOT] = NIL
    this.child[ROOT] = NIL
  }
  private copy(to: number, from: number): void {
    this.weight[to] = this.weight[from]!
    this.parent[to] = this.parent[from]!
    this.child[to] = this.child[from]!
  }
  private recount(at: number): void {
    if (at < 0 || at > ROOT) treeBounds()
    const child = this.child[at]!
    if (child >= ROOT) treeBounds()
    this.weight[at] = this.weight[child]! + this.weight[child + 1]!
    this.work.value++
  }
  private reparent(at: number, to: number): void {
    const child = this.child[at]!
    if (!(child & LEAF)) {
      if (child >= ROOT) treeBounds()
      this.parent[child] = this.parent[child + 1] = to
    }
  }
  private normalize(at: number): void {
    for (let levels = 0; at < ROOT; levels++) {
      if (at < this.start || levels > ROOT) treeBounds()
      let swap = at + 1
      const weight = this.weight[at]!
      while (swap < ROOT && this.weight[swap]! < weight) { swap++; this.work.value++ }
      swap--
      if (swap === at) {
        at = this.parent[at]!
        this.recount(at)
        continue
      }
      this.reparent(at, swap)
      this.reparent(swap, at)
      // Preserve each location's parent, just as the native node swap does.
      const swapParent = this.parent[swap]!, swapWeight = this.weight[swap]!, swapChild = this.child[swap]!
      this.weight[swap] = this.weight[at]!
      this.child[swap] = this.child[at]!
      this.weight[at] = swapWeight
      this.child[at] = swapChild
      this.recount(swapParent)
      at = swapParent
    }
    if (at !== ROOT) treeBounds()
  }
  private add(code: number): void {
    if (this.start > 0) {
      const at = this.start -= 2
      this.weight[at] = 1
      this.child[at] = (LEAF | code) >>> 0
      if (this.child[ROOT] !== NIL) {
        this.copy(at + 1, at + 2)
        this.weight[at + 2] = this.weight[at]! + this.weight[at + 1]!
        this.parent[at + 2] = this.parent[at + 1]!
        this.child[at + 2] = at
        this.parent[at] = this.parent[at + 1] = at + 2
        this.normalize(at + 2)
      } else {
        this.parent[at] = ROOT
        this.weight[at + 1] = 1
        this.parent[at + 1] = ROOT
        this.child[at + 1] = 0xffffffff
        this.weight[ROOT] = 2
        this.child[ROOT] = at
      }
    } else {
      // A length tree can exceed 256 distinct values. Native replaces the
      // least-weight non-escape leaf, without changing its weight/topology.
      const at = this.child[this.start] === 0xffffffff ? this.start + 1 : this.start
      this.child[at] = (LEAF | code) >>> 0
    }
    this.work.value++
  }
  private rebuild(): void {
    let next = ROOT
    for (let at = ROOT - 1; at >= this.start; at--) {
      if (this.child[at]! & LEAF) {
        this.weight[at] = (this.weight[at]! + 1) >>> 1
        this.copy(next--, at)
      }
      this.work.value++
    }
    next++
    for (let at = this.start; at < ROOT; at += 2) {
      if (next < at || next + 1 > ROOT) treeBounds()
      this.copy(at, next)
      this.copy(at + 1, next + 1)
      next += 2
      this.reparent(at, at)
      this.reparent(at + 1, at + 1)
      const weight = this.weight[at]! + this.weight[at + 1]!
      if (next <= ROOT) {
        let insert = next
        while (insert <= ROOT && weight > this.weight[insert]!) {
          this.copy(insert - 1, insert)
          insert++
          this.work.value++
        }
        this.weight[insert - 1] = weight
        this.child[insert - 1] = at
        next--
      } else {
        this.weight[ROOT] = weight
        this.parent[ROOT] = NIL
        this.child[ROOT] = at
        this.parent[at] = this.parent[at + 1] = ROOT
        return
      }
    }
    treeBounds()
  }
  private increase(at: number): void {
    this.weight[at] = this.weight[at]! + 1
    this.normalize(at)
    if (this.weight[ROOT]! >= MAX_WEIGHT) this.rebuild()
  }
  /** New byte symbols use GetNBits(8), including its original partial-byte
   * EOF behavior; new run lengths use gamma and retain its explicit failure. */
  read(bits: EriBitSource, length = false): number {
    if (this.start < ROOT) {
      let child = this.child[ROOT]!, at = ROOT, depth = 0
      do {
        if (child >= ROOT || depth++ > ROOT) treeBounds()
        const bit = bits.next()
        if (bit < 0) return ESCAPE
        at = child + bit
        child = this.child[at]!
        this.work.value++
      } while (!(child & LEAF))
      this.increase(at)
      const code = child & ESCAPE
      if (code !== ESCAPE) return code
    }
    const code = length ? bits.gamma() : bits.take(8)
    if (code < 0) return ESCAPE
    this.add(code)
    return code
  }
}

/** Context is the previous unsigned byte. Zero uses a separate adaptive
 * length tree, and its unconsumed run/context persist across image blocks. */
export class EriHuffmanData {
  private readonly trees: (EriHuffmanTree | undefined)[] = new Array(257)
  private context = 0
  private remaining = 0
  constructor(private readonly bits: EriBitSource, private readonly work: EriHuffmanWork) {}
  private tree(context: number): EriHuffmanTree {
    let tree = this.trees[context]
    if (!tree) this.trees[context] = tree = new EriHuffmanTree(this.work)
    return tree
  }
  *read(output: Int32Array, pendingZeros?: number): Generator<void> {
    // Frame 9 shares the native run-length field with the preceding DC reader.
    if (pendingZeros !== undefined) this.remaining = pendingZeros
    let at = 0
    while (at < output.length) {
      if (this.remaining) {
        const count = Math.min(this.remaining, output.length - at, 4096)
        output.fill(0, at, at + count)
        at += count
        this.remaining -= count
        this.work.value += count
      } else {
        const symbol = this.tree(this.context).read(this.bits)
        if (symbol === ESCAPE) failed()
        output[at++] = (symbol << 24) >> 24
        if (symbol === 0) {
          const length = this.tree(256).read(this.bits, true)
          if (length === ESCAPE) {
            // Native counts the literal zero before trying its run suffix.
            // A missing suffix after the very last sample still completes
            // this block; it must not expose a partial earlier block.
            if (at !== output.length) failed()
            return
          }
          if (length < 1) failed()
          this.remaining = length - 1
        }
        this.context = symbol & 255
        this.work.value++
      }
      if (this.work.value >= 4096) { this.work.value = 0; yield }
    }
  }
  /** Palette coding has no zero-special case. A run suffix follows the
   * second consecutive occurrence of any byte; only that comparison state
   * resets at row start, while the adaptive trees/context remain live. */
  *readPalette(output: Uint8Array): Generator<void> {
    let at = 0, previous = ESCAPE
    while (at < output.length) {
      const symbol = this.tree(this.context).read(this.bits)
      if (symbol === ESCAPE) failed()
      output[at++] = symbol
      if (previous === symbol) {
        const length = this.tree(256).read(this.bits, true)
        if (length === ESCAPE) {
          if (at !== output.length) failed()
          return
        }
        const repeat = length - 1
        // The scalar source writes beyond the row for oversized repeats;
        // the x86 path stops at its own bound. Do not reproduce unsafe writes
        // or pretend this Web safety restriction is a native format error.
        if (repeat < 0 || repeat > output.length - at)
          throw new Error('ERI Huffman repeat exceeds the safe row bounds')
        output.fill(symbol, at, at + repeat)
        at += repeat
        this.work.value += repeat
      }
      previous = symbol
      this.context = symbol & 255
      this.work.value++
      if (this.work.value >= 4096) { this.work.value = 0; yield }
    }
  }
}

export function* decodeEriHuffmanIndices(bits: EriBitSource, width: number, height: number): Generator<void, Uint8Array> {
  // Include both this private index plane and the eventual four-byte output
  // in the same existing work budget, plus worst-case lazy adaptive trees.
  if (width * height * 5 + ERI_HUFFMAN_BYTES > 96 * 1024 * 1024)
    throw new Error('ERI palette exceeds the 96 MiB owned work budget')
  const plane = new Uint8Array(width * height), work = { value: 0 }, data = new EriHuffmanData(bits, work)
  for (let y = 0; y < height; y++) {
    yield* data.readPalette(plane.subarray(y * width, (y + 1) * width))
    yield
  }
  return plane
}

export function readEriOperation(tree: EriHuffmanTree, bits: EriBitSource): number {
  // GetAHuffmanCode's failure sentinel is cast to BYTE for table mode and
  // masked to its low eight bits by PerformOperation for interleaved mode.
  return tree.read(bits) & 255
}
