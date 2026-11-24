import { cueLimits, cueTrackParts, parseCue } from '../../formats/audio/cue.ts'
import { copyCddaDiscs, type CddaDisc, type CddaPcmPart, type CddaPcmTrack } from '../ports/cdda.ts'
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
  checkpoint(): Promise<void>
  currentDirectory: string
}
export class CddaDiscs {
  private readonly supplied?: readonly CddaDisc[]
  constructor(private readonly storage: CddaStorage, discs?: readonly CddaDisc[]) { this.supplied = copyCddaDiscs(discs) }
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
    let discs = this.supplied
    if (discs === undefined) {
      const candidates = [...new Set(await this.storage.cues())]
      if (candidates.length > 1) throw new Error('Multiple imported CUE sheets require explicit cddaDiscs bindings')
      discs = candidates.length ? [{ drive: 'D', cue: toPublicStoragePath(candidates[0]!) }] : []
    }
    const disc = drive ? discs.find((disc) => disc.drive === drive) : discs[0]
    if (!disc) { if (specified) throw new InvalidCddaDrive(); throw new TvpError('TVPCDDADriveNotFound') }
    const match = /^\s*([+-]?\d+)/.exec(specified ? name.slice(2) : name), parsed = Number(match?.[1] ?? 0)
    if (!Number.isSafeInteger(parsed) || parsed < -0x80000000 || parsed > 0x7fffffff)
      throw new Error('CDDA track number exceeds the safe native integer range')
    const path = storageFilePath(disc.cue, this.storage.currentDirectory), resource = await this.storage.exact(path)
    if (!resource) throw new TvpError('TVPCannotOpenStorage', [toPublicStoragePath(path)])
    if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > cueLimits.bytes)
      throw new Error('CUE metadata exceeds the 1 MiB budget')
    const bytes = await this.storage.read(resource)
    await this.storage.checkpoint()
    if (bytes.length !== resource.size) throw new Error('Truncated CUE metadata')
    const sheet = parseCue(bytes), parts = cueTrackParts(sheet, parsed), selected: SelectedPart[] = [],
      directory = resource.name.slice(0, Math.max(resource.name.lastIndexOf('/'), resource.name.lastIndexOf('>')) + 1),
      files = new Map<number, Resource>()
    if (parts) for (const part of parts) {
      if (part.kind === 'silence') { selected.push(part); continue }
      const file = sheet.files[part.file]!
      if (/^[\\/]|^[a-z][a-z0-9+.-]*:/i.test(file.name) || file.name.includes('>'))
        throw new Error('CUE FILE must be relative to its imported sheet directory')
      let audio = files.get(part.file)
      if (!audio) {
        const logical = storageFilePath(file.name, directory)
        audio = await this.storage.exact(logical)
        if (!audio) throw new TvpError('TVPCannotOpenStorage', [toPublicStoragePath(logical)])
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
