import type { ByteSource } from '../../engine/ports/storage.ts'
import type { DiscEntry, DiscFilesystem } from './filesystem.ts'
import { discPathParts, foldDiscName } from './path.ts'
import type { TrackReader } from './track.ts'
import { descriptor, longAddress, mappedExtent, readUdfVolume, udfBlock, udfError, udfText, viewOf,
  type IcbAddress, type UdfVolume } from './udf-volume.ts'

interface Run { offset: number; length: number; block: number; physical?: number }
interface Node { type: number; source: ByteSource; runs: Run[]; icb: IcbAddress; embedded: boolean }
interface Child { name: string; icb: IcbAddress; directory: boolean }

// Readers may retain an individual file view independently of either cache.
// Only metadata and embedded bytes are charged here, never a DVD payload.
class MetadataCache<T> {
  private readonly entries = new Map<number, { value: T; bytes: number }>()
  private bytes = 0
  get(key: number): T | undefined {
    const item = this.entries.get(key)
    if (item) { this.entries.delete(key); this.entries.set(key, item) }
    return item?.value
  }
  save(key: number, value: T, bytes: number): T {
    const existing = this.get(key)
    if (existing !== undefined) return existing
    const limit = 16 * 1024 * 1024
    if (bytes > limit) return value
    while (this.entries.size >= 4096 || this.bytes + bytes > limit) {
      const oldest = this.entries.keys().next().value!
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest)
    }
    this.entries.set(key, { value, bytes }); this.bytes += bytes
    return value
  }
}

function readBounds(size: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > size || length > size - offset)
    udfError('read outside file')
}

function runIndex(runs: Run[], offset: number): number {
  let low = 0, high = runs.length
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (runs[middle]!.offset <= offset) low = middle
    else high = middle
  }
  return low
}

function extentSource(reader: TrackReader, size: number, runs: Run[], inline?: Uint8Array): ByteSource {
  const source: ByteSource = { size, async read(offset, length) {
    readBounds(size, offset, length)
    if (length > 64 * 1024 * 1024) return udfError('single file read exceeds 64 MiB')
    if (inline) return inline.slice(offset, offset + length)
    const out = new Uint8Array(length)
    let written = 0
    for (let i = runIndex(runs, offset); written < length; i++) {
      const run = runs[i]!, within = offset + written - run.offset
      const take = Math.min(length - written, run.length - within)
      if (run.physical !== undefined) {
        for (let at = 0; at < take; at += 65536) {
          const bytes = await reader.read(run.physical + within + at, Math.min(65536, take - at))
          out.set(bytes, written + at)
        }
      }
      written += take
    }
    return out
  } }
  if (!inline && reader.canBorrow && runs.every((run) => run.physical !== undefined))
    source.borrowBlob = reader.fileBorrower(runs.map((run) => ({ start: run.physical!, size: run.length })))
  return source
}

class UdfFilesystem implements DiscFilesystem {
  private readonly nodes = new MetadataCache<Node>()
  private readonly dirs = new MetadataCache<Map<string, Child>>()
  constructor(private readonly reader: TrackReader, private readonly volume: UdfVolume) {}

  private *mappedRuns(address: IcbAddress, length: number) {
    for (let offset = 0; offset < length;) {
      const block = address.block + offset / udfBlock
      const span = mappedExtent(this.volume.partitions, { partition: address.partition, block }, length - offset)
      yield { ...span, block, offset }
      offset += span.bytes
    }
  }

  private async allocated(start: Uint8Array, mode: number, partition: number, size: number): Promise<Run[]> {
    if (mode !== 0 && mode !== 1) return udfError('unsupported allocation descriptor type')
    const width = mode === 0 ? 8 : 16, seen = new Set<number>(), runs: Run[] = []
    let table = start, written = 0, count = 0
    for (;;) {
      if (table.length % width !== 0) return udfError('incomplete allocation descriptor')
      const view = viewOf(table)
      let continuation: Uint8Array | undefined
      for (let at = 0; at < table.length; at += width) {
        if (++count > 65536) return udfError('too many allocation descriptors')
        const raw = view.getUint32(at, true), length = raw & 0x3fffffff, kind = raw >>> 30
        if (!length) break
        const address = { block: view.getUint32(at + 4, true), partition: mode === 0 ? partition : view.getUint16(at + 8, true) }
        if (kind === 3) {
          if (at + width !== table.length || length < 24 || length > 1024 * 1024 || seen.size >= 1024)
            return udfError('invalid allocation extent continuation')
          const bytes = new Uint8Array(length)
          for (const run of this.mappedRuns(address, length)) {
            if (run.offset === 0) {
              if (seen.has(run.physical)) return udfError('repeated allocation extent continuation')
              seen.add(run.physical)
            }
            bytes.set(await this.reader.read(run.physical * udfBlock, run.bytes), run.offset)
          }
          const next = descriptor(bytes, address.block), fields = next.getUint32(20, true)
          if (next.getUint16(0, true) !== 258 || fields > bytes.length - 24) return udfError('bad allocation extent descriptor')
          continuation = bytes.subarray(24, 24 + fields)
        } else {
          if (!Number.isSafeInteger(written + length)) return udfError('file length exceeds exact byte offsets')
          const visible = Math.min(length, size - written)
          if (kind === 0) {
            for (const run of this.mappedRuns(address, length)) {
              if (run.offset >= visible) break
              runs.push({ offset: written + run.offset, length: Math.min(run.bytes, visible - run.offset),
                block: run.block, physical: run.physical * udfBlock })
              if (runs.length > 131072) return udfError('too many recorded file extents')
            }
          } else {
            // An allocated but unrecorded extent has an address. A sparse
            // unallocated extent has none. Both return zero bytes to the game.
            if (kind === 1) mappedExtent(this.volume.partitions, address, length)
            if (visible > 0) runs.push({ offset: written, length: visible, block: address.block })
          }
          written += length
        }
      }
      if (!continuation) break
      table = continuation
    }
    if (written < size) return udfError('file allocation is shorter than its information length')
    return runs
  }

