import { cueLimits, cueTrackParts, parseCue, type CueSheet } from '../../formats/audio/cue.ts'
import { copyCddaDiscs, isDiscMedium, isDiscSheet, type CddaDisc, type CddaPcmPart, type CddaPcmTrack, type DiscChange } from '../ports/cdda.ts'
import { parseCloneCd } from '../../formats/disc/ccd.ts'
import { dosNameDecoder, type LegacyNameEncoding } from '../../formats/text/legacy-names.ts'
import { discVolumeTrack, readDiscVolumeLabel, type DiscVolumeTrack } from '../../formats/disc/volume-label.ts'
import { openDiscFilesystem, type DiscFilesystem } from '../../formats/disc/filesystem.ts'
import { openResourceSource } from './resource-source.ts'
import { ExecutionCancelled } from '../scheduler/control.ts'
import type { ArchiveReader, Resource } from '../ports/storage.ts'
import { TvpError } from '../system/tvp-error.ts'
import { discAddress, extractStorageName, storageFilePath, toPublicStoragePath } from './public-path.ts'
import type { AudioResourceSources, AudioSourceLease } from './audio-sources.ts'
import { StorageResolver } from './resolver.ts'

/** A ZIP distribution mounts its members at the import root. A binding may
 * use that root directly or spell out the selected outer ZIP's address. */
export function distributionDiscBindings(discs: readonly CddaDisc[] | undefined, distribution: string | undefined) {
  const copied = copyCddaDiscs(discs)
  if (!copied || distribution === undefined) return copied
  return copied.map((disc) => {
    const member = distributionMember(disc.cue, distribution)
    return member ? { ...disc, cue: toPublicStoragePath(member) } : disc
  })
}

function distributionMember(cue: string, distribution?: string): string | undefined {
  const split = cue.indexOf('>')
  if (!distribution || split < 0) return
  let outer: string
  try { outer = storageFilePath(cue.slice(0, split)) } catch { return }
  if (outer.toLowerCase() !== storageFilePath(distribution).toLowerCase()) return
  const path = storageFilePath(cue)
  return path.slice(path.indexOf('>') + 1)
}

type BoundDisc = CddaDisc & { imported?: boolean; picked?: StorageResolver; revision?: number }
interface DiscFile { name: string; resource?: Resource; exact(name: string): Promise<Resource | undefined> }
type DiscImports = Pick<StorageResolver, 'find' | 'findAsync' | 'knownResources' | 'archiveEntries'>

async function opticalFiles(files: Iterable<Resource>, checkpoint: () => Promise<void>): Promise<string[]> {
  const sheets: string[] = [], images: string[] = []
  let scanned = 0
  for (const file of files) {
    if (++scanned % 4096 === 0) await checkpoint()
    if (isDiscSheet(file.name)) sheets.push(file.name)
    else if (/\.iso$/i.test(file.name) && images.length < 2) images.push(file.name)
    if (sheets.length === 2) break
  }
  return sheets.length ? sheets : images
}

