import type { ArchiveReader, Resource } from '../ports/storage.ts'
import { StorageResolver } from './resolver.ts'
import { extractStoragePath, parseStoragePath, storageDirectoryPath, storageFilePath, toPublicStoragePath } from './public-path.ts'

/** Host startup configuration; these are not TJS Storages properties. */
export type ProjectSelection = { mode: 'collection' } |
  { mode: 'auto'; executableDirectory?: string; executable?: string } |
  { mode: 'root'; directory: string; executableDirectory?: string; executable?: string; distribution?: string }
/** Frozen logical addresses, relative to the imported namespace. */
export interface GameProject { directory: string; executableDirectory: string; executable?: string; distribution?: string }

function directory(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid project directory')
  return storageDirectoryPath(value === '' ? './' : /[\\/>]$/.test(value) ? value : value + '/')
}
function distributionPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid distribution ZIP path')
  const name = storageFilePath(value)
  if (name.includes('>')) throw new Error('Expected an imported distribution ZIP')
  return name
}
function executablePath(value: unknown, base: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid executable selection')
  const path = storageFilePath(value, base)
  if (path.includes('>')) throw new Error('Executable cannot be an archive member')
  return toPublicStoragePath(path)
}
export function copyGameProject(value?: GameProject): GameProject | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error('Invalid game project')
  const executableDirectory = directory(value.executableDirectory)
  const result = { directory: directory(value.directory), executableDirectory,
    ...(value.executable === undefined ? {} : { executable: executablePath(value.executable, executableDirectory) }),
    ...(value.distribution === undefined ? {} : { distribution: distributionPath(value.distribution) }) }
  if (result.executableDirectory.includes('>')) throw new Error('Executable directory cannot be inside an archive')
  return Object.freeze(result)
}
export function copyProjectSelection(value?: ProjectSelection): ProjectSelection {
  if (value === undefined) return { mode: 'collection' }
  if (!value || typeof value !== 'object') throw new Error('Invalid project selection')
  if (value.mode === 'collection') return { mode: 'collection' }
  if (value.mode !== 'auto' && value.mode !== 'root') throw new Error('Unknown project selection')
  const executableDirectory = directory(value.executableDirectory ?? '')
  if (executableDirectory.includes('>')) throw new Error('Executable directory cannot be inside an archive')
  const launcher = value.executable === undefined ? {} : { executable: executablePath(value.executable, executableDirectory) }
  if (value.mode === 'root') return { mode: 'root', directory: directory(value.directory), executableDirectory, ...launcher,
    ...(value.distribution === undefined ? {} : { distribution: distributionPath(value.distribution) }) }
  return { mode: 'auto', executableDirectory, ...launcher }
}

/** Use the imported spelling or the combined EXE that supplies the selected
 * project root. Ordinary sibling executables alone do not identify a launcher. */
export function projectExecutableResource(resources: readonly Resource[], project: GameProject, selected = project.executable): Resource | undefined {
  const candidates = resources.filter(({ name, aliasOf }) => !aliasOf && !name.includes('>') && /\.exe$/i.test(name))
  if (selected !== undefined) {
    const path = parseStoragePath(selected), exact = candidates.find((entry) => entry.name === path)
    if (exact) return exact
    const matches = candidates.filter((entry) => entry.name.toLowerCase() === path.toLowerCase())
    if (matches.length > 1) throw new Error('Ambiguous executable: ' + path)
    return matches[0]
  }
  const local = candidates.filter((entry) => extractStoragePath(entry.name).toLowerCase() === project.executableDirectory.toLowerCase())
  if (local.length === 1) return local[0]
  return local.find((entry) => project.directory.startsWith(entry.name + '>') && !/(?:^|\/)data\.exe$/i.test(entry.name))
}
export function findProjectExecutable(resources: readonly Resource[], project: GameProject, selected = project.executable): string | undefined {
  return projectExecutableResource(resources, project, selected)?.name
}

/** Automatic launch may see a game and its setup tools together. Inspect the
 * stored XP3 mark only. Two marked programs need the player's choice. */
async function findCombinedExecutable(executables: readonly Resource[], probe: (file: Resource) => Promise<boolean>): Promise<Resource | undefined> {
  let found: Resource | undefined
  for (const file of executables) {
    if (!await probe(file)) continue
    if (found) throw new Error('找到多个内嵌 XP3 的游戏程序，请在“游戏程序名”填写要启动的文件名。')
    found = file
  }
  return found
}

/** Decide only from actual imported files/indices. Never execute an EXE or
 * search an arbitrary descendant for a startup script. A selected but broken
 * project is an error, not permission to fall back to a different game. */
