import { cueLimits, cueTrackParts, parseCue, type CueSheet } from '../../formats/audio/cue.ts'
import { copyCddaDiscs, type CddaDisc, type CddaPcmPart, type CddaPcmTrack } from '../ports/cdda.ts'
import { discVolumeTrack, readDiscVolumeLabel, type DiscVolumeTrack } from '../../formats/disc/volume-label.ts'
import { openDiscFilesystem, type DiscFilesystem } from '../../formats/disc/filesystem.ts'
import { openResourceSource } from './resource-source.ts'
import { ExecutionCancelled } from '../scheduler/control.ts'
import type { Resource } from '../ports/storage.ts'
import { TvpError } from '../system/tvp-error.ts'
import { discAddress, storageFilePath, toPublicStoragePath } from './public-path.ts'
import type { AudioResourceSources, AudioSourceLease } from './audio-sources.ts'
import type { StorageResolver } from './resolver.ts'

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

type BoundDisc = CddaDisc & { imported?: boolean }
interface DiscFile { name: string; resource?: Resource; exact(name: string): Promise<Resource | undefined> }
type DiscImports = Pick<StorageResolver, 'find' | 'findAsync' | 'knownResources' | 'archiveEntries'>

async function opticalFiles(files: Iterable<Resource>, checkpoint: () => Promise<void>): Promise<string[]> {
  const sheets: string[] = [], images: string[] = []
  let scanned = 0
  for (const file of files) {
    if (++scanned % 4096 === 0) await checkpoint()
    if (/\.cue$/i.test(file.name)) sheets.push(file.name)
    else if (/\.iso$/i.test(file.name) && images.length < 2) images.push(file.name)
    if (sheets.length === 2) break
  }
  return sheets.length ? sheets : images
}