  private async node(icb: IcbAddress): Promise<Node> {
    const block = mappedExtent(this.volume.partitions, icb, udfBlock).physical, cached = this.nodes.get(block)
    if (cached) return cached
    const bytes = await this.reader.read(block * udfBlock, udfBlock), view = descriptor(bytes, icb.block)
    const id = view.getUint16(0, true), type = bytes[27]!, mode = view.getUint16(34, true) & 7
    if ((id !== 261 && id !== 266) || view.getUint16(20, true) !== 4)
      return udfError('expected a direct file entry or extended file entry')
    const base = id === 261 ? 176 : 216, start = base + view.getUint32(base - 8, true), length = view.getUint32(base - 4, true)
    const size = Number(view.getBigUint64(56, true))
    if (!Number.isSafeInteger(size) || start + length > bytes.length) return udfError('invalid file entry lengths')
    const allocation = bytes.subarray(start, start + length), embedded = mode === 3
    if (embedded && size > allocation.length) return udfError('truncated embedded file')
    const inline = embedded ? allocation.slice(0, size) : undefined
    const runs = embedded ? [] : await this.allocated(allocation, mode, icb.partition, size)
    return this.nodes.save(block, { icb, type, embedded, runs, source: extentSource(this.reader, size, runs, inline) },
      224 + runs.length * 64 + (inline?.length ?? 0))
  }

  private async directory(node: Node): Promise<Map<string, Child>> {
    const block = mappedExtent(this.volume.partitions, node.icb, udfBlock).physical, cached = this.dirs.get(block)
    if (cached) return cached
    if (node.source.size > 8 * 1024 * 1024) return udfError('directory exceeds 8 MiB')
    const bytes = await node.source.read(0, node.source.size), view = viewOf(bytes), entries = new Map<string, Child>()
    let charge = 128, count = 0
    for (let at = 0; at < bytes.length;) {
      if (++count > 65536 || bytes.length - at < 38) return udfError('invalid directory length or record count')
      const chars = bytes[at + 18]!, nameBytes = bytes[at + 19]!, impl = view.getUint16(at + 36, true)
      const length = Math.ceil((38 + impl + nameBytes) / 4) * 4
      if (length > udfBlock || length > bytes.length - at) return udfError('incomplete file identifier')
      let location = node.icb.block
      if (!node.embedded) {
        const run = node.runs[runIndex(node.runs, at)]!
        if (run.physical === undefined) return udfError('unrecorded directory')
        location = run.block + Math.floor((at - run.offset) / udfBlock)
      }
      const fid = descriptor(bytes.subarray(at, at + length), location)
      if (fid.getUint16(0, true) !== 257) return udfError('expected a file identifier descriptor')
      if (!(chars & (4 | 8))) { // deleted or parent directory
        const name = udfText(bytes.subarray(at + 38 + impl, at + 38 + impl + nameBytes))
        if (!name || /[\0\\/]/.test(name) || name === '.' || name === '..') return udfError('invalid file name')
        const key = foldDiscName(name)
        if (!entries.has(key)) {
          entries.set(key, { name, icb: longAddress(fid, 20), directory: !!(chars & 2) })
          charge += 144 + 4 * name.length
        }
      }
      at += length
    }
    return this.dirs.save(block, entries, charge)
  }

  private async lookup(path: string): Promise<Node | undefined> {
    let node = await this.node(this.volume.root)
    if (node.type !== 4) return udfError('file set root is not a directory')
    for (const part of discPathParts(path)) {
      if (node.type !== 4) return
      const child = (await this.directory(node)).get(foldDiscName(part))
      if (!child) return
      node = await this.node(child.icb)
    }
    return node
  }
  async file(path: string): Promise<ByteSource | undefined> {
    const node = await this.lookup(path)
    return node?.type === 5 ? node.source : undefined
  }
  async list(path = ''): Promise<readonly DiscEntry[] | undefined> {
    const dir = await this.lookup(path)
    if (!dir || dir.type !== 4) return
    const result: DiscEntry[] = []
    for (const child of (await this.directory(dir)).values()) {
      const node = await this.node(child.icb)
      if (node.type !== 4 && node.type !== 5) continue // Device nodes and links are not game resources.
      if ((node.type === 4) !== child.directory) return udfError('inconsistent directory flag')
      result.push({ name: child.name, directory: child.directory, size: node.source.size })
    }
    return result
  }
  async openRoot(): Promise<void> { await this.lookup('') }
}

export async function openUdfVolume(reader: TrackReader, begin: number): Promise<DiscFilesystem | undefined> {
  const volume = await readUdfVolume(reader, begin)
  if (!volume) return
  const fs = new UdfFilesystem(reader, volume)
  await fs.openRoot()
  return fs
}
