import type { DiscFilesystem } from '../../formats/disc/filesystem.ts'
import { copyCddaDiscs, type CddaDisc } from '../ports/cdda.ts'
import type { ArchiveReader, Resource } from '../ports/storage.ts'
import { CddaDiscs } from './cdda.ts'
import { copyGameProject, type GameProject, type ProjectSelection } from './project.ts'
import { discAddress, discStoragePath, extractStoragePath, parseStoragePath, storageFilePath, toPublicStoragePath } from './public-path.ts'
import { resourceReadBounds } from './resource-source.ts'
import { StorageResolver } from './resolver.ts'

type Location = Exclude<ProjectSelection, { mode: 'collection' }>
type Select = (files: Resource[], selection: Location) => Promise<GameProject | undefined>

/** Inspect directory metadata for project selection. Each file reads its own
 * extents only if selection actually needs its executable, config or index. */
async function projectFiles(fs: DiscFilesystem, directories: string[], recursive: boolean, checkpoint: () => Promise<void>): Promise<Resource[]> {
  const files: Resource[] = [], pending = [...new Set(directories)]
  let count = 0, units = 0
  while (pending.length) {
    await checkpoint()
    const prefix = pending.pop()!
    const entries = await fs.list(prefix)
    if (!entries) continue
    for (const entry of entries) {
      const name = prefix + entry.name
      if (++count > 250000 || (units += name.length) > 16 * 1024 * 1024)
        throw new Error('Disc project directory exceeds the game namespace budget')
      if (count % 256 === 0) await checkpoint()
      if (entry.directory) { if (recursive) pending.push(name + '/'); continue }
      const source = { size: entry.size, async read(offset: number, length: number) {
        const file = await fs.file(name)
        if (!file || file.size !== entry.size) throw new Error('Disc file disappeared: ' + name)
        return file.read(offset, length)
      } }
      files.push({ name, size: entry.size, source, read: () => {
        resourceReadBounds(entry.size, 0, entry.size)
        return source.read(0, entry.size)
      } })
    }
  }
  return files
}

