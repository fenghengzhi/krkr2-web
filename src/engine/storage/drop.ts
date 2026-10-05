import { dropLimits, type DropResourceTree, type DropRoot } from '../ports/storage-drop.ts'
import { MAX_RESOURCE_BYTES, type ByteSource, type Resource } from '../ports/storage.ts'
import { normalizeResourcePath, toPublicStoragePath } from './public-path.ts'
import { resourceReadBounds } from './resource-source.ts'
import { StorageResolver } from './resolver.ts'

interface SnapshotEntry { root: number; path: string; kind: 'file' | 'directory'; source?: ByteSource }
interface Charge { files: number; directories: number; bytes: number; units: number }
const empty = (): Charge => ({ files: 0, directories: 0, bytes: 0, units: 0 })
export function dropBasename(name: unknown): string {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/>\0]/.test(name) ||
      name.length > dropLimits.pathUnits || normalizeResourcePath(name) !== name)
    throw new Error('Dropped entry has an invalid name')
  return name
}
function relative(value: unknown): string {
  if (typeof value !== 'string' || value.length > dropLimits.pathUnits || /[\\>\0]/.test(value))
    throw new Error('Dropped entry has an invalid relative path')
  if (!value) return ''
  const parts = value.split('/')
  if (parts.length > dropLimits.depth) throw new Error('Dropped directory exceeds depth limit')
  for (const part of parts) dropBasename(part)
  return value
}

/** Runtime capabilities are admitted as one immutable, read-only namespace.
 * Pending metadata never enters the resolver. Actual ByteSource reads own
 * their read-budget reservation until the provider settles, even after Stop. */
export class DropStorage {
  private disposed = false
  private serial = 0
  private batches = 0
  private retained = empty()
  private pending = new Set<Charge>()
  private reads = 0
  private readBytes = 0
  private waiters = new Set<(error: unknown) => void>()
  constructor(private readonly resolver: StorageResolver,
    private readonly savedNames: () => readonly string[],
    private readonly checkpoint: () => Promise<void>) {}

