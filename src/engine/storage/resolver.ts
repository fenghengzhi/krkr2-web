import type { ArchiveReader, Resource } from '../ports/storage.ts'
import type { CddaDiscs } from './cdda.ts'
import { resourceReadBounds } from './resource-source.ts'
import { StorageArchives, type OpenArchive } from './archives.ts'
import { TvpError } from '../system/tvp-error.ts'

import { discAddress, discStoragePath, extractStorageName, nativeDiscPath, normalizeResourcePath, parseStoragePath, storageDirectoryPath } from './public-path.ts'

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

type AliasSearch = 'all' | 'identified'

// Both the Win32 file medium and the stock archive index fold ASCII A–Z.
// Keep the imported spelling in addresses handed back to the script.
const autoPathKey = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

function findSpelling<T>(entries: ReadonlyMap<string, T>, name: string): T | undefined {
  const exact = entries.get(name)
  if (exact !== undefined) return exact
  const folded = name.toLowerCase()
  let match: T | undefined
  for (const [entry, value] of entries) {
    if (entry.toLowerCase() !== folded) continue
    if (match !== undefined) throw new Error(`Ambiguous resource name: ${name}`)
    match = value
  }
  return match
}

function aliasDirectory(path: string, names: Iterable<string>): string | undefined {
  if (!path) return ''
  const key = autoPathKey(path)
  let match: string | undefined, ambiguous = false
  for (const name of names) {
    const prefix = name.slice(0, path.length)
    if (prefix === path) return path
    if (autoPathKey(prefix) !== key) continue
    if (match !== undefined && prefix !== match) ambiguous = true
    match = prefix
  }
  if (ambiguous) throw new Error(`Ambiguous storage directory: ${path}`)
  return match
}

class AutoPathTable {
  private readonly groups = new Map<string, { directory: string; files: string | Map<string, string> }>()
  private count = 0
  private units = 0

  add(directory: string, name: string, file: string): void {
    const key = autoPathKey(name), group = this.groups.get(key)
    let previous: string | undefined
    if (!group || group.directory !== directory) {
      if (group) {
        for (const old of typeof group.files === 'string' ? [group.files] : group.files.values()) {
          this.count--
          this.units -= key.length + old.length
        }
      }
      this.groups.set(key, { directory, files: file })
    } else if (typeof group.files === 'string') {
      // Only a case collision within the same winning directory needs a map.
      const old = group.files, spelling = extractStorageName(old)
      if (name === spelling) {
        previous = old
        group.files = file
      } else group.files = new Map([[spelling, old], [name, file]])
    } else {
      previous = group.files.get(name)
      group.files.set(name, file)
    }
    if (previous === undefined) this.count++
    this.units += previous === undefined ? key.length + file.length : file.length - previous.length
    if (this.count > 250000 || this.units > 16 * 1024 * 1024) throw new Error('AutoPath table exceeds metadata budget')
  }

  find(name: string): string | undefined {
    const group = findSpelling(this.groups, autoPathKey(name))
    if (!group) return undefined
    if (typeof group.files === 'string') return group.files
    const exact = group.files.get(name)
    if (exact === undefined) throw new Error(`Ambiguous resource name: ${name}`)
    return exact
  }
}

