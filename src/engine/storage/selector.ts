import type {
  StorageSelectorChoice,
  StorageSelectorDirectory,
  StorageSelectorPresentation,
} from '../ports/storage-selector.ts'
import type { ScriptValue } from '../script/runtime.ts'
import { StorageResolver } from './resolver.ts'
import { SaveOverlay } from './save-overlay.ts'
import {
  extractStorageExt,
  extractStorageName,
  extractStoragePath,
  parseStoragePath,
  storageFilePath,
  storageWritePath,
  toPublicStoragePath,
} from './public-path.ts'

const maxEntries = 10000
const maxNameUnits = 2 * 1024 * 1024

export function normalizeSelectorPath(input: string): string {
  if (input.length > 4096) throw new Error('File selector path exceeds 4096 characters')
  const name = toPublicStoragePath(parseStoragePath(input))
  if (name.length > 4096) throw new Error('File selector path exceeds 4096 characters')
  return name
}

/** A deterministic VFS filename rule. The Win32 API delegates this to the OS. */
export function selectorExtension(input: string, extension: string): string {
  if (input.endsWith('.')) return input.slice(0, -1)
  return extension && !extractStorageExt(input) ? input + '.' + extension : input
}

/** Captures display metadata only. Confirmation always checks the current namespace. */
export class StorageSelector {
  constructor(
    private readonly resources: StorageResolver,
    private readonly saves: SaveOverlay,
    private readonly dataPath: string,
  ) {}

  private virtualDirectories() {
    const directories = new Set<string>(['game://./'])
    // Browser saves have no mkdir operation. The configured save directory is
    // a real virtual directory even before the first file is written there.
    const path = parseStoragePath(this.dataPath)
    for (let index = 0; index < path.length; index++)
      if (path[index] === '/') directories.add(toPublicStoragePath(path.slice(0, index + 1)))
    return directories
  }

  async prepare(args: readonly ScriptValue[]): Promise<{
    caption: string
    presentation: StorageSelectorPresentation
    choose(value: string): Promise<string>
    browse(directory: string): Promise<StorageSelectorDirectory>
  }> {
    const text = (value: ScriptValue) => {
      if (typeof value !== 'string') throw new Error('Invalid file selector text')
      return value
    }
    if (
      args.length < 7 ||
      args.length > 263 ||
      typeof args[0] !== 'bigint' ||
      args[0] < 0n ||
      args[0] > 0xffffffffn ||
      (args[4] !== 0n && args[4] !== 1n) ||
      (args[6] !== 0n && args[6] !== 1n) ||
      (args[3] !== undefined && typeof args[3] !== 'string') ||
      (args[5] !== undefined && typeof args[5] !== 'string')
    )
      throw new Error('Invalid native file selector snapshot')
    const save = args[4] === 1n,
      name = text(args[1]),
      initial = text(args[2]),
      extension = args[5] === undefined ? '' : text(args[5]),
      filters = args.slice(7).map((value) => {
        const filter = text(value),
          divider = filter.indexOf('|')
        if (filter.includes('\0')) throw new Error('File selector filter contains NUL')
        return Object.freeze({
          label: divider < 0 ? filter : filter.slice(0, divider),
          pattern: divider < 0 ? filter : filter.slice(divider + 1),
        })
      })
    if (
      args.reduce<number>(
        (total, value) => total + (typeof value === 'string' ? value.length : 0),
        0,
      ) >
      256 * 1024
    )
      throw new Error('File selector options exceed their text budget')
    if (
      name.length > 4096 ||
      initial.length > 4096 ||
      extension.length > 4096 ||
      (typeof args[3] === 'string' && args[3].length > 4096)
    )
      throw new Error('File selector option exceeds 4096 characters')
    if (/[\\/>\0]/.test(extension)) throw new Error('Invalid file selector default extension')
    const requestedName = name ? parseStoragePath(name, this.resources.currentDirectory) : '',
      existingName =
        requestedName && !/[/>]$/.test(requestedName) && (!save || !requestedName.includes('>'))
          ? (this.saves.resource(requestedName) ?? await this.resources.findAsync(requestedName))
          : undefined,
      directory = async (value: string): Promise<StorageSelectorDirectory | undefined> => {
        if (!value) return undefined
        const normalized = normalizeSelectorPath(toPublicStoragePath(parseStoragePath(value, this.resources.currentDirectory)))
        const candidate = /[/>]$/.test(normalized) ? normalized : normalized + '/'
        if (save && candidate.includes('>')) return undefined
        try { return await this.browse(save, candidate) }
        catch (error) {
          if (error instanceof Error && error.message.startsWith('Storage directory not found:')) return undefined
          throw error
        }
      },
      nameDirectory = name
        ? await directory(extractStoragePath(toPublicStoragePath(existingName?.name ?? requestedName)))
        : undefined,
      initialListing = nameDirectory ?? await directory(initial) ??
        await directory(toPublicStoragePath(this.resources.currentDirectory)) ?? await this.browse(save, 'game://./'),
      rawIndex = Number(args[0]),
      filterIndex = filters.length
        ? rawIndex >= 1 && rawIndex <= filters.length
          ? rawIndex
          : 1
        : 0,
      presentation: StorageSelectorPresentation = Object.freeze({
        save,
        name,
        initialDirectory: initialListing.name,
        defaultExtension: extension,
        filters: Object.freeze(filters),
        filterIndex,
        entries: initialListing.entries,
        directories: initialListing.directories,
      })
    return {
      caption: args[3] === undefined ? (save ? '保存文件' : '打开文件') : text(args[3]),
      presentation,
      choose: (value) => this.choose(presentation, value),
      browse: (value) => this.browse(save, value),
    }
  }

