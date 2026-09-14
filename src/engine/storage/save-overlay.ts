import type { SaveFile, SaveStore } from '../ports/saves.ts'
import { normalizePath } from './resolver.ts'
import type { Resource } from '../ports/storage.ts'

export class SaveOverlay {
  private files = new Map<string, Uint8Array>()
  private resources = new Map<string, Resource>()
  private dirty = new Map<string, number>()
  private gameWrites = new Set<string>()
  private revision = 0
  private flushing?: Promise<void>
  constructor(
    private readonly store: SaveStore,
    private readonly changed?: (path: string) => void,
  ) {}
  private replace(path: string, bytes: Uint8Array): void {
    const owned = bytes.slice()
    this.files.set(path, owned)
    this.resources.set(path, {
      name: path,
      size: owned.length,
      cacheToken: {},
      read: async () => owned.slice(),
    })
  }
  async initialize(): Promise<void> {
    const files = await this.store.load()
    for (const { path, bytes } of files) this.replace(normalizePath(path), bytes)
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
    if (path.includes('>')) return undefined
    const name = normalizePath(path)
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
    if (path.includes('>')) throw new Error('Archive storage is read-only')
    const name = normalizePath(path)
    let size = bytes.length
    for (const [existing, value] of this.files) if (existing !== name) size += value.length
    if (size > 64 * 1024 * 1024)
      throw new Error('Save files exceed 64 MiB budget; export or remove old saves')
    this.replace(name, bytes)
    this.dirty.set(name, ++this.revision)
    // A later diagnostic append must not demote an uncommitted game write.
    if (gameWrite) this.gameWrites.add(name)
    this.changed?.(name)
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      while (this.dirty.size) {
        const versions = [...this.dirty]
        await this.store.commit(
          versions.map(([path]) => ({ path, bytes: this.files.get(path)!.slice() })),
        )
        for (const [path, version] of versions)
          if (this.dirty.get(path) === version) {
            this.dirty.delete(path)
            this.gameWrites.delete(path)
          }
      }
    })().finally(() => {
      this.flushing = undefined
    })
    return this.flushing
  }
  export(): SaveFile[] {
    return [...this.files].map(([path, bytes]) => ({ path, bytes: bytes.slice() }))
  }
  async import(files: SaveFile[]): Promise<void> {
    // Validate a complete backup before mutating the running overlay.
    const normalized = files.map(({ path, bytes }) => {
      if (path.includes('>')) throw new Error('Archive storage is read-only')
      return { path: normalizePath(path), bytes: bytes.slice() }
    })
    const names = new Set(normalized.map((file) => file.path))
    if (names.size !== normalized.length) throw new Error('Duplicate file in save backup')
    let size = normalized.reduce((sum, file) => sum + file.bytes.length, 0)
    for (const [path, value] of this.files) if (!names.has(path)) size += value.length
    if (size > 64 * 1024 * 1024) throw new Error('Save import exceeds budget')
    for (const file of normalized) this.write(file.path, file.bytes)
    await this.flush()
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