export class StorageResolver {
  private readonly archives: StorageArchives
  private revision = 0
  private disposed = false
  private readonly autoTables = new Map<AliasSearch, AutoPathTable>()
  private readonly collectionTables = new Map<AliasSearch, Map<string, string>>()
  constructor(readonly currentDirectory = '', private readonly archiveAliases = true,
    private readonly reader?: ArchiveReader, private readonly checkpoint: () => Promise<void> = async () => {},
    private readonly discs?: Pick<CddaDiscs, 'drives' | 'filesystem'>) {
    this.archives = new StorageArchives(reader, checkpoint, () => ({
      entries: 250000 - this.files.size - this.aliases.size - this.directories.size,
      units: 16 * 1024 * 1024 - [...this.files.keys(), ...this.aliases.keys(), ...this.directories].reduce((sum, name) => sum + name.length, 0),
    }), () => this.invalidateSearch())
  }
  private files = new Map<string, Resource>()
  private folded = new Map<string, Set<string>>()
  private aliases = new Map<string, string>()
  private foldedAliases = new Map<string, Set<string>>()
  private readonly autoPaths = new Map<string, string>()
  private directories = new Set<string>()
  private readonlyRoots = new Set<string>()
  async qualifyDrive(path: string): Promise<string> {
    const disc = discAddress(nativeDiscPath(path) ?? path)
    if (!disc) return path
    if (!(await this.discs?.drives())?.includes(disc.drive)) throw new TvpError('TVPUnsupportedMediaName', [disc.drive.toLowerCase()], 'CD drive is not bound')
    return discStoragePath(disc.drive, disc.path)
  }
  async discRoots(): Promise<string[]> {
    return (await this.discs?.drives() ?? []).map((drive) => discStoragePath(drive, ''))
  }
  mount(resources: Resource[], options: { directories?: readonly string[]; readonlyRoots?: readonly string[] } = {}): void {
    this.check()
    // Validate the entire mount before mutating the active namespace.
    const prepared = resources.map((resource) => ({
      resource,
      name: normalizeStorageName(resource.name),
      aliasOf: resource.aliasOf === undefined ? undefined : normalizeStorageName(resource.aliasOf),
    }))
    const available = new Set([...this.files.keys(), ...prepared.filter((entry) => entry.aliasOf === undefined).map((entry) => entry.name)])
    const aliasNames = new Set([...this.aliases.keys(), ...prepared.filter((entry) => entry.aliasOf !== undefined).map((entry) => entry.name)])
    const directory = (value: string) => {
      const name = normalizeResourcePath(value)
      if (name.includes('>')) throw new Error('Mounted directory cannot address an archive member')
      return name + '/'
    }, addedDirectories = (options.directories ?? []).map(directory),
      roots = (options.readonlyRoots ?? []).map(directory),
      allDirectories = new Set([...this.directories, ...addedDirectories, ...roots])
    for (const { name } of prepared) this.assertOutsideReadonly(name)
    for (const name of addedDirectories) this.assertOutsideReadonly(name)
    for (const root of roots) if (this.hasTree(root)) throw new Error('Read-only import namespace already exists')
    if (available.size + aliasNames.size + allDirectories.size > 250000 ||
        [...available, ...aliasNames, ...allDirectories].reduce((sum, name) => sum + name.length, 0) > 16 * 1024 * 1024)
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
    this.directories = allDirectories
    for (const root of roots) this.readonlyRoots.add(root.toLowerCase())
    this.invalidateSearch()
    this.archives.trim()
  }
  addAutoPath(path: string): void {
    const normalized = storageDirectoryPath(path, this.currentDirectory)
    const key = autoPathKey(normalized)
    if (!this.autoPaths.has(key)) this.autoPaths.set(key, normalized)
    this.invalidateSearch()
  }
  removeAutoPath(path: string): void {
    const normalized = storageDirectoryPath(path, this.currentDirectory)
    this.autoPaths.delete(autoPathKey(normalized))
    this.invalidateSearch()
  }
  candidates(path: string): string[] {
    const normalized = parseStoragePath(path, this.currentDirectory)
    if (!normalized || /[/>]$/.test(normalized)) return [normalized]
    const basename = normalized.split(/[/>]/).at(-1)!
    const paths = [...this.autoPaths.values()].reverse()
    return [normalized, ...paths.map((prefix) => prefix + basename)]
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
    const requested = autoPathKey(extractStorageName(direct!))
    let unicodeFallback: Resource | undefined, ambiguous = false
    for (const candidate of searched) {
      const resource = overlay?.(candidate) ?? this.find(candidate) ?? this.fallback(candidate)
      if (!resource) continue
      const key = autoPathKey(extractStorageName(resource.name))
      if (key === requested) return resource
      if (!unicodeFallback) unicodeFallback = resource
      else if (autoPathKey(extractStorageName(unicodeFallback.name)) !== key) ambiguous = true
    }
    if (ambiguous) throw new Error(`Ambiguous resource name: ${path}`)
    return unicodeFallback ?? this.fallback(direct!)
  }
  resolve(path: string): Resource {
    const resource = this.lookup(path)
    if (resource) return resource
    throw new TvpError('TVPCannotFindStorage', [path], `Resource not found: ${path}`)
  }
  exists(path: string): boolean {
    try {
      this.resolve(path)
      return true
    } catch (error) {
      if (error instanceof TvpError && error.tvpMessage.id === 'TVPCannotFindStorage') return false
      throw error
    }
  }
  invalidateSearch(): void { this.revision++; this.autoTables.clear(); this.collectionTables.clear() }
  discChanged(drive: string): void {
    this.archives.forgetDrive(drive)
    this.invalidateSearch()
  }
  /** Reserve against real/alias files, directories, and case-folded spelling;
   * callers include save-overlay names in the same final synchronous check. */
  hasTree(prefix: string, extraPaths: readonly string[] = []): boolean {
    const root = normalizeResourcePath(prefix).toLowerCase(), beginning = root + '/'
    return [...this.files.keys(), ...this.aliases.keys(), ...this.directories, ...extraPaths].some((key) => {
      const name = key.replace(/\/$/, '').toLowerCase()
      return name === root || name.startsWith(beginning) || root.startsWith(name + '/')
    })
  }
  private assertOutsideReadonly(path: string): void {
    const name = path.replace(/\/$/, '').toLowerCase()
    for (const prefix of this.readonlyRoots) {
      const root = prefix.slice(0, -1)
      if (name === root || name.startsWith(prefix) || root.startsWith(name + '/'))
        throw new Error('Dropped storage is read-only')
    }
  }
  assertWritable(path: string): void {
    const name = parseStoragePath(path)
    if (discAddress(name)) throw new TvpError('TVPCannotOpenStorage', [name], 'CD storage is read-only')
    this.assertOutsideReadonly(name)
  }
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
    const delimiter = logical.indexOf('>'), revision = this.archives.discRevision(logical)
    if (delimiter < 0) {
      const disc = discAddress(logical)
      if (!disc || !disc.path || disc.path.endsWith('/')) return undefined
      const fs = await this.discs?.filesystem(disc.drive), source = await fs?.file(disc.path)
      this.check()
      if (revision !== this.archives.discRevision(logical)) return this.findAsync(path, overlay)
      if (!source) return undefined
      return { name: logical, size: source.size, cacheToken: source, source, read: () => {
        resourceReadBounds(source.size, 0, source.size)
        return source.read(0, source.size)
      } }
    }
    const name = logical.slice(0, delimiter), member = logical.slice(delimiter + 1),
      raw = await this.findAsync(name, overlay)
    if (revision !== this.archives.discRevision(logical)) return this.findAsync(path, overlay)
    if (!raw) throw new TvpError('TVPCannotOpenStorage', [name], `Archive resource not found: ${name}`)
    const index = await this.archives.open(raw)
    this.check()
    if (!index) throw new Error(`Unsupported archive: ${name}`)
    return this.member(index, member)
  }
  private async aliasesAsync(overlay: ((name: string) => Resource | undefined) | undefined,
    aliasSearch: AliasSearch): Promise<Map<string, string>> {
    for (;;) {
      this.check()
      const revision = this.revision
      const cached = this.collectionTables.get('all') ?? this.collectionTables.get(aliasSearch)
      if (cached) return cached
      const entries = new Map(this.aliases)
      let units = 0, visited = 0
      for (const [name, canonical] of entries) units += name.length + canonical.length
      if (this.reader) for (const mounted of this.files.values()) {
        this.check()
        if (!(++visited % 256)) await this.checkpoint()
        if (mounted.name.includes('>') || mounted.archiveAliases === false) continue
        const raw = overlay?.(mounted.name) ?? mounted
        // Imported range sources can identify even a renamed package without
        // materializing it. An embedding's ordinary read-only image or sound
        // must not be read in full to look for an unrelated optional asset.
        if (aliasSearch === 'identified' && !raw.source && !raw.archiveKind && mounted.archiveAliases !== true &&
            !this.archives.recognized(raw) && !/\.(?:xp3|zip|exe)$/i.test(raw.name)) continue
        if (raw.source && this.reader.probeArchive && !await this.archives.candidate(raw)) continue
        const index = await this.archives.open(raw)
        if (index) for (const [name, resource] of index.entries) {
          const old = entries.get(name)
          units += name.length + resource.name.length - (old ? name.length + old.length : 0)
          if (entries.size + (old ? 0 : 1) > 250000 || units > 16 * 1024 * 1024)
            throw new Error('Archive compatibility aliases exceed metadata budget')
          entries.set(name, resource.name)
        }
      }
      if (revision !== this.revision) continue
      this.check()
      if (aliasSearch === 'all') this.collectionTables.delete('identified')
      this.collectionTables.set(aliasSearch, entries)
      return entries
    }
  }
  private async buildAutoTable(overlay: ((name: string) => Resource | undefined) | undefined,
    overlayResources: readonly Resource[], aliasSearch: AliasSearch): Promise<AutoPathTable> {
    for (;;) {
      this.check()
      const revision = this.revision
      const cached = this.autoTables.get('all') ?? this.autoTables.get(aliasSearch)
      if (cached) return cached
      const entries = new AutoPathTable(), paths = [...this.autoPaths.values()]
      for (const path of paths) {
        const disc = discAddress(path)
        if (disc && !path.includes('>')) {
          const fs = await this.discs?.filesystem(disc.drive)
          for (const child of await fs?.list(disc.path) ?? []) {
            if (child.directory) continue
            const logical = discStoragePath(disc.drive, disc.path + child.name)
            entries.add(path, extractStorageName(logical), logical)
          }
          continue
        }
        const directory = await this.directoryEntries(path, overlay, overlayResources, true),
          realNames = this.archiveAliases && !path.includes('>') ? new Set<string>() : undefined
        for (const resource of directory) {
          const relative = resource.name.slice(path.length)
          if (!relative || relative.includes('/')) continue
          entries.add(path, relative, resource.name)
          realNames?.add(autoPathKey(relative))
        }
        if (realNames) {
          const aliases = await this.aliasesAsync(overlay, aliasSearch), prefix = aliasDirectory(path, aliases.keys())
          if (prefix === undefined) continue
          for (const [name, canonical] of aliases) {
            if (!name.startsWith(prefix)) continue
            const relative = name.slice(path.length)
            if (relative && !relative.includes('/') && !realNames.has(autoPathKey(relative))) entries.add(path, relative, canonical)
          }
        }
      }
      if (revision !== this.revision) continue
      this.check()
      if (aliasSearch === 'all') this.autoTables.delete('identified')
      this.autoTables.set(aliasSearch, entries)
      return entries
    }
  }
  async lookupAsync(path: string, overlay?: (name: string) => Resource | undefined,
    overlayResources: readonly Resource[] = [], aliasSearch: AliasSearch = 'all'): Promise<Resource | undefined> {
    this.check()
    const direct = parseStoragePath(await this.qualifyDrive(path), this.currentDirectory)
    // File existence/placement cannot open an archive directory. Its trailing
    // delimiter already proves it is not a file, including missing or corrupt
    // packages; directory enumeration still validates the actual archive.
    if (!direct || /[/>]$/.test(direct)) return undefined
    const current = await this.findAsync(direct, overlay)
    this.check()
    if (current) return current
    const basename = direct.split(/[/>]/).at(-1)!, table = await this.buildAutoTable(overlay, overlayResources, aliasSearch),
      placed = table.find(basename)
    if (placed) return this.findAsync(placed, overlay)
    if (this.archiveAliases) {
      const canonical = findSpelling(await this.aliasesAsync(overlay, aliasSearch), direct)
      if (canonical) return this.findAsync(canonical, overlay)
    }
    return undefined
  }
  async resolveAsync(path: string, overlay?: (name: string) => Resource | undefined): Promise<Resource> {
    const found = await this.lookupAsync(path, overlay)
    if (!found) throw new TvpError('TVPCannotFindStorage', [path], `Resource not found: ${path}`)
    return found
  }
  private async directoryEntries(path: string, overlay?: (name: string) => Resource | undefined,
    overlayResources: readonly Resource[] = [], autoPath = false): Promise<Resource[]> {
    const matches = (values: readonly Resource[]) => {
      const found = values.filter((resource) => resource.name.toLowerCase().startsWith(path.toLowerCase())),
        prefixes = new Set([...found.map((resource) => resource.name.slice(0, path.length)),
          ...[...this.directories].filter((name) => name.toLowerCase().startsWith(path.toLowerCase())).map((name) => name.slice(0, path.length))])
      if (prefixes.has(path)) return found.filter((resource) => resource.name.startsWith(path))
      if (prefixes.size > 1) throw new Error(`Ambiguous storage directory: ${path}`)
      return found
    }, direct = matches([...new Map([...this.files.values(), ...overlayResources].map((resource) => [resource.name, resource])).values()])
    const delimiter = path.indexOf('>')
    if (delimiter < 0) return direct.filter((resource) => !resource.name.includes('>'))
    const name = path.slice(0, delimiter), revision = this.archives.discRevision(name), raw = await this.findAsync(name, overlay)
    if (revision !== this.archives.discRevision(name)) return this.directoryEntries(path, overlay, overlayResources, autoPath)
    // Explicit pre-mounted member fixtures remain usable without a container.
    if (!raw && direct.length) return direct
    if (!raw && autoPath && discAddress(name)) return []
    if (!raw) throw new TvpError('TVPCannotOpenStorage', [name], `Archive resource not found: ${name}`)
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
    let name = parseStoragePath(await this.qualifyDrive(path))
    if (name && !/[/>]$/.test(name)) throw new Error('Expected storage directory')
    const disc = discAddress(name)
    if (disc && !name.includes('>')) {
      const fs = await this.discs?.filesystem(disc.drive), children = await fs?.list(disc.path)
      if (!children) throw new Error(`Storage directory not found: ${name}`)
      const entries: { name: string; size: number }[] = [], directories: string[] = []
      for (const child of children) {
        const childPath = discStoragePath(disc.drive, disc.path + child.name)
        if (child.directory) directories.push(childPath + '/')
        else {
          entries.push({ name: childPath, size: child.size })
          if (/\.(?:xp3|zip|exe)$/i.test(child.name)) directories.push(childPath + '>')
        }
      }
      this.check()
      return { name, entries, directories }
    }
    if (!this.directories.has(name)) {
      const matching = [...this.directories].filter((entry) => entry.toLowerCase() === name.toLowerCase())
      if (matching.length > 1) throw new Error(`Ambiguous storage directory: ${name}`)
      if (matching.length === 1) name = matching[0]!
    }
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
    for (const directory of this.directories) {
      if (!directory.startsWith(name) || directory === name) continue
      const relative = directory.slice(name.length), separator = relative.indexOf('/')
      directories.add(name + relative.slice(0, separator + 1))
    }
    if (name && !all.size && !name.endsWith('>') && !this.directories.has(name)) {
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
  /** Indexed names only, including nested directories. Iterating these
   * entries does not open the files inside the archive. */
  async archiveEntries(file: Resource): Promise<Iterable<Resource>> {
    this.check()
    const index = await this.archives.open(file)
    this.check()
    return index?.entries.values() ?? []
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
    this.autoPaths.clear()
    this.directories.clear()
    this.readonlyRoots.clear()
    this.invalidateSearch()
    this.archives.clear()
  }
}
