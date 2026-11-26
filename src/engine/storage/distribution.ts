import type { ArchiveReader, Resource } from '../ports/storage.ts'
import { copyGameProject, copyProjectSelection, findProjectExecutable, selectProjectLazy, type GameProject, type ProjectSelection } from './project.ts'
import { extractStorageName, extractStoragePath, parseStoragePath, toPublicStoragePath } from './public-path.ts'

// Identify the launcher directory in an imported tree before applying KRKR's
// native project selection. Wrapping directories remain part of every path.
async function gameFolder(entries: readonly Resource[], checkpoint: () => Promise<void>,
  probe: (file: Resource) => Promise<boolean>, entryName: string): Promise<string | undefined> {
  const locations = new Map<string, { data: boolean; executables: Resource[] }>()
  let seen = 0
  for (const file of entries) {
    if (++seen % 256 === 0) await checkpoint()
    const slash = file.name.lastIndexOf('/'), base = file.name.slice(slash + 1).toLowerCase()
    const isEntry = base === 'startup.tjs' || (entryName !== '' && base === entryName)
    const data = base === 'data.xp3' || base === 'data.exe' || isEntry
    if (!data && !base.endsWith('.exe')) continue
    let dir = file.name.slice(0, slash + 1)
    if (isEntry) {
      const parent = dir.slice(0, -1), start = parent.lastIndexOf('/') + 1
      if (['content-data', 'data'].includes(parent.slice(start).toLowerCase())) dir = parent.slice(0, start)
    }
    const location = locations.get(dir) ?? { data: false, executables: new Array<Resource>() }
    if (data) location.data = true
    else location.executables.push(file)
    locations.set(dir, location)
  }
  // Parents sort before their children, so an embedded game takes precedence
  // over a sample startup.tjs shipped in a subdirectory. Siblings are choices.
  let first: string | undefined
  for (const dir of [...locations.keys()].sort()) {
    if (first !== undefined && dir.startsWith(first)) continue
    const location = locations.get(dir)!
    let found = location.data
    for (const file of location.executables) {
      if (found) break
      found = await probe(file)
    }
    if (!found) continue
    if (first !== undefined) throw new Error('导入的文件中包含多个游戏，请在“程序所在目录”指定要启动的目录。')
    first = dir
  }
  return first
}

type ProjectLocation = Exclude<ProjectSelection, { mode: 'collection' }>
async function locateGame(entries: readonly Resource[], selection: ProjectLocation,
  checkpoint: () => Promise<void>, probe: (file: Resource) => Promise<boolean>, source: 'zip' | 'files',
  entryName: string, relativeEntry: boolean): Promise<ProjectLocation | undefined> {
  if (selection.mode === 'root' || selection.executableDirectory) return selection
  // A relative entry such as scripts/boot.tjs names both the script and its
  // intended working directory. Find that exact suffix in a wrapped release;
  // a bundled sample's startup.tjs must not take precedence over it.
  if (!selection.executable && relativeEntry && entryName.includes('/')) {
    const roots = new Set<string>(), componentsToRemove = entryName.split('/').length
    for (const [i, file] of entries.entries()) {
      if (i % 256 === 0) await checkpoint()
      const path = file.name.toLowerCase()
      if (path === entryName) { roots.clear(); roots.add(''); break }
      if (path.endsWith('/' + entryName)) {
        // Remove whole components from the original spelling. Unicode
        // lowercase mappings can change UTF-16 length.
        const components = file.name.split('/')
        roots.add(components.slice(0, -componentsToRemove).join('/') + '/')
      }
    }
    if (roots.size > 1) throw new Error('导入的文件中有多个匹配的入口脚本，请指定游戏目录。')
    const directory = roots.values().next().value
    if (directory !== undefined) {
      const executableDirectory = /(?:^|\/)(?:content-data|data)\/$/i.test(directory)
        ? extractStoragePath(directory.slice(0, -1)) : directory
      return { mode: 'root', directory, executableDirectory }
    }
  }
  // An entry addressed from the import root has the same meaning in a ZIP.
  // Loose imports also keep their established data/content-data roots even
  // if a sample is bundled alongside them.
  if (!selection.executable && entries.some((file) =>
    file.name.toLowerCase() === entryName || source === 'files' &&
    /^(?:data\/|content-data\/|startup\.tjs$|data\.(?:xp3|exe)$)/i.test(file.name))) return selection
  const executables = entries.filter((file) => /\.exe$/i.test(file.name))
  let selectedExe = selection.executable && parseStoragePath(selection.executable)
  if (selectedExe && !selectedExe.includes('/')) {
    const folded = selectedExe.toLowerCase()
    // Resolve a bare launcher name beside its game in a wrapped release.
    if (!executables.some((file) => file.name.toLowerCase() === folded)) {
      const named = executables.filter((file) => extractStorageName(file.name).toLowerCase() === folded)
      if (named.length > 1) throw new Error('导入的文件中有多个同名程序，请填写程序所在目录。')
      if (named.length) selectedExe = named[0]!.name
    }
  }
  let folder = selectedExe ? extractStoragePath(selectedExe) : await gameFolder(entries, checkpoint, probe, entryName)
  if (source === 'zip' && folder === undefined && executables.length === 1) folder = extractStoragePath(executables[0]!.name)
  if (folder === undefined) return
  return { mode: 'auto', executableDirectory: folder, executable: selectedExe && toPublicStoragePath(selectedExe) }
}