type SelectedPart = ({ kind: 'silence'; frames: number } | {
  kind: 'file'; resource: Resource; encoding: 'encoded' | 's16le' | 's16be'; startFrame: number; endFrame?: number
}) & { preEmphasis?: true }
export interface CddaSelection { readonly drive: string; readonly cue: string; readonly track: number; readonly parts?: readonly SelectedPart[]; readonly revision?: number }
/** Marks only this resolver's explicit-drive rejection, not provider errors. */
export class InvalidCddaDrive extends TvpError {
  constructor() { super('TVPInvalidCDDADrive') }
}
export interface CddaStorage {
  decodeName?(bytes: Uint8Array): string
  joinBlobs?: ArchiveReader['joinBlobs']
  /** Ordinary existing files retain the historical direct-file open path. */
  exists(name: string): Promise<boolean>
  exact(logical: string): Promise<Resource | undefined>
  cues(): Promise<string[]>
  read(resource: Resource): Promise<Uint8Array>
  decodeText(bytes: Uint8Array): string | Promise<string>
  checkpoint(): Promise<void>
  currentDirectory: string
}
export function discNameDecoder(reader?: ArchiveReader, encoding: LegacyNameEncoding = 'cp437') {
  return dosNameDecoder(encoding) ?? reader?.discNameDecoder?.(encoding) ??
    (() => { throw new Error('光盘文件名解码器不可用：' + encoding) })
}
export class CddaDiscs {
  private readonly supplied?: readonly CddaDisc[]
  constructor(private readonly storage: CddaStorage, discs?: readonly CddaDisc[],
    private readonly distribution?: string, private readonly imports?: DiscImports) { this.supplied = copyCddaDiscs(discs) }
  private readonly sheets = new WeakMap<object, { sheet: CueSheet; image?: object; imageName?: string }>()
  private readonly labels = new WeakMap<object, { geometry: string; value: string }>()
  private readonly filesystems = new WeakMap<object, { geometry: string; fs: DiscFilesystem }>()
  private importedCues?: string[]
  private readonly overrides = new Map<string, BoundDisc | null>()
  private readonly revisions = new Map<string, number>()
  private readonly pending = new Map<string, object>()
  private disposed = false
  current(selection: { drive: string; revision?: number }): boolean {
    return !this.disposed && (selection.revision ?? 0) === (this.revisions.get(selection.drive) ?? 0)
  }
  dispose(): void {
    this.disposed = true
    this.pending.clear()
    for (const disc of this.overrides.values()) disc?.picked?.dispose()
    this.overrides.clear()
  }
  private async discoverImports(imports: DiscImports): Promise<string[]> {
    if (this.importedCues) return this.importedCues
    const files = imports.knownResources().filter((file) => !file.aliasOf && !file.name.includes('>'))
    const check = () => this.storage.checkpoint(), candidates = await opticalFiles(files, check)
    let failed = false
    if (!candidates.length) for (const file of files) {
      if (!/\.zip$/i.test(file.name)) continue
      try {
        candidates.push(...await opticalFiles(await imports.archiveEntries(file), check))
      } catch (error) {
        if (error instanceof ExecutionCancelled || error instanceof Error && error.name === 'AbortError') throw error
        await this.storage.checkpoint()
        failed = true // An unreadable optional ZIP must not hide a usable disc.
      }
      if (candidates.length > 1) break
    }
    if (!failed || candidates.length) this.importedCues = candidates
    return candidates
  }
  private async initialBindings(requireUnique: boolean): Promise<readonly BoundDisc[]> {
    if (this.supplied !== undefined) return this.supplied
    let cues = [...new Set(await this.storage.cues())]
    const imported = !cues.length && !!this.imports
    if (imported) cues = await this.discoverImports(this.imports!)
    if (cues.length > 1 && requireUnique && !this.overrides.size) throw new Error('Multiple imported CUE/CCD sheets or ISO images require explicit cddaDiscs bindings')
    return cues.length === 1 ? [{ drive: 'D', cue: toPublicStoragePath(cues[0]!), imported }] : []
  }
  private async bindings(requireUnique: boolean): Promise<readonly BoundDisc[]> {
    const initial = await this.initialBindings(requireUnique)
    const available = new Map(initial.map((disc) => [disc.drive, disc]))
    for (const [drive, disc] of this.overrides) {
      if (disc) available.set(drive, disc)
      else available.delete(drive)
    }
    return [...available.values()].map((disc) => ({ ...disc, revision: this.revisions.get(disc.drive) ?? 0 }))
  }
  private async readSheet(resource: Resource, binding: DiscFile, cached: boolean): Promise<CueSheet> {
    const key = resource.cacheToken ?? resource, old = cached ? this.sheets.get(key) : undefined
    const name = /\.ccd$/i.test(resource.name) ? extractStorageName(resource.name).slice(0, -4) + '.img' : undefined
    const image = name ? await this.cueFile(binding, name) : undefined, imageKey = image?.cacheToken ?? image
    if (old && old.image === imageKey && old.imageName === name) return old.sheet
    if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > cueLimits.bytes)
      throw new Error(name ? 'CCD metadata exceeds the 1 MiB budget' : 'CUE metadata exceeds the 1 MiB budget')
    const bytes = await this.storage.read(resource)
    await this.storage.checkpoint()
    if (bytes.length !== resource.size) throw new Error(name ? 'Truncated CCD metadata' : 'Truncated CUE metadata')
    const text = await this.storage.decodeText(bytes)
    let sheet: CueSheet
    if (image && name) {
      let opened: Awaited<ReturnType<typeof openResourceSource>> | undefined
      sheet = await parseCloneCd(text, name, { size: image.size, read: async (offset, length) => {
        opened ??= await openResourceSource(image, { checkpoint: () => this.storage.checkpoint() })
        return opened.source.read(offset, length)
      } })
    } else sheet = parseCue(text)
    if (cached) this.sheets.set(key, { sheet, image: imageKey, imageName: name })
    return sheet
  }
  private async bindingFile(disc: BoundDisc): Promise<DiscFile> {
    if (disc.picked) {
      const name = storageFilePath(disc.cue), resource = disc.picked.find(name)
      return { name: resource?.name ?? name, resource, exact: async (path) => disc.picked!.find(path) }
    }
    const member = distributionMember(disc.cue, this.distribution)
    let importedPath: string | undefined
    if (this.imports && !member) {
      // A path such as ../Disc.cue can be valid relative to the game only.
      try { importedPath = storageFilePath(disc.cue) } catch { /* use the project directory below */ }
    }
    const imports = this.imports, delimiter = importedPath?.indexOf('>') ?? -1
    const locate = async (name: string, exact: DiscFile['exact']): Promise<DiscFile> => {
      const resource = await exact(name)
      return { name: resource?.name ?? name, resource, exact }
    }
    if (imports && importedPath) {
      if (disc.imported) return locate(importedPath, (file) => imports.findAsync(file))
      if (delimiter >= 0 && imports.find(importedPath.slice(0, delimiter))) {
        // Keep a formerly resolvable project archive ahead of a sibling
        // release of the same name. A relative path from inside an XP3
        // cannot name a second archive there.
        let local: string | undefined
        try { local = storageFilePath(disc.cue, this.storage.currentDirectory) } catch { /* no project address */ }
        if (local && !discAddress(local) && await this.storage.exact(local.slice(0, local.indexOf('>'))))
          return locate(local, (file) => this.storage.exact(file))
        return locate(importedPath, (file) => imports.findAsync(file))
      }
    }
    const path = member ?? storageFilePath(disc.cue, this.storage.currentDirectory)
    if (discAddress(path)) throw new Error('A drive binding must refer to imported media')
    const local = await locate(path, (file) => this.storage.exact(file))
    if (!local.resource && imports && importedPath && delimiter < 0)
      return locate(importedPath, (file) => imports.findAsync(file))
    return local
  }
  private async cueFile(sheet: DiscFile, name: string): Promise<Resource> {
    if (/^[\\/]|^[a-z][a-z0-9+.-]*:/i.test(name) || name.includes('>'))
      throw new Error('CUE FILE must be relative to its imported sheet directory')
    const cue = sheet.name, directory = cue.slice(0, Math.max(cue.lastIndexOf('/'), cue.lastIndexOf('>')) + 1)
    const logical = storageFilePath(name, directory), file = await sheet.exact(logical)
    if (!file) throw new TvpError('TVPCannotOpenStorage', [toPublicStoragePath(logical)])
    return file
  }
  /** A standalone ISO supplies a single cooked data track. A CUE supplies
   * actual sector geometry and resolves FILE relative to the sheet. */
  private async mountedVolume(disc: BoundDisc, labelOnly = false,
    checkReplacement?: () => void): Promise<{ file: Resource; track?: DiscVolumeTrack } | undefined> {
    const binding = await this.bindingFile(disc)
    const cue = binding.resource
    if (!cue) return
    if (/\.iso$/i.test(cue.name)) return {
      file: cue, track: { file: cue.name, first: 0, layout: { bytes: 2048, payload: 0 } },
    }
    const sheet = await this.readSheet(cue, binding, true)
    if (checkReplacement) for (const file of sheet.files) {
      checkReplacement()
      await this.cueFile(binding, file.name)
    }
    const track = discVolumeTrack(sheet)
    if (track === 'audio' || (disc.volumeLabel !== undefined && labelOnly))
      return { file: await this.cueFile(binding, sheet.files[sheet.tracks[0]!.file]!.name) }
    if (track) return { file: await this.cueFile(binding, track.file), track }
  }
  async drives(): Promise<string[]> {
    return [...new Set([...(await this.bindings(false)).map((disc) => disc.drive), ...this.overrides.keys()])]
  }
  async openDataDisc(drive: string): Promise<{ filesystem: DiscFilesystem; image: string } | undefined> {
    if (this.disposed) return
    const disc = (await this.bindings(false)).find((disc) => disc.drive === drive)
    if (!disc) return
    const mounted = await this.mountedVolume(disc).catch((error: unknown) => {
      if (error instanceof TvpError && error.tvpMessage.id === 'TVPCannotOpenStorage') return undefined
      throw error
    })
    if (!mounted?.track) return
    const result = await this.dataFilesystem(mounted.file, mounted.track)
    return this.current(disc) ? result : this.openDataDisc(drive)
  }
  private async dataFilesystem(file: Resource, track: DiscVolumeTrack) {
    const image = file.cacheToken ?? file
    const geometry = [track.first, track.end, track.layout.bytes, track.layout.payload].join('/')
    const cached = this.filesystems.get(image)
    if (cached?.geometry === geometry) return { filesystem: cached.fs, image: file.name }
    const { source } = await openResourceSource(file, { checkpoint: () => this.storage.checkpoint() })
    const fs = await openDiscFilesystem(source, track, this.storage.joinBlobs, this.storage.decodeName)
    if (fs) {
      this.filesystems.set(image, { geometry, fs })
      return { filesystem: fs, image: file.name }
    }
  }
  async filesystem(drive: string): Promise<DiscFilesystem | undefined> {
    return (await this.openDataDisc(drive))?.filesystem
  }
  async change(change: DiscChange, load: (() => Promise<Resource[]>) | undefined,
    committed: (drive: string) => void | Promise<void>): Promise<void> {
    if (this.disposed) throw new Error('光驱已关闭。')
    if (!change || !['insert', 'eject', 'reset'].includes(change.kind) ||
        typeof change.drive !== 'string' || !/^[a-z]$/i.test(change.drive) || (load && change.kind !== 'insert'))
      throw new Error('请选择有效的光驱和换盘操作。')
    const drive = change.drive.toUpperCase(), token = {}
    const candidate: BoundDisc | undefined = change.kind === 'insert' ? copyCddaDiscs([change])![0] : undefined
    if (candidate && !isDiscMedium(candidate.cue)) throw new Error('请选择 ISO 镜像、CUE 或 CCD 文件。')
    this.pending.set(drive, token)
    const check = () => {
      if (this.pending.get(drive) !== token) throw new Error('这次换盘已由更新的操作取代。')
    }
    let picked: StorageResolver | undefined
    try {
      if (change.kind === 'reset' && !this.overrides.has(drive) ||
          change.kind === 'eject' && this.overrides.get(drive) === null) return
      let replacement: BoundDisc | null = null
      if (candidate) {
        if (load) {
          const resources = await load()
          check()
          if (new Set(resources.map((file) => file.name)).size !== resources.length) throw new Error('所选光盘文件中有重名路径。')
          picked = new StorageResolver('', false)
          picked.mount(resources)
        }
        replacement = { ...candidate, picked }
        const mounted = await this.mountedVolume(replacement, false, check)
        check()
        if (!mounted || (mounted.track && !await this.dataFilesystem(mounted.file, mounted.track)))
          throw new Error('找不到光盘或无法读取光盘内容：' + candidate.cue)
      }
      await this.storage.checkpoint()
      check()
      const old = this.overrides.get(drive)
      if (change.kind === 'reset') this.overrides.delete(drive)
      else this.overrides.set(drive, replacement)
      picked = undefined
      old?.picked?.dispose()
      this.revisions.set(drive, (this.revisions.get(drive) ?? 0) + 1)
      await committed(drive)
    } finally {
      picked?.dispose()
      if (this.pending.get(drive) === token) this.pending.delete(drive)
    }
  }
  private async volumeLabel(disc: BoundDisc): Promise<string | undefined> {
    const mounted = await this.mountedVolume(disc, true)
    if (!mounted) return
    const { track, file } = mounted
    if (!track) return disc.volumeLabel ?? 'Audio CD'
    const image = file.cacheToken ?? file, geometry = [track.first, track.end, track.layout.bytes, track.layout.payload].join('/'),
      cached = this.labels.get(image)
    if (cached?.geometry === geometry) return disc.volumeLabel ?? cached.value
    const { source } = await openResourceSource(file, { checkpoint: () => this.storage.checkpoint() }),
      value = await readDiscVolumeLabel(source, track, this.storage.decodeName)
    if (value !== undefined) {
      this.labels.set(image, { geometry, value })
      return disc.volumeLabel ?? value
    }
  }
  async searchVolume(label: string): Promise<string> {
    const folded = label.toUpperCase(), discs = [...await this.bindings(false)].sort((a, b) => a.drive.charCodeAt(0) - b.drive.charCodeAt(0))
    for (const disc of discs) {
      await this.storage.checkpoint()
      try {
        const volume = await this.volumeLabel(disc)
        if (this.current(disc) && volume !== undefined && volume.toUpperCase() === folded) return disc.drive
      } catch (error) {
        if (error instanceof ExecutionCancelled) throw error
        // Unreadable/missing media do not hide a later matching drive. A
        // cancelled session still exits before searching another resource.
        await this.storage.checkpoint()
      }
    }
    return ''
  }
  async prepare(name: string, selectedDrive?: (drive: string) => void): Promise<CddaSelection | undefined> {
    if (name.length > 4096 || name.includes('\0')) throw new Error('Invalid CDDA open name')
    const specified = name.length >= 2 && name[1] === ':'
    if (!specified && name !== '' && !/^\s*[+-]?\d/.test(name)) return undefined
    if (!specified && name && await this.storage.exists(name)) return undefined
    let drive: string | undefined
    if (specified) {
      const code = name.charCodeAt(0) & 31
      if (!code || code > 26) throw new InvalidCddaDrive()
      drive = String.fromCharCode(code + 64)
    }
    const discs = await this.bindings(true)
    const disc = drive ? discs.find((disc) => disc.drive === drive) : discs[0]
    if (!disc) { if (specified) throw new InvalidCddaDrive(); throw new TvpError('TVPCDDADriveNotFound') }
    if (!this.current(disc)) throw new Error('CD medium changed while selecting a track')
    const revision = disc.revision ?? 0
    const finish = (selection: CddaSelection): CddaSelection => {
      if (!this.current(disc)) throw new Error('CD medium changed while opening a track')
      return revision ? { ...selection, revision } : selection
    }
    selectedDrive?.(disc.drive)
    const match = /^\s*([+-]?\d+)/.exec(specified ? name.slice(2) : name), parsed = Number(match?.[1] ?? 0)
    if (!Number.isSafeInteger(parsed) || parsed < -0x80000000 || parsed > 0x7fffffff)
      throw new Error('CDDA track number exceeds the safe native integer range')
    const binding = await this.bindingFile(disc)
    const resource = binding.resource
    if (!resource) throw new TvpError('TVPCannotOpenStorage', [toPublicStoragePath(binding.name)])
    if (/\.iso$/i.test(resource.name)) return finish({ drive: disc.drive, cue: resource.name, track: parsed })
    const sheet = await this.readSheet(resource, binding, false), parts = cueTrackParts(sheet, parsed), selected: SelectedPart[] = [],
      files = new Map<number, Resource>()
    if (parts) for (const part of parts) {
      if (part.kind === 'silence') { selected.push(part); continue }
      const { file: index, ...range } = part, file = sheet.files[index]!
      let audio = files.get(index)
      if (!audio) {
        audio = await this.cueFile(binding, file.name)
        files.set(index, audio)
      }
      selected.push({ ...range, resource: audio,
        encoding: file.type === 'BINARY' ? 's16le' : file.type === 'MOTOROLA' ? 's16be' : 'encoded' })
      await this.storage.checkpoint()
    }
    return finish({ drive: disc.drive, cue: resource.name, track: parsed, ...(parts ? { parts: selected } : {}) })
  }
}