  private async browse(save: boolean, input: string): Promise<StorageSelectorDirectory> {
    const path = normalizeSelectorPath(input),
      logical = parseStoragePath(path),
      virtual = this.virtualDirectories()
    if (logical && !/[/>]$/.test(logical)) throw new Error('File selector directory requires a trailing delimiter')
    if (save && logical.includes('>')) throw new Error('Archive directories are read-only')
    const overlays = this.saves.list().map((file) => this.saves.resource(file.name)!),
      fallback = this.directory(path, virtual)
    let listed: Awaited<ReturnType<StorageResolver['listDirectory']>>
    try { listed = await this.resources.listDirectory(logical, overlays) }
    catch (error) {
      if (!fallback || !(error instanceof Error) || !error.message.startsWith('Storage directory not found:')) throw error
      listed = { name: parseStoragePath(fallback), entries: [], directories: [] }
    }
    const name = normalizeSelectorPath(listed.name),
      entries = new Map<string, { name: string; size: number; archive: boolean }>(),
      directories = new Set<string>(['game://./', name])
    for (const entry of listed.entries) {
      const publicName = normalizeSelectorPath(entry.name)
      if (!save || !publicName.includes('>')) entries.set(publicName,
        Object.freeze({ name: publicName, size: entry.size, archive: publicName.includes('>') }))
    }
    for (const entry of [...listed.directories.map(normalizeSelectorPath), ...virtual])
      if ((!save || !entry.includes('>')) && extractStoragePath(entry.slice(0, -1)) === name) directories.add(entry)
    // Retain navigation to ancestors without enumerating their archives.
    const current = parseStoragePath(name)
    for (let i = 0; i < current.length; i++)
      if (current[i] === '/' || current[i] === '>') directories.add(toPublicStoragePath(current.slice(0, i + 1)))
    const units = [...entries.keys(), ...directories].reduce((sum, value) => sum + value.length, 0)
    if (entries.size > maxEntries || directories.size > maxEntries || units > maxNameUnits)
      throw new Error('File selector listing exceeds its metadata budget')
    return Object.freeze({ name, entries: Object.freeze([...entries.values()]),
      directories: Object.freeze([...directories].sort()) })
  }

  private directory(name: string, directories: ReadonlySet<string>): string | undefined {
    if (directories.has(name)) return name
    const matches = [...directories].filter((entry) => entry.toLowerCase() === name.toLowerCase())
    if (matches.length > 1) throw new Error(`Ambiguous storage directory: ${name}`)
    return matches[0]
  }

  private async choose(request: StorageSelectorPresentation, encoded: string): Promise<string> {
    if (encoded.length > 8192) throw new Error('File selector choice is too large')
    const choice: unknown = JSON.parse(encoded)
    if (!choice || typeof choice !== 'object' || Array.isArray(choice))
      throw new Error('Invalid file selector choice')
    const { name, filterIndex, overwrite } = choice as StorageSelectorChoice
    if (
      typeof name !== 'string' ||
      typeof overwrite !== 'boolean' ||
      !Number.isSafeInteger(filterIndex) ||
      (request.filters.length
        ? filterIndex < 1 || filterIndex > request.filters.length
        : filterIndex !== 0)
    )
      throw new Error('Invalid file selector choice')
    if (name.length > 4096) throw new Error('File selector path exceeds 4096 characters')
    let path = request.save ? storageWritePath(name) : storageFilePath(name)
    // Appending follows the filename, never the directory. A final dot opts out.
    path = selectorExtension(path, request.defaultExtension)
    path = request.save ? storageWritePath(path) : storageFilePath(path)
    // Resolve the complete filename first. Distinct Foo/ and foo/ directories
    // must not make FOO/a.sav ambiguous when only Foo/a.sav actually exists.
    // Autopath fallback would silently select another directory, so use find.
    const saved = this.saves.resource(path),
      original = saved ? undefined : await this.resources.findAsync(path),
      publicName = normalizeSelectorPath((this.saves.resource(path) ?? saved ?? original)?.name ?? path),
      snapshot = await this.browse(request.save, extractStoragePath(publicName)),
      parent = snapshot.name
    if (!parent) throw new Error('选择的目录不存在。')
    path = parseStoragePath(parent + extractStorageName(publicName))
    if (this.directory(toPublicStoragePath(path + '/'), new Set(snapshot.directories)))
      throw new Error('请选择文件，而不是目录。')
    // Directory/header I/O can yield to a Timer that writes a save. Recheck
    // the overlay after the final await before granting overwrite permission.
    const existing = this.saves.resource(path) ?? original
    if (!request.save && !existing) throw new Error('选择的文件不存在。')
    if (request.save && existing && !overwrite) throw new Error('文件已存在，请确认覆盖。')
    const selected = normalizeSelectorPath(existing?.name ?? path)
    return `${filterIndex}\n${selected}`
  }
}
