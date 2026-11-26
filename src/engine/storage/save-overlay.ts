import { MAX_SAVE_BYTES, MAX_SAVE_FILES, type SaveFile, type SaveStore } from '../ports/saves.ts'
import { validateNativeSavePaths } from './native-save-paths.ts'
import { normalizePath } from './resolver.ts'
import { parseStoragePath, storageWritePath } from './public-path.ts'
import type { Resource } from '../ports/storage.ts'
import { resourceReadBounds } from './resource-source.ts'

export class SaveOverlay {
  private files = new Map<string, Uint8Array>()
  private resources = new Map<string, Resource>()
  private dirty = new Map<string, number>()
  private gameWrites = new Set<string>()
  private revision = 0
  private readonly lastWrite = new Map<string, number>()
  private persistence?: Promise<void>
  private flushing?: Promise<void>
  private staged?: Map<string, Uint8Array>
  private nativeTargets?: Map<string, string>
  constructor(
    private readonly store: SaveStore,
    private readonly changed?: (path: string) => void,
    private readonly assertWritable?: (path: string) => void,
  ) {}
  private publish(path: string, owned: Uint8Array): void {
    this.files.set(path, owned)
    this.resources.set(path, {
      name: path,
      size: owned.length,
      cacheToken: {},
      source: {
        size: owned.length,
        read: async (offset, length) => {
          resourceReadBounds(owned.length, offset, length)
          return owned.slice(offset, offset + length)
        },
      },
      read: async () => owned.slice(),
    })
  }
  async initialize(): Promise<void> {
    const files = await this.store.load()
    for (const { path, bytes } of files) this.publish(normalizePath(path), Uint8Array.from(bytes))
  }
  get(path: string): Uint8Array | undefined {
    const found = this.locate(path)
    return found ? this.files.get(found)!.slice() : undefined
  }
  resource(path: string): Resource | undefined {
    const found = this.locate(path)
    return found ? this.resources.get(found) : undefined
  }
  locate(path: string): string | undefined {
    const name = parseStoragePath(path)
    if (!name || name.includes('>') || name.endsWith('/')) return undefined
    if (this.files.has(name)) return name
    const matches = [...this.files.keys()].filter(
      (path) => path.toLowerCase() === name.toLowerCase(),
    )
    if (matches.length > 1) throw new Error(`Ambiguous save path: ${name}`)
    return matches[0]
  }
  write(path: string, bytes: Uint8Array): void {
    this.writeFile(path, bytes, true)
  }
  writeDiagnostic(path: string, bytes: Uint8Array): void {
    this.writeFile(path, bytes, false)
  }
  private writeFile(path: string, bytes: Uint8Array, gameWrite: boolean): void {
    const requested = storageWritePath(path)
    const name = this.files.has(requested) ? requested : this.nativeTargets?.get(requested.toLowerCase()) ?? requested
    this.assertWritable?.(name)
    this.checkBudget(new Map([[name, bytes]]))
    if (this.staged) {
      if (this.nativeTargets && !this.staged.has(name)) validateNativeSavePaths([name], this.staged.keys())
      const next = new Map(this.staged)
      next.set(name, bytes)
      this.checkBudget(next)
      // A game write during the store transaction takes precedence in memory.
      this.staged.delete(name)
    }
    this.publish(name, Uint8Array.from(bytes))
    this.lastWrite.set(name, ++this.revision)
    this.dirty.set(name, this.revision)
    // A later diagnostic append must not demote an uncommitted game write.
    if (gameWrite) this.gameWrites.add(name)
    this.changed?.(name)
  }
  private checkBudget(overrides: ReadonlyMap<string, Uint8Array>): void {
    let total = 0
    for (const [name, bytes] of this.files) if (!overrides.has(name)) total += bytes.length
    for (const bytes of overrides.values()) total += bytes.length
    if (total > MAX_SAVE_BYTES) throw new Error('Save files exceed 64 MiB budget; export or remove old saves')
  }
  private committed(versions: Map<string, number>): void {
    for (const [path, version] of versions) if (this.dirty.get(path) === version) {
      this.dirty.delete(path)
      this.gameWrites.delete(path)
    }
  }
  private async persist(work: () => Promise<void>): Promise<void> {
    // Reserve before calling into a store, including a synchronous/reentrant
    // embedding. An idle flush starts its transaction in the caller's turn.
    const previous = this.persistence
    let release!: () => void
    const done = new Promise<void>((resolve) => { release = resolve })
    this.persistence = done
    try {
      if (previous) await previous
      await work()
    } finally {
      if (this.persistence === done) this.persistence = undefined
      release()
    }
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    if (!this.dirty.size) return this.persistence ?? Promise.resolve()
    const flush = this.persist(async () => {
      while (this.dirty.size) {
        const versions = new Map(this.dirty)
        await this.store.commit([...versions.keys()].map((path) => ({ path, bytes: this.files.get(path)!.slice() })))
        this.committed(versions)
      }
    })
    this.flushing = flush
    const completed = () => { if (this.flushing === flush) this.flushing = undefined }
    void flush.then(completed, completed)
    return flush
  }
  export(directory = ''): SaveFile[] {
    const files: SaveFile[] = [], prefix = directory.toLowerCase()
    const depth = directory.split('/').length - 1
    for (const [path, bytes] of this.files) if (path.toLowerCase().startsWith(prefix))
      files.push({ path: depth ? path.split('/').slice(depth).join('/') : path, bytes: bytes.slice() })
    return files
  }
  /** Directory UIs must not copy the save byte buffers to enumerate names. */
  list(): { name: string; size: number }[] {
    return [...this.files].map(([name, bytes]) => ({ name, size: bytes.length }))
  }
  async import(files: SaveFile[], directory?: string): Promise<void> {
    if (!Array.isArray(files) || files.length > MAX_SAVE_FILES) throw new Error('Save import exceeds file count limit')
    const entries: SaveFile[] = [], seen = new Set<string>()
    let total = 0
    for (const { path, bytes } of files) {
      if (path.includes('>')) throw new Error('Archive storage is read-only')
      const name = normalizePath(path), key = directory === undefined ? name : name.toLowerCase()
      if (directory !== undefined && name !== path) throw new Error('Invalid relative save path: ' + path)
      if (seen.has(key)) throw new Error('Duplicate file in save backup')
      if (!(bytes instanceof Uint8Array)) throw new Error('Invalid save bytes')
      if ((total += bytes.length) > MAX_SAVE_BYTES) throw new Error('Save import exceeds budget')
      seen.add(key)
      entries.push({ path: (directory ?? '') + name, bytes: Uint8Array.from(bytes) })
    }
    const submitted = this.revision
    this.flushing = undefined // A subsequent flush must wait for this import as well.
    await this.persist(async () => {
      const staged = new Map<string, Uint8Array>(), folded = new Map<string, string | null>()
      if (directory !== undefined) for (const path of this.files.keys()) {
        const key = path.toLowerCase()
        folded.set(key, folded.has(key) ? null : path)
      }
      for (const entry of entries) {
        const existing = folded.get(entry.path.toLowerCase())
        if (existing === null && !this.files.has(entry.path)) throw new Error('Ambiguous save path: ' + entry.path)
        const path = this.files.has(entry.path) ? entry.path : existing ?? entry.path
        this.assertWritable?.(path)
        if ((this.lastWrite.get(path) ?? 0) <= submitted) staged.set(path, entry.bytes)
      }
      if (directory !== undefined) validateNativeSavePaths(staged.keys(), this.files.keys())
      this.checkBudget(staged)
      const versions = new Map(this.dirty), batch = new Map<string, Uint8Array>()
      for (const path of versions.keys()) batch.set(path, this.files.get(path)!)
      for (const [path, bytes] of staged) batch.set(path, bytes)
      this.staged = staged
      if (directory !== undefined) this.nativeTargets = new Map([...staged.keys()].map((path) => [path.toLowerCase(), path]))
      try {
        // IndexedDB commits all slots in one transaction. Only publish to the
        // running game after success; keep later ordinary writes dirty.
        if (batch.size) await this.store.commit([...batch].map(([path, bytes]) => ({ path, bytes: bytes.slice() })))
        for (const [path, bytes] of staged) this.publish(path, bytes)
        this.committed(versions)
        for (const path of staged.keys()) this.changed?.(path)
      } finally {
        this.staged = undefined
        this.nativeTargets = undefined
      }
    })
  }
  get pending(): number {
    return this.dirty.size
  }
  get hasPendingGameWrites(): boolean {
    return this.gameWrites.size > 0
  }
  get count(): number {
    return this.files.size
  }
  size(path: string): number {
    return this.files.get(path)?.length ?? 0
  }
  close(): void {
    this.store.close()
  }
}
