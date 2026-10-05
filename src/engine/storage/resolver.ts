import type { ArchiveReader, Resource } from '../ports/storage.ts'
import { StorageArchives, type OpenArchive } from './archives.ts'

import { normalizeResourcePath, parseStoragePath, storageDirectoryPath } from './public-path.ts'

// Kept as the strict relative import/key boundary for existing callers.
export const normalizePath = normalizeResourcePath

export function normalizeStorageName(input: string, directory = false): string {
  const delimiter = input.indexOf('>')
  if (delimiter < 0) return normalizePath(input)
  if (input.indexOf('>', delimiter + 1) >= 0)
    throw new Error('Nested archive addresses are not supported')
  const archive = normalizePath(input.slice(0, delimiter))
  const entry = input.slice(delimiter + 1)
  return archive + '>' + (directory && !entry ? '' : normalizePath(entry))
}

export class StorageResolver {
  private readonly archives: StorageArchives
  private revision = 0
  private disposed = false
  private autoTable?: { revision: number; entries: Map<string, string> }
  constructor(readonly currentDirectory = '', private readonly archiveAliases = true,
    private readonly reader?: ArchiveReader, private readonly checkpoint: () => Promise<void> = async () => {}) {
    this.archives = new StorageArchives(reader, checkpoint, () => ({
      entries: 250000 - this.files.size - this.aliases.size,
      units: 16 * 1024 * 1024 - [...this.files.keys(), ...this.aliases.keys()].reduce((sum, name) => sum + name.length, 0),
    }))
  }
  private files = new Map<string, Resource>()
  private folded = new Map<string, Set<string>>()
  private aliases = new Map<string, string>()
  private foldedAliases = new Map<string, Set<string>>()
  private autoPaths: string[] = []
  mount(resources: Resource[]): void {
    // Validate the entire mount before mutating the active namespace.
    const prepared = resources.map((resource) => ({
      resource,
      name: normalizeStorageName(resource.name),
      aliasOf: resource.aliasOf === undefined ? undefined : normalizeStorageName(resource.aliasOf),
    }))
    const available = new Set([...this.files.keys(), ...prepared.filter((entry) => entry.aliasOf === undefined).map((entry) => entry.name)])
    const aliasNames = new Set([...this.aliases.keys(), ...prepared.filter((entry) => entry.aliasOf !== undefined).map((entry) => entry.name)])
    if (available.size + aliasNames.size > 250000 ||
        [...available, ...aliasNames].reduce((sum, name) => sum + name.length, 0) > 16 * 1024 * 1024)
      throw new Error('Mount exceeds namespace metadata budget')
    for (const { name, aliasOf } of prepared) {
      if (aliasOf !== undefined && (!aliasOf.includes('>') || name.includes('>') ||
          name !== aliasOf.slice(aliasOf.indexOf('>') + 1) || !available.has(aliasOf)))
        throw new Error(`Invalid archive compatibility alias: ${name}`)
    }
    for (const { resource, name, aliasOf } of prepared) {
      if (aliasOf === undefined) this.files.set(name, { ...resource, name, cacheToken: {} })
      else this.aliases.set(name, aliasOf)
      const table = aliasOf === undefined ? this.folded : this.foldedAliases,
        folded = name.toLowerCase(), names = table.get(folded) ?? new Set<string>()
      names.add(name)
      table.set(folded, names)
    }
    this.invalidateSearch()
    this.archives.trim()
  }
  addAutoPath(path: string): void {
    const normalized = storageDirectoryPath(path, this.currentDirectory)
    if (!this.autoPaths.includes(normalized)) this.autoPaths.push(normalized)
    this.invalidateSearch()
  }
  removeAutoPath(path: string): void {
    const normalized = storageDirectoryPath(path, this.currentDirectory)
    this.autoPaths = this.autoPaths.filter((path) => path !== normalized)
    this.invalidateSearch()
  }
  candidates(path: string): string[] {
    const normalized = parseStoragePath(path, this.currentDirectory)
    if (!normalized || /[/>]$/.test(normalized)) return [normalized]
    const basename = normalized.split(/[/>]/).at(-1)!
    return [
      normalized,
      ...this.autoPaths
        .slice()
        .reverse()
        .map((prefix) => prefix + basename),
    ]
  }
  find(path: string): Resource | undefined {
    const exact = this.files.get(path)
    if (exact) return exact
    const names = this.folded.get(path.toLowerCase())
    if (names?.size === 1) return this.files.get(names.values().next().value!)!
    if (names && names.size > 1) throw new Error(`Ambiguous resource name: ${path}`)
    return undefined
  }
  private fallback(path: string): Resource | undefined {
    if (!this.archiveAliases) return undefined
    const exact = this.aliases.get(path)
    if (exact !== undefined) return this.files.get(exact)
    const names = this.foldedAliases.get(path.toLowerCase())
    if (names?.size === 1) return this.files.get(this.aliases.get(names.values().next().value!)!)
    if (names && names.size > 1) throw new Error(`Ambiguous archive compatibility alias: ${path}`)
    return undefined
  }
  /** A package's bare import aliases are a Web startup convenience, not files
   * in the real current directory. They must not preempt KAG's patch paths.
   * Folder auto paths can still address the imported package's virtual root. */
  lookup(path: string, overlay?: (name: string) => Resource | undefined): Resource | undefined {
    const [direct, ...searched] = this.candidates(path),
      current = overlay?.(direct!) ?? this.find(direct!)
    if (current) return current
    for (const candidate of searched) {
      const resource = overlay?.(candidate) ?? this.find(candidate) ?? this.fallback(candidate)
      if (resource) return resource
    }
    return this.fallback(direct!)
  }
  resolve(path: string): Resource {
    const resource = this.lookup(path)
    if (resource) return resource
    throw new Error(`Resource not found: ${path}`)
  }
  exists(path: string): boolean {
    try {
      this.resolve(path)
      return true
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Resource not found:')) return false
      throw error
    }
  }
  invalidateSearch(): void { this.revision++; this.autoTable = undefined }
  private check(): void { if (this.disposed) throw new Error('Storage resolver is disposed') }
  private member(index: OpenArchive, member: string): Resource | undefined {
    const exact = index.entries.get(member)
    if (exact) return exact
    const names = index.folded.get(member.toLowerCase())
    if (names?.length === 1) return index.entries.get(names[0]!)
    if (names && names.length > 1) throw new Error(`Ambiguous resource name: ${index.name}>${member}`)
    return undefined
  }
  /** Exact canonical address only: no current-directory or AutoPath search. */
  async findAsync(path: string, overlay?: (name: string) => Resource | undefined): Promise<Resource | undefined> {
    this.check()
    const logical = parseStoragePath(path), direct = overlay?.(logical) ?? this.find(logical)
    if (direct) return direct
    const delimiter = logical.indexOf('>')
    if (delimiter < 0) return undefined
    const name = logical.slice(0, delimiter), member = logical.slice(delimiter + 1),
      raw = overlay?.(name) ?? this.find(name)
    if (!raw) throw new Error(`Archive resource not found: ${name}`)
    const index = await this.archives.open(raw)
    this.check()
    if (!index) throw new Error(`Unsupported archive: ${name}`)
    return this.member(index, member)
  }
  private async aliasesAsync(overlay?: (name: string) => Resource | undefined): Promise<Map<string, Resource>> {
    const entries = new Map<string, Resource>()
    for (const [alias, canonical] of this.aliases) {
      const resource = this.find(canonical)
      if (resource) entries.set(alias, resource)
    }
    if (!this.reader) return entries
    // This is an explicit Web collection fallback, after normal lookup. It
    // cannot hide errors from any registered native project AutoPath.
    let units = 0, visited = 0
    for (const mounted of this.files.values()) {
      this.check()
      if (!(++visited % 256)) await this.checkpoint()
      if (mounted.name.includes('>')) continue
      const raw = overlay?.(mounted.name) ?? mounted
      const index = await this.archives.open(raw)
      if (index) for (const [name, resource] of index.entries) {
        const old = entries.get(name)
        units += name.length + resource.name.length - (old ? name.length + old.name.length : 0)
        if (entries.size + (old ? 0 : 1) > 250000 || units > 16 * 1024 * 1024)
          throw new Error('Archive compatibility aliases exceed metadata budget')
        entries.set(name, resource)
      }
    }
    this.check()
    return entries
  }
  private tableFind<T>(entries: ReadonlyMap<string, T>, name: string): T | undefined {
    const exact = entries.get(name)
    if (exact) return exact
    const matches = [...entries].filter(([entry]) => entry.toLowerCase() === name.toLowerCase())
    if (matches.length > 1) throw new Error(`Ambiguous resource name: ${name}`)
    return matches[0]?.[1]
  }
  private async buildAutoTable(overlay?: (name: string) => Resource | undefined,
    overlayResources: readonly Resource[] = []): Promise<Map<string, string>> {
    for (;;) {
      this.check()
      const revision = this.revision
      if (this.autoTable?.revision === revision) return this.autoTable.entries
      const entries = new Map<string, string>(), paths = [...this.autoPaths]
      let units = 0
      const add = (name: string, path: string) => {
        const previous = entries.get(name)
        units += name.length + path.length - (previous === undefined ? 0 : name.length + previous.length)
        if (entries.size + (previous === undefined ? 1 : 0) > 250000 || units > 16 * 1024 * 1024)
          throw new Error('AutoPath table exceeds metadata budget')
        entries.set(name, path)
      }
      for (const path of paths) {
        const directory = await this.directoryEntries(path, overlay, overlayResources)
        for (const resource of directory) {
          const relative = resource.name.slice(path.length)
          if (relative && !relative.includes('/')) add(relative, resource.name)
        }
        if (this.archiveAliases && !path.includes('>'))
          for (const [name, resource] of await this.aliasesAsync(overlay))
            if (name.startsWith(path) && !name.slice(path.length).includes('/'))
              if (!this.find(path + name.slice(path.length))) add(name.slice(path.length), resource.name)
      }
      if (revision !== this.revision) continue
      this.check()
      this.autoTable = { revision, entries }
      return entries
    }
  }
  async lookupAsync(path: string, overlay?: (name: string) => Resource | undefined,
    overlayResources: readonly Resource[] = []): Promise<Resource | undefined> {
    this.check()
    const direct = parseStoragePath(path, this.currentDirectory)
    if (!direct) return undefined
    const current = await this.findAsync(direct, overlay)
    this.check()
    if (current) return current
    const basename = direct.split(/[/>]/).at(-1)!, table = await this.buildAutoTable(overlay, overlayResources),
      placed = this.tableFind(table, basename)
    if (placed) return this.findAsync(placed, overlay)
    if (this.archiveAliases) return this.tableFind(await this.aliasesAsync(overlay), direct)
    return undefined
  }
  async resolveAsync(path: string, overlay?: (name: string) => Resource | undefined): Promise<Resource> {
    const found = await this.lookupAsync(path, overlay)
    if (!found) throw new Error(`Resource not found: ${path}`)
    return found
  }
  private async directoryEntries(path: string, overlay?: (name: string) => Resource | undefined,
    overlayResources: readonly Resource[] = []): Promise<Resource[]> {
    const matches = (values: readonly Resource[]) => {
      const found = values.filter((resource) => resource.name.toLowerCase().startsWith(path.toLowerCase())),
        prefixes = new Set(found.map((resource) => resource.name.slice(0, path.length)))
      if (prefixes.has(path)) return found.filter((resource) => resource.name.startsWith(path))
      if (prefixes.size > 1) throw new Error(`Ambiguous storage directory: ${path}`)
      return found
    }, direct = matches([...new Map([...this.files.values(), ...overlayResources].map((resource) => [resource.name, resource])).values()])
    const delimiter = path.indexOf('>')
    if (delimiter < 0) return direct.filter((resource) => !resource.name.includes('>'))
    const name = path.slice(0, delimiter), raw = overlay?.(name) ?? this.find(name)
    // Explicit pre-mounted member fixtures remain usable without a container.
    if (!raw && direct.length) return direct
    if (!raw) throw new Error(`Archive resource not found: ${name}`)
    const index = await this.archives.open(raw)
    if (!index) throw new Error(`Unsupported archive: ${name}`)
    return matches([...index.entries.values()])
  }
  /** One canonical directory, never recursive. Raw containers are ordinary
   * files; their candidate archive directories open only when entered. */
  async listDirectory(path: string, overlayResources: readonly Resource[] = []): Promise<{
    name: string; entries: { name: string; size: number }[]; directories: string[]
  }> {
    this.check()
    let name = parseStoragePath(path)
    if (name && !/[/>]$/.test(name)) throw new Error('Expected storage directory')
    const overlays = new Map(overlayResources.map((resource) => [resource.name, resource])),
      source = await this.directoryEntries(name, (key) => overlays.get(key), overlayResources),
      all = new Map([...source, ...overlayResources.filter((resource) => resource.name.toLowerCase().startsWith(name.toLowerCase()))]
        .map((resource) => [resource.name, resource])), entries: { name: string; size: number }[] = [],
      directories = new Set<string>()
    if (all.size) {
      const prefixes = new Set([...all.keys()].map((key) => key.slice(0, name.length)))
      if (!prefixes.has(name)) {
        if (prefixes.size > 1) throw new Error(`Ambiguous storage directory: ${name}`)
        name = prefixes.values().next().value!
      }
      for (const key of all.keys()) if (!key.startsWith(name)) all.delete(key)
    } else if (name.endsWith('>')) {
      const raw = overlays.get(name.slice(0, -1)) ?? this.find(name.slice(0, -1))
      if (raw) name = raw.name + '>'
    }
    for (const resource of all.values()) {
      const relative = resource.name.slice(name.length), separator = relative.search(/[/>]/)
      if (separator >= 0) directories.add(name + relative.slice(0, separator + 1))
      else if (relative) {
        entries.push({ name: resource.name, size: resource.size })
        if (!name.includes('>') && await this.archives.candidate(resource)) directories.add(resource.name + '>')
      }
    }
    if (name && !all.size && !name.endsWith('>')) {
      const parent = name.replace(/[^/>]+\/$/, '')
      if (parent !== name) {
        const listing = await this.listDirectory(parent, overlayResources)
        if (!listing.directories.includes(name)) throw new Error(`Storage directory not found: ${name}`)
      }
    }
    this.check()
    return { name, entries, directories: [...directories] }
  }
  list(): { name: string; size: number }[] {
    return this.knownResources().map(({ name, size }) => ({ name, size }))
  }
  knownResources(): Resource[] {
    const all = new Map(this.files)
    for (const index of this.archives.known()) for (const resource of index.entries.values()) all.set(resource.name, resource)
    return [...all.values()]
  }
  get count(): number {
    return this.files.size + this.aliases.size
  }
  dispose(): void { this.disposed = true; this.invalidateSearch(); this.archives.dispose() }
  clear(): void {
    this.files.clear()
    this.folded.clear()
    this.aliases.clear()
    this.foldedAliases.clear()
    this.autoPaths = []
    this.invalidateSearch()
    this.archives.clear()
  }
}
