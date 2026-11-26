import type { ArchiveReader, Resource } from '../ports/storage.ts'
import { copyGameProject, copyProjectSelection, findProjectExecutable, selectProjectLazy, type GameProject, type ProjectSelection } from './project.ts'
import { extractStorageName, extractStoragePath, parseStoragePath, toPublicStoragePath } from './public-path.ts'

// An outer ZIP can be the directory tree a player would normally unpack.
// Only the real game archive below that directory uses KRKR's '>' delimiter.
async function gameFolder(entries: readonly Resource[], checkpoint: () => Promise<void>): Promise<string | undefined> {
  const locations = new Set<string>()
  let seen = 0
  for (const { name } of entries) {
    if (++seen % 256 === 0) await checkpoint()
    const slash = name.lastIndexOf('/'), dir = name.slice(0, slash + 1), base = name.slice(slash + 1).toLowerCase()
    if (base === 'data.xp3' || base === 'data.exe') locations.add(dir)
    else if (base === 'startup.tjs') {
      const parent = dir.slice(0, -1), start = parent.lastIndexOf('/') + 1
      const data = ['content-data', 'data'].includes(parent.slice(start).toLowerCase())
      locations.add(data ? parent.slice(0, start) : dir)
    }
  }
  // Prefer the outer game over examples/tools inside its own directory.
  // Two separate games require the player's Program directory selection.
  const [first, ...others] = [...locations].sort()
  if (first && others.some((dir) => !dir.startsWith(first)))
    throw new Error('ZIP 中包含多个游戏，请在“程序所在目录”指定要启动的目录。')
  return first
}

type ProjectLocation = Exclude<ProjectSelection, { mode: 'collection' }>
async function selectInside(entries: readonly Resource[], selection: ProjectLocation,
  checkpoint: () => Promise<void>): Promise<ProjectLocation | undefined> {
  if (selection.mode === 'root') return selection
  const executables = entries.filter((file) => /\.exe$/i.test(file.name))
  let selectedExe = selection.executable && parseStoragePath(selection.executable)
  if (!selection.executableDirectory && selectedExe && !selectedExe.includes('/')) {
    const folded = selectedExe.toLowerCase()
    // A ZIP often wraps the whole release in a top-level directory. Resolve
    // a supplied filename there when it identifies exactly one launcher.
    if (!executables.some((file) => file.name.toLowerCase() === folded)) {
      const named = executables.filter((file) => extractStorageName(file.name).toLowerCase() === folded)
      if (named.length > 1) throw new Error('ZIP 中有多个同名程序，请填写程序所在目录。')
      if (named.length) selectedExe = named[0]!.name
    }
  }
  let folder = selection.executableDirectory || (selectedExe ? extractStoragePath(selectedExe) : await gameFolder(entries, checkpoint))
  if (folder === undefined && executables.length === 1) folder = extractStoragePath(executables[0]!.name)
  if (folder === undefined) return
  return { mode: 'auto', executableDirectory: folder, executable: selectedExe && toPublicStoragePath(selectedExe) }
}

export async function prepareProject(resources: Resource[], requested: ProjectSelection, reader: ArchiveReader,
  checkpoint: () => Promise<void>): Promise<{ resources: Resource[]; project?: GameProject }> {
  const selection = copyProjectSelection(requested)
  if (selection.mode === 'collection') return { resources }
  const select = async (files: Resource[], choice: ProjectLocation) => {
    const inferred = choice.mode === 'auto' && !choice.executable
      ? findProjectExecutable(files, { directory: '', executableDirectory: choice.executableDirectory ?? '' })
      : undefined
    const project = (await selectProjectLazy(files, inferred ? { ...choice, executable: toPublicStoragePath(inferred) } : choice,
      reader, checkpoint))!
    if (!choice.executable) return project
    const chosen = findProjectExecutable(files, project, choice.executable)
    if (chosen && chosen === findProjectExecutable(files, project)) return project
    // Keep the player's choice across library reopen when more than one
    // launcher shares the project. Existing project/save IDs stay stable.
    return copyGameProject({ ...project, executable: chosen ? toPublicStoragePath(chosen) : choice.executable })!
  }
  const savedZip = selection.mode === 'root' ? selection.distribution : undefined
  const archive = savedZip !== undefined ? resources.find((file) => file.name === savedZip)
    : selection.mode === 'auto' && resources.length === 1 && /\.zip$/i.test(resources[0]!.name) ? resources[0] : undefined
  if (savedZip !== undefined && !archive) throw new Error('Saved game distribution ZIP is missing: ' + savedZip)
  if (archive) {
    const index = await reader.open(archive, checkpoint)
    await checkpoint()
    if (savedZip !== undefined && index?.kind !== 'zip') throw new Error('Saved game distribution is not a ZIP')
    if (index?.kind === 'zip') {
      const inner = await selectInside(index.entries, selection, checkpoint)
      if (inner) {
        const members = [...index.entries], names = new Set<string>()
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
  return { resources, project: await select(resources, selection) }
}