type SelectedPart = { kind: 'silence'; frames: number } | {
  kind: 'file'; resource: Resource; encoding: 'encoded' | 's16le' | 's16be'; startFrame: number; endFrame?: number
}
export interface CddaSelection { readonly drive: string; readonly cue: string; readonly track: number; readonly parts?: readonly SelectedPart[] }
/** Marks only this resolver's explicit-drive rejection, not provider errors. */
export class InvalidCddaDrive extends TvpError {
  constructor() { super('TVPInvalidCDDADrive') }
}
export interface CddaStorage {
  /** Ordinary existing files retain the historical direct-file open path. */
  exists(name: string): Promise<boolean>
  exact(logical: string): Promise<Resource | undefined>
  cues(): Promise<string[]>
  read(resource: Resource): Promise<Uint8Array>
  decodeText(bytes: Uint8Array): string | Promise<string>
  checkpoint(): Promise<void>
  currentDirectory: string
}
export class CddaDiscs {
  private readonly supplied?: readonly CddaDisc[]
  constructor(private readonly storage: CddaStorage, discs?: readonly CddaDisc[],
    private readonly distribution?: string, private readonly imports?: DiscImports) { this.supplied = copyCddaDiscs(discs) }
  private readonly sheets = new WeakMap<object, CueSheet>()
  private readonly labels = new WeakMap<object, { geometry: string; value: string }>()
  private readonly filesystems = new WeakMap<object, { geometry: string; fs: DiscFilesystem }>()
  private importedCues?: string[]
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
  private async bindings(requireUnique: boolean): Promise<readonly BoundDisc[]> {
    if (this.supplied !== undefined) return this.supplied
    let cues = [...new Set(await this.storage.cues())]
    const imported = !cues.length && !!this.imports
    if (imported) cues = await this.discoverImports(this.imports!)
    if (cues.length > 1 && requireUnique) throw new Error('Multiple imported CUE sheets or ISO images require explicit cddaDiscs bindings')
    return cues.length === 1 ? [{ drive: 'D', cue: toPublicStoragePath(cues[0]!), imported }] : []
  }
  private async readSheet(resource: Resource): Promise<CueSheet> {
    if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > cueLimits.bytes)
      throw new Error('CUE metadata exceeds the 1 MiB budget')
    const bytes = await this.storage.read(resource)
    await this.storage.checkpoint()
    if (bytes.length !== resource.size) throw new Error('Truncated CUE metadata')
    return parseCue(await this.storage.decodeText(bytes))
  }
  private async bindingFile(disc: BoundDisc): Promise<DiscFile> {
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
  private async mountedVolume(disc: BoundDisc, labelOnly = false): Promise<{ file: Resource; track?: DiscVolumeTrack } | undefined> {
    const binding = await this.bindingFile(disc)
    const cue = binding.resource
    if (!cue) return
    if (/\.iso$/i.test(cue.name)) return {
      file: cue, track: { file: cue.name, first: 0, layout: { bytes: 2048, payload: 0 } },
    }
    const key = cue.cacheToken ?? cue
    const sheet = this.sheets.get(key) ?? await this.readSheet(cue)
    this.sheets.set(key, sheet)
    const track = discVolumeTrack(sheet)
    if (track === 'audio' || (disc.volumeLabel !== undefined && labelOnly))
      return { file: await this.cueFile(binding, sheet.files[sheet.tracks[0]!.file]!.name) }
    if (track) return { file: await this.cueFile(binding, track.file), track }
  }
  async drives(): Promise<string[]> {
    return (await this.bindings(false)).map((disc) => disc.drive)
  }
  async openDataDisc(drive: string): Promise<{ filesystem: DiscFilesystem; image: string } | undefined> {
    const disc = (await this.bindings(false)).find((disc) => disc.drive === drive)
    if (!disc) return
    const mounted = await this.mountedVolume(disc).catch((error: unknown) => {
      if (error instanceof TvpError && error.tvpMessage.id === 'TVPCannotOpenStorage') return undefined
      throw error
    })
    if (!mounted?.track) return
    const { file, track } = mounted, image = file.cacheToken ?? file
    const geometry = [track.first, track.end, track.layout.bytes, track.layout.payload].join('/')
    const cached = this.filesystems.get(image)
    if (cached?.geometry === geometry) return { filesystem: cached.fs, image: file.name }
    const { source } = await openResourceSource(file, { checkpoint: () => this.storage.checkpoint() })
    const fs = await openDiscFilesystem(source, track)
    if (fs) {
      this.filesystems.set(image, { geometry, fs })
      return { filesystem: fs, image: file.name }
    }
  }
  async filesystem(drive: string): Promise<DiscFilesystem | undefined> {
    return (await this.openDataDisc(drive))?.filesystem
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
      value = await readDiscVolumeLabel(source, track)
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
        if (volume !== undefined && volume.toUpperCase() === folded) return disc.drive
      } catch (error) {
        if (error instanceof ExecutionCancelled) throw error
        // Unreadable/missing media do not hide a later matching drive. A
        // cancelled session still exits before searching another resource.
        await this.storage.checkpoint()
      }
    }
    return ''
  }
  async prepare(name: string): Promise<CddaSelection | undefined> {
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
    const match = /^\s*([+-]?\d+)/.exec(specified ? name.slice(2) : name), parsed = Number(match?.[1] ?? 0)
    if (!Number.isSafeInteger(parsed) || parsed < -0x80000000 || parsed > 0x7fffffff)
      throw new Error('CDDA track number exceeds the safe native integer range')
    const binding = await this.bindingFile(disc)
    const resource = binding.resource
    if (!resource) throw new TvpError('TVPCannotOpenStorage', [toPublicStoragePath(binding.name)])
    if (/\.iso$/i.test(resource.name)) return { drive: disc.drive, cue: resource.name, track: parsed }
    const sheet = await this.readSheet(resource), parts = cueTrackParts(sheet, parsed), selected: SelectedPart[] = [],
      files = new Map<number, Resource>()
    if (parts) for (const part of parts) {
      if (part.kind === 'silence') { selected.push(part); continue }
      const file = sheet.files[part.file]!
      let audio = files.get(part.file)
      if (!audio) {
        audio = await this.cueFile(binding, file.name)
        files.set(part.file, audio)
      }
      selected.push({ kind: 'file', resource: audio,
        encoding: file.type === 'BINARY' ? 's16le' : file.type === 'MOTOROLA' ? 's16be' : 'encoded',
        startFrame: part.startFrame, ...(part.endFrame === undefined ? {} : { endFrame: part.endFrame }) })
      await this.storage.checkpoint()
    }
    return { drive: disc.drive, cue: resource.name, track: parsed, ...(parts ? { parts: selected } : {}) }
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
      let entry = leases.find((entry) => entry.resource === part.resource)
      if (!entry) {
        const lease = await sources.open(part.resource, valid)
        entry = { resource: part.resource, lease, offset: size }; leases.push(entry)
        size += lease.source.size; bufferedBytes += lease.bufferedBytes
        if (!Number.isSafeInteger(size)) throw new Error('Combined CDDA sources exceed safe byte offsets')
      }
      parts.push({ kind: 'file', offset: entry.offset, size: entry.lease.source.size, encoding: part.encoding,
        startFrame: part.startFrame, ...(part.endFrame === undefined ? {} : { endFrame: part.endFrame }) })
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
