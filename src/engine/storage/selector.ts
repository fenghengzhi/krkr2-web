import type {
  StorageSelectorChoice,
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

  private namespace(save: boolean) {
    const files = new Map<string, { name: string; size: number; archive: boolean }>()
    let units = 'game://./'.length
    for (const file of [...this.resources.list(), ...this.saves.list()]) {
      if (save && file.name.includes('>')) continue
      const name = normalizeSelectorPath(file.name)
      if (!files.has(name)) {
        units += name.length
        if (files.size >= maxEntries || units > maxNameUnits)
          throw new Error('File selector listing exceeds its metadata budget')
      }
      files.set(name, Object.freeze({ name, size: file.size, archive: name.includes('>') }))
    }
    const directories = new Set<string>(['game://./'])
    const addDirectories = (path: string) => {
      const logical = parseStoragePath(path)
      for (let index = 0; index < logical.length; index++) {
        if (logical[index] !== '/' && logical[index] !== '>') continue
        const directory = toPublicStoragePath(logical.slice(0, index + 1))
        if (!directories.has(directory)) {
          units += directory.length
          if (directories.size >= maxEntries || units > maxNameUnits)
            throw new Error('File selector listing exceeds its metadata budget')
          directories.add(directory)
        }
      }
    }
    for (const name of files.keys()) addDirectories(name)
    // Browser saves have no mkdir operation. The configured save directory is
    // a real virtual directory even before the first file is written there.
    addDirectories(this.dataPath)
    return { files, directories }
  }

  prepare(args: readonly ScriptValue[]): {
    caption: string
    presentation: StorageSelectorPresentation
    choose(value: string): string
  } {
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
    const snapshot = this.namespace(save),
      requestedName = name ? parseStoragePath(name) : '',
      existingName =
        requestedName && !/[/>]$/.test(requestedName)
          ? (this.saves.resource(requestedName) ?? this.resources.find(requestedName))
          : undefined,
      directory = (value: string) => {
        if (!value) return undefined
        const normalized = normalizeSelectorPath(value)
        const candidate = /[/>]$/.test(normalized) ? normalized : normalized + '/'
        return this.directory(candidate, snapshot.directories)
      },
      nameDirectory = name
        ? directory(extractStoragePath(toPublicStoragePath(existingName?.name ?? requestedName)))
        : undefined,
      initialDirectory = nameDirectory ?? directory(initial) ?? 'game://./',
      rawIndex = Number(args[0]),
      filterIndex = filters.length
        ? rawIndex >= 1 && rawIndex <= filters.length
          ? rawIndex
          : 1
        : 0,
      presentation: StorageSelectorPresentation = Object.freeze({
        save,
        name,
        initialDirectory,
        defaultExtension: extension,
        filters: Object.freeze(filters),
        filterIndex,
        entries: Object.freeze([...snapshot.files.values()]),
        directories: Object.freeze([...snapshot.directories].sort()),
      })
    return {
      caption: args[3] === undefined ? (save ? '保存文件' : '打开文件') : text(args[3]),
      presentation,
      choose: (value) => this.choose(presentation, value),
    }
  }

  private directory(name: string, directories: ReadonlySet<string>): string | undefined {
    if (directories.has(name)) return name
    const matches = [...directories].filter((entry) => entry.toLowerCase() === name.toLowerCase())
    if (matches.length > 1) throw new Error(`Ambiguous storage directory: ${name}`)
    return matches[0]
  }

  private choose(request: StorageSelectorPresentation, encoded: string): string {
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
      original = saved ? undefined : this.resources.find(path),
      existing = saved ?? original,
      publicName = normalizeSelectorPath(existing?.name ?? path),
      snapshot = this.namespace(request.save),
      parent = this.directory(extractStoragePath(publicName), snapshot.directories)
    if (!parent) throw new Error('选择的目录不存在。')
    path = parseStoragePath(parent + extractStorageName(publicName))
    if (this.directory(toPublicStoragePath(path + '/'), snapshot.directories))
      throw new Error('请选择文件，而不是目录。')
    if (!request.save && !existing) throw new Error('选择的文件不存在。')
    if (request.save && existing && !overwrite) throw new Error('文件已存在，请确认覆盖。')
    const selected = normalizeSelectorPath(existing?.name ?? path)
    return `${filterIndex}\n${selected}`
  }
}