/** Assemble borrowed ranges without copying a disc image. The original source
 * leases remain charged and alive until the backend closes all decoders. */
export async function openCddaSelection(selection: CddaSelection, sources: AudioResourceSources,
  valid: () => boolean): Promise<AudioSourceLease & { cdda: CddaPcmTrack }> {
  if (!selection.parts) throw new Error(`Imported CDDA track ${selection.track} is absent or is a data track`)
  const leases: { resource: Resource; lease: AudioSourceLease; offset: number }[] = [], parts: CddaPcmPart[] = []
  let size = 0, bufferedBytes = 0, released = false
  const release = () => {
    if (released) return
    released = true
    for (const entry of leases) entry.lease.release()
  }
  try {
    for (const part of selection.parts) {
      if (part.kind === 'silence') { parts.push(part); continue }
      const { resource, ...range } = part
      let entry = leases.find((entry) => entry.resource === resource)
      if (!entry) {
        const lease = await sources.open(resource, valid)
        entry = { resource, lease, offset: size }; leases.push(entry)
        size += lease.source.size; bufferedBytes += lease.bufferedBytes
        if (!Number.isSafeInteger(size)) throw new Error('Combined CDDA sources exceed safe byte offsets')
      }
      parts.push({ ...range, offset: entry.offset, size: entry.lease.source.size })
    }
    return { bufferedBytes, release, cdda: { parts }, source: { size, read: async (offset, length) => {
      if (released || !valid()) throw new Error('CDDA source owner has expired')
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
          offset > size || length > size - offset || length > 65536) throw new Error('Invalid CDDA source read range')
      const bytes = new Uint8Array(length)
      for (const entry of leases) {
        const start = Math.max(offset, entry.offset), end = Math.min(offset + length, entry.offset + entry.lease.source.size)
        if (start >= end) continue
        const data = await entry.lease.source.read(start - entry.offset, end - start)
        if (released || !valid()) throw new Error('CDDA source owner expired during reading')
        if (data.length !== end - start) throw new Error('Truncated CDDA source read')
        bytes.set(data, start - offset)
      }
      return bytes
    } } }
  } catch (error) { release(); throw error }
}