export async function prepareProject(resources: Resource[], requested: ProjectSelection, reader: ArchiveReader,
  checkpoint: () => Promise<void>, entry = 'startup.tjs'): Promise<{ resources: Resource[]; project?: GameProject }> {
  const selection = copyProjectSelection(requested)
  if (selection.mode === 'collection') return { resources }
  // Use the same optional entry hint for ZIP members and loose imports. The
  // original address is still resolved from the selected project by start().
  let entryName = '', entryInArchive = false
  const relativeEntry = !/^(?:game:|[\\/])/i.test(entry)
  try {
    const path = parseStoragePath(entry)
    entryName = path.split('>', 1)[0]!.toLowerCase()
    entryInArchive = path.includes('>')
  }
  catch {
    // Parent-relative entries can be valid only after project selection.
  }
  // The ZIP wrapper and the selected program directory can inspect the same
  // immutable member. Keep successful lookups only for this one launch.
  const marks = new Map<Resource, boolean>()
  const probe = async (file: Resource) => {
    await checkpoint()
    let combined = marks.get(file)
    if (combined === undefined) {
      combined = await reader.probeXp3(file, checkpoint)
      await checkpoint()
      marks.set(file, combined)
    }
    return combined
  }
  const select = async (files: Resource[], choice: ProjectLocation) => {
    const project = (await selectProjectLazy(files, choice, reader, checkpoint, probe))!
    if (!choice.executable) return project
    const chosen = findProjectExecutable(files, project, choice.executable)
    if (choice.mode === 'auto' && !chosen) throw new Error('未找到指定的游戏程序：' + choice.executable)
    if (chosen && chosen === findProjectExecutable(files, project)) return project
    // Keep the player's choice across library reopen when more than one
    // launcher shares the project. Existing project/save IDs stay stable.
    return copyGameProject({ ...project, executable: chosen ? toPublicStoragePath(chosen) : choice.executable })!
  }
  const savedZip = selection.mode === 'root' ? selection.distribution : undefined
  // An explicit outer.zip>entry keeps that archive address resolvable. A
  // frozen library distribution is authoritative even if its entry changes.
  const archive = savedZip !== undefined ? resources.find((file) => file.name === savedZip)
    : selection.mode === 'auto' && resources.length === 1 && /\.zip$/i.test(resources[0]!.name) &&
      !(entryInArchive && entryName === resources[0]!.name.toLowerCase()) ? resources[0] : undefined
  if (savedZip !== undefined && !archive) throw new Error('Saved game distribution ZIP is missing: ' + savedZip)
  if (archive) {
    const index = await reader.open(archive, checkpoint)
    await checkpoint()
    if (savedZip !== undefined && index?.kind !== 'zip') throw new Error('Saved game distribution is not a ZIP')
    if (index?.kind === 'zip') {
      const members = reader.joinVolumes ? await reader.joinVolumes(index.entries, checkpoint) : [...index.entries]
      const inner = await locateGame(members, selection, checkpoint, probe, 'zip', entryName, relativeEntry)
      if (inner) {
        const names = new Set<string>()
        for (const entry of members) {
          if (names.has(entry.name)) throw new Error('Duplicate ZIP distribution member: ' + entry.name)
          names.add(entry.name)
          if (names.size % 256 === 0) await checkpoint()
        }
        const project = await select(members, inner)
        return { resources: members, project: copyGameProject({ ...project, distribution: archive.name }) }
      }
    }
  }
  if (selection.mode === 'root' || selection.executableDirectory) return { resources, project: await select(resources, selection) }
  const originals = resources.filter((file) => !file.aliasOf && !file.name.includes('>'))
  // The player's explicit entry can be a loose script or an archive address.
  // Its physical file at the import root must take precedence over bundled demos.
  const location = await locateGame(originals, selection, checkpoint, probe, 'files', entryName, relativeEntry)
  return { resources, project: await select(resources, location ?? selection) }
}
