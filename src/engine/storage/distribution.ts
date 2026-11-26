import type { ArchiveReader, Resource } from '../ports/storage.ts'
import type { CddaDisc } from '../ports/cdda.ts'
import { selectBootDisc } from './boot-disc.ts'
import { distributionDiscBindings } from './cdda.ts'
import { copyGameProject, copyProjectSelection, findProjectExecutable, packagedDiscPath, selectProjectLazy, type GameProject, type ProjectSelection } from './project.ts'
import { discAddress, extractStorageName, extractStoragePath, nativeDiscPath, parseStoragePath, toPublicStoragePath } from './public-path.ts'

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
  entryName: string, relativeEntry: boolean, allowSingleExecutable = true): Promise<ProjectLocation | undefined> {
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
  if (allowSingleExecutable && source === 'zip' && folder === undefined && executables.length === 1) folder = extractStoragePath(executables[0]!.name)
  if (folder === undefined) return
  return { mode: 'auto', executableDirectory: folder, executable: selectedExe && toPublicStoragePath(selectedExe) }
}

/** Collection mode can try optical boot when no loose game script or
 * container was supplied. An existing loose game's selection is unchanged. */
export function discOnlyInput(names: readonly string[]): boolean {
  return names.some((name) => /\.(?:iso|cue)$/i.test(name)) &&
    names.every((name) => /\.(?:iso|cue|bin|img|wav|mp3|aiff?|txt|md)$/i.test(name))
}
export async function prepareProject(resources: Resource[], requested: ProjectSelection, reader: ArchiveReader,
  checkpoint: () => Promise<void>, entry = 'startup.tjs', discs?: readonly CddaDisc[],
  decodeText: ArchiveReader['decodeText'] = reader.decodeText?.bind(reader)): Promise<{
    resources: Resource[]; project?: GameProject; configFiles?: Resource[]; discImports?: Resource[]
  }> {
  const setting = copyProjectSelection(requested)
  const collection = setting.mode === 'collection'
  const onlyDiscs = discOnlyInput(resources.map((file) => file.name))
  if (collection && !onlyDiscs) return { resources }
  const selection: ProjectLocation = setting.mode === 'collection' ? { mode: 'auto' } : setting
  // Use the same optional entry hint for ZIP members and loose imports. The
  // original address is still resolved from the selected project by start().
  let entryName = '', entryInArchive = false
  const relativeEntry = !/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(entry)
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
  const entryDisc = discAddress(nativeDiscPath(entry) ?? entry)
  const wantsDisc = (choice: ProjectLocation) => Boolean(
    choice.mode === 'root' && (choice.bootDisc || discAddress(choice.directory)) ||
    choice.executable && (/\.(?:iso|cue)$/i.test(choice.executable) || discAddress(choice.executable)) ||
    discAddress(choice.executableDirectory ?? ''))
  const boot = (sources: Resource[], location: ProjectLocation, distribution?: string, optionalMedia = false) =>
    selectBootDisc(sources, location, distributionDiscBindings(discs, distribution), reader, checkpoint, decodeText, async (files, choice) => {
      const hint = entryDisc ? entryDisc.path.split('>', 1)[0]!.toLowerCase() : entryName
      const game = await locateGame(files, choice, checkpoint, probe, 'files', hint, relativeEntry || !!entryDisc, false)
      return game && select(files, game)
    }, entryDisc?.drive, distribution, optionalMedia)
  const mountDistribution = async (archive: Resource, choice: ProjectLocation,
    mode: 'selected' | 'frozen' | 'candidate' = 'selected') => {
    const frozen = mode === 'frozen', optionalZip = mode === 'candidate'
    let index: Awaited<ReturnType<ArchiveReader['open']>>
    try {
      index = /\.exe$/i.test(archive.name) && !frozen
        ? await reader.openDistribution?.(archive, checkpoint) : await reader.open(archive, checkpoint)
    } catch (error) {
      if (!optionalZip || error instanceof Error && error.name === 'AbortError') throw error
      // Unselected side files may be unreadable or not really ZIPs. Keep
      // cancellation authoritative, and never soften a selected package.
      await checkpoint()
      return
    }
    await checkpoint()
    if (index?.kind !== 'zip') {
      if (frozen) throw new Error('Saved game distribution is not a ZIP')
      return
    }
    const candidateProbe = optionalZip ? async (file: Resource) => {
      try { return await probe(file) }
      catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        await checkpoint(); return false
      }
    } : probe
    let members: Resource[]
    try { members = reader.joinVolumes ? await reader.joinVolumes(index.entries, checkpoint) : [...index.entries] }
    catch (error) {
      if (!optionalZip || error instanceof Error && error.name === 'AbortError') throw error
      await checkpoint()
      // A damaged auxiliary archive is not a game selection. Native data
      // pieces or a real startup/combined executable still identify a game,
      // so its original volume error must not turn into silent fallback.
      if (index.entries.some((file) => /(?:^|\/)data\.(?:xp3|exe)\.\d{3,}$/i.test(file.name))) throw error
      let game: ProjectLocation | undefined
      try { game = await locateGame(index.entries, choice, checkpoint, candidateProbe, 'zip', entryName, relativeEntry, false) }
      catch (discoveryError) {
        if (discoveryError instanceof Error && discoveryError.name === 'AbortError') throw discoveryError
        throw error
      }
      if (game) throw error
      return
    }
    const explicitDisc = frozen ? choice.mode === 'root' && !!choice.bootDisc : wantsDisc(choice) || !!entryDisc
    const containsDisc = members.some((file) => /\.(?:iso|cue)$/i.test(file.name))
    // A loose installed game wins over its bundled data disc. A lone setup
    // utility is only a fallback after looking for a game on the media.
    let inner = explicitDisc ? undefined : await locateGame(members, choice, checkpoint, candidateProbe, 'zip',
      entryName, relativeEntry, !optionalZip && !containsDisc)
    const disc = !inner && (explicitDisc || containsDisc && !frozen)
      ? await boot(members, choice, archive.name, optionalZip) : undefined
    if (!inner && !disc && containsDisc && !optionalZip && !explicitDisc)
      inner = await locateGame(members, choice, checkpoint, candidateProbe, 'zip', entryName, relativeEntry)
    if (!inner && !disc) return
    const names = new Set<string>()
    for (const entry of members) {
      if (names.has(entry.name)) throw new Error('Duplicate ZIP distribution member: ' + entry.name)
      names.add(entry.name)
      if (names.size % 256 === 0) await checkpoint()
    }
    const project = disc?.project ?? await select(members, inner!)
    // Discs beside the selected release belong to its optical drives. Their
    // archives and loose files must not become installed scripts or assets.
    const discImports = resources.filter((file) => file !== archive && !file.aliasOf && !file.name.includes('>'))
    const hasDiscImports = discImports.length > 0 && (discImports.some((file) => /\.(?:cue|iso|zip)$/i.test(file.name)) ||
      discs?.some((disc) => disc.cue.includes('>')))
    return { resources: members, project: copyGameProject({ ...project, distribution: archive.name })!,
      ...(hasDiscImports && { discImports }),
      ...(disc && { configFiles: disc.configFiles }) }
  }
  if (collection) return await boot(resources, selection) ?? { resources }
  if (selection.mode === 'root' && selection.distribution !== undefined) {
    const archive = resources.find((file) => file.name === selection.distribution)
    if (!archive) throw new Error('Saved game distribution ZIP is missing: ' + selection.distribution)
    const mounted = await mountDistribution(archive, selection, 'frozen')
    if (!mounted) throw new Error('Saved game project is missing from ' + archive.name)
    return mounted
  }
  const originals = resources.filter((file) => !file.aliasOf && !file.name.includes('>'))
  const selectedExe = selection.executable && parseStoragePath(selection.executable)
  const optical = selectedExe ? packagedDiscPath(selectedExe) : undefined
  const requestedFile = optical?.distribution ?? selectedExe
  const matches = requestedFile ? originals.filter((file) => file.name.toLowerCase() === requestedFile.toLowerCase()) : []
  const exact = matches.find((file) => file.name === requestedFile)
  if (!exact && matches.length > 1) throw new Error('Ambiguous executable: ' + requestedFile)
  const named = exact ?? matches[0]
  if (optical) {
    if (!named) throw new Error('找不到所选光盘的发行包：' + optical.distribution)
    const mounted = await mountDistribution(named, { ...selection, executable: toPublicStoragePath(optical.disc) })
    if (!mounted) throw new Error('未能从所选发行包读取光盘：' + selectedExe)
    return mounted
  }
  // A disc-qualified project or entry can select media from the only
  // imported release, even when no physical ISO appears beside that ZIP.
  const outer = named || (originals.length === 1 ? originals[0] : undefined)
  if (outer && /\.(?:zip|exe)$/i.test(outer.name) && (wantsDisc(selection) || entryDisc)) {
    const mounted = await mountDistribution(outer, named ? { ...selection, executable: undefined } : selection)
    if (mounted) return mounted
  }
  if (wantsDisc(selection) ||
      (onlyDiscs && (entryDisc || selection.executableDirectory || selection.executable || selection.mode === 'root' && !selection.distribution))) {
    const mounted = await boot(resources, selection)
    if (!mounted) throw new Error('找不到指定的启动光盘。')
    return mounted
  }
  if (selection.mode === 'root') return { resources, project: await select(resources, selection) }
  // An explicit outer.zip>entry keeps that archive address resolvable.
  if (outer && /\.(?:zip|exe)$/i.test(outer.name) && !(entryInArchive && entryName === outer.name.toLowerCase())) {
    // Naming the installer selects the package. Its game has its own program
    // directory and optional engine executable inside.
    const choice = named ? { mode: 'auto' as const } : selection
    const mounted = await mountDistribution(outer, choice)
    if (mounted) return mounted
  }
  if (selection.executableDirectory) return { resources, project: await select(resources, selection) }
  const location = await locateGame(originals, selection, checkpoint, probe, 'files', entryName, relativeEntry)
  if (!location && !outer && !entryInArchive && !selection.executable) {
    // A release folder may include a readme alongside its installer. Loose
    // games and native combined executables above keep their original priority.
    let found: Awaited<ReturnType<typeof mountDistribution>>
    for (const file of originals) {
      if (!/\.exe$/i.test(file.name)) continue
      const mounted = await mountDistribution(file, selection)
      if (!mounted) continue
      if (found) throw new Error('找到多个自解压 ZIP 游戏，请在“游戏程序名”填写所选发行包的路径。')
      found = mounted
    }
    if (found) return found
    // Preserve the preceding native/SFX result and identity. Only a collection
    // with no loose/native project enters ordinary ZIP discovery. An XP3 input
    // remains an explicit native resource rather than being silently discarded.
    if (!originals.some((file) => file.archiveKind === 'xp3' || /\.xp3$/i.test(file.name))) {
      let ordinary: Awaited<ReturnType<typeof mountDistribution>>
      for (const file of originals) {
        if (!/\.zip$/i.test(file.name)) continue
        const mounted = await mountDistribution(file, selection, 'candidate')
        if (!mounted) continue
        if (ordinary) throw new Error('找到多个 ZIP 游戏发行包，请在“游戏程序名或发行包”填写所选发行包的路径，例如“' +
          ordinary.project.distribution + '”或“' + file.name + '”。')
        ordinary = mounted
      }
      if (ordinary) return ordinary
    }
  }
  if (!location && !entryInArchive && !selection.executable) {
    const mounted = await boot(resources, selection)
    if (mounted) return mounted
  }
  return { resources, project: await select(resources, location ?? selection) }
}
