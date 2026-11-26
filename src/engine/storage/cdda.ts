import { cueLimits, cueTrackParts, parseCue, type CueSheet } from '../../formats/audio/cue.ts'
import { copyCddaDiscs, type CddaDisc, type CddaPcmPart, type CddaPcmTrack } from '../ports/cdda.ts'
import { discVolumeTrack, readDiscVolumeLabel } from '../../formats/disc/volume-label.ts'
import { openResourceSource } from './resource-source.ts'
import { ExecutionCancelled } from '../scheduler/control.ts'
import type { Resource } from '../ports/storage.ts'
import { TvpError } from '../system/tvp-error.ts'
import { storageFilePath, toPublicStoragePath } from './public-path.ts'
import type { AudioResourceSources, AudioSourceLease } from './audio-sources.ts'

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
  constructor(private readonly storage: CddaStorage, discs?: readonly CddaDisc[]) { this.supplied = copyCddaDiscs(discs) }
  private readonly sheets = new WeakMap<object, CueSheet>()
  private readonly labels = new WeakMap<object, { geometry: string; value: string }>()
  private async bindings(requireUnique: boolean): Promise<readonly CddaDisc[]> {
    if (this.supplied !== undefined) return this.supplied
    const cues = [...new Set(await this.storage.cues())]
    if (cues.length > 1 && requireUnique) throw new Error('Multiple imported CUE sheets require explicit cddaDiscs bindings')
    return cues.length === 1 ? [{ drive: 'D', cue: toPublicStoragePath(cues[0]!) }] : []
  }
  private async readSheet(resource: Resource): Promise<CueSheet> {
    if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > cueLimits.bytes)
      throw new Error('CUE metadata exceeds the 1 MiB budget')
    const bytes = await this.storage.read(resource)
    await this.storage.checkpoint()
    if (bytes.length !== resource.size) throw new Error('Truncated CUE metadata')
    return parseCue(await this.storage.decodeText(bytes))
  }
  private async cueFile(cue: string, name: string): Promise<Resource> {
    if (/^[\\/]|^[a-z][a-z0-9+.-]*:/i.test(name) || name.includes('>'))
      throw new Error('CUE FILE must be relative to its imported sheet directory')
    const directory = cue.slice(0, Math.max(cue.lastIndexOf('/'), cue.lastIndexOf('>')) + 1)
    const logical = storageFilePath(name, directory), file = await this.storage.exact(logical)
    if (!file) throw new TvpError('TVPCannotOpenStorage', [toPublicStoragePath(logical)])
    return file
  }
  private async volumeLabel(disc: CddaDisc): Promise<string | undefined> {
    const cue = await this.storage.exact(storageFilePath(disc.cue, this.storage.currentDirectory))
    if (!cue) return
    const key = cue.cacheToken ?? cue
    const sheet = this.sheets.get(key) ?? await this.readSheet(cue)
    this.sheets.set(key, sheet)
    const track = discVolumeTrack(sheet)
    if (disc.volumeLabel !== undefined || track === 'audio') {
      // A sheet without its media represents an empty drive. For an explicit
      // label or an audio disc, checking placement needs no payload read.
      await this.cueFile(cue.name, sheet.files[sheet.tracks[0]!.file]!.name)
      return disc.volumeLabel ?? 'Audio CD'
    }
    if (!track) return
    const file = await this.cueFile(cue.name, track.file)
    const image = file.cacheToken ?? file, geometry = [track.first, track.end, track.layout.bytes, track.layout.payload].join('/'),
      cached = this.labels.get(image)
    if (cached?.geometry === geometry) return cached.value
    const { source } = await openResourceSource(file, { checkpoint: () => this.storage.checkpoint() }),
      value = await readDiscVolumeLabel(source, track)
    if (value !== undefined) this.labels.set(image, { geometry, value })
    return value
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
    const path = storageFilePath(disc.cue, this.storage.currentDirectory), resource = await this.storage.exact(path)
    if (!resource) throw new TvpError('TVPCannotOpenStorage', [toPublicStoragePath(path)])
    const sheet = await this.readSheet(resource), parts = cueTrackParts(sheet, parsed), selected: SelectedPart[] = [],
      files = new Map<number, Resource>()
    if (parts) for (const part of parts) {
      if (part.kind === 'silence') { selected.push(part); continue }
      const file = sheet.files[part.file]!
      let audio = files.get(part.file)
      if (!audio) {
        audio = await this.cueFile(resource.name, file.name)
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