export function selectProject(resources: readonly Resource[], requested?: ProjectSelection,
  deferArchiveIndex = false): GameProject | undefined {
  const selection = copyProjectSelection(requested)
  if (selection.mode === 'collection') return undefined
  const files = new Map(resources.filter((file) => !file.aliasOf).map((file) => [file.name, file])),
    directories = new Set([''])
  for (const file of files.values()) {
    if (file.archiveKind || deferArchiveIndex && !file.name.includes('>')) directories.add(file.name + '>')
    for (let at = 0; at < file.name.length; at++)
      if (file.name[at] === '/' || file.name[at] === '>') directories.add(file.name.slice(0, at + 1))
  }
  const match = (name: string, candidates: Iterable<string>): string | undefined => {
    const values = [...candidates]
    if (values.includes(name)) return name
    const matches = values.filter((entry) => entry.toLowerCase() === name.toLowerCase())
    if (matches.length > 1) throw new Error(`Ambiguous project path: ${name}`)
    return matches[0]
  }, required = (name: string) => {
    const path = match(name, directories)
    if (path === undefined) throw new Error(`Project directory not found: ${name || './'}`)
    return path
  }, executableDirectory = required(selection.executableDirectory ?? '')
  if (selection.mode === 'root') return copyGameProject({ directory: required(selection.directory), executableDirectory })
  const archive = (name: string): string | undefined => {
    const path = match(name, files.keys())
    if (path === undefined) return undefined
    if (!deferArchiveIndex && !files.get(path)!.archiveKind) throw new Error(`Selected project is not a supported archive: ${path}`)
    return path + '>'
  }
  let chosen = match(executableDirectory + 'content-data/', directories)
  chosen ??= archive(executableDirectory + 'data.xp3')
  chosen ??= archive(executableDirectory + 'data.exe')
  if (chosen === undefined && selection.executable !== undefined) {
    const path = match(parseStoragePath(selection.executable), files.keys())
    if (path === undefined) throw new Error('Selected executable was not imported')
    if (files.get(path)!.archiveKind === 'xp3') chosen = path + '>'
  }
  chosen ??= match(executableDirectory + 'data/', directories)
  return copyGameProject({ directory: chosen ?? executableDirectory, executableDirectory })
}

/** Native project selection tests the raw data.xp3/data.exe existence. Only
 * the self-combined EXE step probes an XP3 mark; no archive index is opened. */
export async function selectProjectLazy(resources: readonly Resource[], requested: ProjectSelection | undefined,
  reader: ArchiveReader, checkpoint: () => Promise<void>,
  probe = (file: Resource) => reader.probeXp3(file, checkpoint)): Promise<GameProject | undefined> {
  const selection = copyProjectSelection(requested)
  if (selection.mode === 'collection') return undefined
  if (selection.mode === 'root' && selection.directory.includes('>') && !selection.directory.endsWith('>')) {
    const delimiter = selection.directory.indexOf('>'),
      root = selectProject(resources, { ...selection, directory: selection.directory.slice(0, delimiter + 1) }, true)!,
      resolver = new StorageResolver('', false, reader, checkpoint)
    resolver.mount([...resources])
    try {
      const directory = await resolver.listDirectory(root.directory + selection.directory.slice(delimiter + 1))
      return copyGameProject({ ...root, directory: directory.name })
    } finally { resolver.dispose() }
  }
  const selected = selectProject(resources, selection.mode === 'auto'
    ? { ...selection, executable: undefined } : selection, true)!
  if (selection.mode !== 'auto') return selected
  const fallback = selected.executableDirectory,
    atSelfStep = selected.directory.toLowerCase() === fallback.toLowerCase() ||
      selected.directory.toLowerCase() === (fallback + 'data/').toLowerCase()
  if (!atSelfStep) return selected
  let executable: Resource | undefined
  if (selection.executable === undefined) {
    const candidates = resources.filter((file) => !file.aliasOf && !file.name.includes('>') && /\.exe$/i.test(file.name) &&
      extractStoragePath(file.name).toLowerCase() === fallback.toLowerCase())
    executable = await findCombinedExecutable(candidates, probe)
  } else {
    const resolver = new StorageResolver()
    resolver.mount([...resources])
    const named = resolver.find(parseStoragePath(selection.executable))
    if (!named) throw new Error('Selected executable was not imported')
    await checkpoint()
    if (await probe(named)) executable = named
  }
  await checkpoint()
  return executable ? copyGameProject({ ...selected, directory: executable.name + '>' }) : selected
}