  private check(valid?: () => boolean): void {
    if (this.disposed) throw new Error('Dropped storage is disposed')
    if (valid && !valid()) throw new Error('Drop destination is no longer available')
  }
  private total(): Charge {
    const result = { ...this.retained }
    for (const charge of this.pending) {
      result.files += charge.files; result.directories += charge.directories
      result.bytes += charge.bytes; result.units += charge.units
    }
    return result
  }
  private reserve(charge: Charge): void {
    const total = this.total()
    if (this.batches + this.pending.size >= dropLimits.batches ||
        total.files + charge.files > dropLimits.files || total.directories + charge.directories > dropLimits.directories ||
        total.bytes + charge.bytes > dropLimits.sourceBytes || total.units + charge.units > dropLimits.sessionNameUnits)
      throw new Error('Dropped resources exceed Session budget')
    this.pending.add(charge)
  }
  private wait<T>(work: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = (error: unknown) => { this.waiters.delete(cancel); reject(error) }
      this.waiters.add(cancel)
      void work.then((value) => { this.waiters.delete(cancel); resolve(value) },
        (error) => { this.waiters.delete(cancel); reject(error) })
      // A provider or checkpoint may synchronously reenter Stop before this
      // wait is installed. Still observe the already-started operation.
      if (this.disposed) cancel(new Error('Dropped storage is disposed'))
    })
  }
  private async read(source: ByteSource, offset: number, length: number): Promise<Uint8Array> {
    this.check(); resourceReadBounds(source.size, offset, length)
    if (this.reads >= dropLimits.pendingReads || this.readBytes + length > dropLimits.pendingReadBytes)
      throw new Error('Dropped resource read budget exceeded')
    this.reads++; this.readBytes += length
    const actual = (async () => {
      try {
        const bytes = await source.read(offset, length)
        this.check()
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length)
          throw new Error('Dropped resource returned an invalid range')
        return bytes
      } finally { this.reads--; this.readBytes -= length }
    })()
    return this.wait(actual)
  }
  async commit(tree: DropResourceTree, valid: () => boolean): Promise<string[]> {
    this.check(valid)
    if (!tree || !Array.isArray(tree.roots) || !Array.isArray(tree.entries) ||
        tree.roots.length > dropLimits.roots || tree.entries.length > dropLimits.entries)
      throw new Error('Dropped tree exceeds entry budget')
    // Capture all caller-owned metadata and source methods before the first
    // await. Mutating the request later cannot redirect an admitted source.
    const roots: DropRoot[] = tree.roots.map((root) => {
      if (!root || root.kind !== 'file' && root.kind !== 'directory') throw new Error('Invalid dropped root kind')
      return { kind: root.kind, name: dropBasename(root.name) }
    }), entries: SnapshotEntry[] = tree.entries.map((entry) => {
      if (!entry || !Number.isSafeInteger(entry.root) || entry.root < 0 || entry.root >= roots.length ||
          entry.kind !== 'file' && entry.kind !== 'directory') throw new Error('Invalid dropped tree entry')
      const path = relative(entry.path)
      if (entry.kind === 'directory') return { root: entry.root, path, kind: 'directory' }
      const source = entry.source, size = source?.size
      if (!source || !Number.isSafeInteger(size) || size < 0 || size > dropLimits.sourceBytes || typeof source.read !== 'function')
        throw new Error('Invalid dropped file capability')
      return { root: entry.root, path, kind: 'file', source: { size, read: source.read.bind(source) } }
    }), byName = new Map<string, SnapshotEntry>(), charge = empty()
    let batchUnits = roots.reduce((sum, root) => sum + root.name.length, 0)
    for (const entry of entries) {
      const key = entry.root + ':' + entry.path
      if (byName.has(key)) throw new Error('Duplicate dropped entry')
      byName.set(key, entry)
      batchUnits += entry.path.length
      if (entry.kind === 'file') { charge.files++; charge.bytes += entry.source!.size }
      else charge.directories++
    }
    if (batchUnits > dropLimits.batchNameUnits || charge.bytes > dropLimits.sourceBytes)
      throw new Error('Dropped batch exceeds source or name budget')
    for (let index = 0; index < roots.length; index++) {
      const rootEntry = byName.get(index + ':')
      if (!rootEntry || rootEntry.kind !== roots[index]!.kind) throw new Error('Dropped root metadata is incomplete')
    }
    for (const entry of entries) {
      if (!entry.path) continue
      const at = entry.path.lastIndexOf('/'), parent = at < 0 ? '' : entry.path.slice(0, at)
      if (byName.get(entry.root + ':' + parent)?.kind !== 'directory')
        throw new Error('Dropped directory metadata is incomplete')
    }
    if (!roots.length) return []
    let prefix: string, collisions = 0
    do {
      if (++this.serial > 1000000) throw new Error('Drop namespace identity exhausted')
      prefix = `.krkr-drop-${this.serial}/`
      if (!this.resolver.hasTree(prefix, this.savedNames())) break
      if (!(++collisions % 16)) { await this.wait(this.checkpoint()); this.check(valid) }
    } while (true)
    const names = roots.map((root, index) => prefix + index + '/' + root.name),
      directories = new Set<string>([prefix]), resources: Resource[] = []
    for (let index = 0; index < roots.length; index++) directories.add(prefix + index + '/')
    for (const entry of entries) {
      const name = names[entry.root]! + (entry.path ? '/' + entry.path : '')
      if (name.length + 'game://./'.length + (entry.kind === 'directory' ? 1 : 0) > dropLimits.pathUnits)
        throw new Error('Dropped public path exceeds 4096 characters')
      if (entry.kind === 'directory') directories.add(name + '/')
      else {
        const original = entry.source!, source: ByteSource = {
          size: original.size, read: (offset, length) => this.read(original, offset, length),
        }
        resources.push({ name, size: source.size, source, cacheToken: {}, archiveAliases: false,
          read: () => {
            if (source.size > MAX_RESOURCE_BYTES) return Promise.reject(new Error('Dropped resource exceeds complete-read budget'))
            return source.read(0, source.size)
          },
        })
      }
    }
    charge.directories = directories.size
    charge.units = [...directories].reduce((sum, name) => sum + name.length, 0) + resources.reduce((sum, resource) => sum + resource.name.length, 0)
    this.reserve(charge)
    try {
      for (let index = 0; index <= entries.length; index += 256) {
        await this.wait(this.checkpoint()); this.check(valid)
      }
      // No await or application callback occurs between the final collision
      // check and publication. A racing save is retained and rejects the drop.
      this.check(valid)
      if (this.resolver.hasTree(prefix, this.savedNames())) throw new Error('Drop namespace collided before commit')
      this.resolver.mount(resources, { directories: [...directories], readonlyRoots: [prefix] })
      this.batches++
      this.retained.files += charge.files; this.retained.directories += charge.directories
      this.retained.bytes += charge.bytes; this.retained.units += charge.units
      return names.map((name, index) => toPublicStoragePath(name + (roots[index]!.kind === 'directory' ? '/' : '')))
    } finally { this.pending.delete(charge) }
  }
  inspect() {
    return { batches: this.batches, ...this.retained, pendingBatches: this.pending.size,
      pendingReads: this.reads, pendingReadBytes: this.readBytes }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const error = new Error('Dropped storage is disposed')
    for (const cancel of this.waiters) cancel(error)
    this.pending.clear(); this.retained = empty(); this.batches = 0
    // Actual in-flight provider promises retain and eventually release the
    // read counters. Dropping them here would make cancellation undercount IO.
  }
}