export async function selectBootDisc(resources: Resource[], selection: Location, supplied: readonly CddaDisc[] | undefined,
  reader: ArchiveReader, checkpoint: () => Promise<void>, decodeText: ArchiveReader['decodeText'], select: Select, entryDrive?: string,
  distribution?: string, optionalMedia = false) {
  const frozen = selection.mode === 'root' && selection.bootDisc
  const at = discAddress(selection.executableDirectory ?? '') ?? (selection.mode === 'root' ? discAddress(selection.directory) : undefined)
    ?? discAddress(selection.executable ?? '')
  const expectedDrive = at?.drive ?? entryDrive
  const launcher = selection.executable && parseStoragePath(selection.executable)
  const named = frozen || (launcher && !discAddress(launcher) && /\.(?:iso|cue)$/i.test(launcher) ? launcher : undefined)
  const originals = resources.filter((file) => !file.aliasOf && !file.name.includes('>') && /\.(?:iso|cue)$/i.test(file.name))
  if (!originals.length && !named && !at) return
  const storage = new StorageResolver('', false, reader, checkpoint)
  try {
    storage.mount(resources)
    const configured = copyCddaDiscs(supplied)
    const available = configured?.map((disc) => {
      const path = storageFilePath(disc.cue)
      return { ...disc, cue: storage.find(path)?.name ?? path }
    })
    const fixed = named ? storage.find(named) : undefined
    if (named && !fixed) throw new Error('找不到启动光盘：' + named)
    const backing = fixed ? [fixed] : originals
    const choices = backing.flatMap((file) => {
      const candidates = available?.filter((disc) => disc.cue === file.name)
      // On reopen keep the same source and follow its current drive binding.
      const disc = candidates?.find((item) => item.drive === expectedDrive) ?? candidates?.[0]
      if (available && !disc) return []
      if (!frozen && expectedDrive && expectedDrive !== (disc?.drive ?? 'D')) return []
      return [{ file, drive: disc?.drive ?? 'D' }]
    })
    if (!choices.length && (named || expectedDrive)) throw new Error('所选光盘没有绑定到游戏盘符。')
    const sheetImages = new Set<string>()
    let unreadable: unknown
    const open = async ({ file, drive }: typeof choices[number]) => {
      const discs = new CddaDiscs({ currentDirectory: '', exists: async (name) => !!storage.find(name),
        exact: (name) => storage.findAsync(name), cues: async () => [], read: (resource) => resource.read(),
        decodeText: (bytes) => {
          if (!decodeText) throw new Error('A host text decoder is required to open a CUE sheet')
          return decodeText(bytes)
        }, checkpoint }, [{ drive, cue: toPublicStoragePath(file.name) }])
      const mounted = await discs.openDataDisc(drive).catch(async (error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') throw error
        await checkpoint()
        if (named || expectedDrive) throw error
        unreadable ??= error
        return undefined
      })
      if (!mounted) return
      if (/\.cue$/i.test(file.name)) sheetImages.add(mounted.image)
      const relative = (value: string) => discAddress(value)?.path ?? value
      const exeDir = relative(selection.executableDirectory ?? '')
      const exe = launcher && launcher !== named ? toPublicStoragePath(relative(launcher)) : undefined
      let choice: Location = { mode: 'auto', executableDirectory: exeDir, executable: exe }
      if (selection.mode === 'root') {
        const directory = relative(selection.directory)
        choice = { mode: 'root', directory, executableDirectory: exeDir || extractStoragePath(directory.split('>')[0]!), executable: exe }
      }
      const roots = [choice.executableDirectory ?? '']
      if (choice.mode === 'root') roots.push(choice.directory.includes('>')
        ? extractStoragePath(choice.directory.split('>', 1)[0]!) : choice.directory)
      // Keep recorded filenames for XP3/ZIP resolution. Canonical file-medium
      // paths below follow the original Win32 ASCII case folding.
      const files = await projectFiles(mounted.filesystem, roots, choice.mode !== 'root', checkpoint).catch(async (error: unknown) => {
        if (!optionalMedia || named || expectedDrive || error instanceof Error && error.name === 'AbortError') throw error
        await checkpoint()
        return undefined
      })
      if (!files?.length) return
      const inner = await select(files, choice)
      if (!inner) return
      const qualify = (path: string) => discStoragePath(drive, parseStoragePath(path))
      const project = copyGameProject({ bootDisc: file.name, directory: qualify(inner.directory),
        executableDirectory: qualify(inner.executableDirectory), executable: inner.executable && qualify(inner.executable) })!
      const configFiles = files.filter((item) => /\.(?:exe|cf|cfu)$/i.test(item.name))
        .map((item) => ({ ...item, name: qualify(item.name) }))
      return { resources, project, configFiles }
    }
    // A sheet and its referenced ISO describe one disc. A different ISO
    // alongside that sheet may contain a second game requiring a choice.
    let found: Awaited<ReturnType<typeof open>>
    for (const suffix of [/\.cue$/i, /\.iso$/i]) {
      for (const item of choices.filter(({ file }) => suffix.test(file.name))) {
        if (sheetImages.has(item.file.name)) continue
        const result = await open(item)
        if (!result) continue
        if (found) {
          const prefix = distribution ? distribution + '>' : ''
          throw new Error('找到多张可启动的光盘，请在“游戏程序名或发行包”指定“' +
            prefix + found.project.bootDisc + '”或“' + prefix + result.project.bootDisc + '”。')
        }
        found = result
      }
    }
    if (found) return found
    if (unreadable && !optionalMedia) throw unreadable
    if (named || expectedDrive) throw new Error('选定的光盘里没有找到 KRKR2 游戏入口。')
  } finally { storage.dispose() }
}
