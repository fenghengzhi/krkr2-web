import type { ByteSource } from '../../engine/ports/storage.ts'
import type { DiscEntry, DiscFilesystem } from './filesystem.ts'
import { discPathParts, foldDiscName } from './path.ts'
import type { TrackReader } from './track.ts'
import { readAllocatedRuns, descriptor, parseFileEntry, longAddress, mappedExtent, runIndex, udfBlock, udfError, UdfFormatError, viewOf,
  type IcbAddress, type UdfRun } from './udf-allocation.ts'
import { readUdfVolume, udfText, type UdfVolume } from './udf-volume.ts'

interface Node { type: number; source: ByteSource; runs: UdfRun[]; icb: IcbAddress; embedded: boolean }
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

function extentSource(reader: TrackReader, size: number, runs: UdfRun[], inline?: Uint8Array): ByteSource {
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

  get label(): string { return this.volume.label }

  private async node(icb: IcbAddress): Promise<Node> {
    const block = mappedExtent(this.volume.partitions, icb, udfBlock).physical, cached = this.nodes.get(block)
    if (cached) return cached
    const bytes = await this.reader.read(block * udfBlock, udfBlock)
    const { mode, type, size, allocation, embedded } = parseFileEntry(bytes, icb.block)
    const inline = embedded ? allocation.slice(0, size) : undefined
    const runs = embedded ? [] : await readAllocatedRuns(this.reader, this.volume.partitions, allocation, mode, icb.partition, size)
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

export async function openUdfVolume(reader: TrackReader, begin: number): Promise<(DiscFilesystem & { readonly label: string }) | undefined> {
  const volume = await readUdfVolume(reader, begin)
  if (!volume) return
  const fs = new UdfFilesystem(reader, volume)
  const loadMirror = volume.mirror
  if (!loadMirror) { await fs.openRoot(); return fs }
  let mirror: Promise<UdfFilesystem> | undefined
  const read = async <T>(operation: (copy: UdfFilesystem) => Promise<T>): Promise<T> => {
    try { return await operation(fs) }
    catch (error) {
      if (!(error instanceof UdfFormatError)) throw error
      mirror ??= loadMirror().then((copy) => new UdfFilesystem(reader, copy)).catch((failure: unknown) => {
        mirror = undefined
        throw failure
      })
      return operation(await mirror)
    }
  }
  await read((copy) => copy.openRoot())
  return { label: volume.label, file: (path) => read((copy) => copy.file(path)), list: (path) => read((copy) => copy.list(path)) }
}

/** A bridge advertises UDF in the recognition area adjoining the ISO
 * descriptors. A disc with an unreadable or unsupported UDF still has
 * its separately mountable ISO directory. Source I/O errors propagate. */
export async function openBridgedUdf(reader: TrackReader, after: number, terminated: boolean) {
  if (reader.size <= 256 * udfBlock) return
  for (let sector = after + 1; sector < Math.min(after + 65, reader.size / udfBlock); sector++) {
    const header = await reader.recognitionHeader(sector, 7)
    if (!header || header[6] !== 1) return
    const id = String.fromCharCode(...header.subarray(1, 6))
    if (id === 'BEA01' && header[0] === 0) {
      try { return await openUdfVolume(reader, sector) }
      catch (error) { if (!(error instanceof UdfFormatError)) throw error; return }
    }
    if (terminated || id !== 'CD001') return
    terminated = header[0] === 255
  }
}
