import type { ByteSource } from '../../engine/ports/storage.ts'
import { TrackReader, type DiscVolumeTrack } from './track.ts'
import { foldDiscName as fold, discPathParts as pathParts } from './path.ts'
import { openUdfVolume } from './udf.ts'

/** Read-only optical namespace with recorded spelling and case-insensitive lookup. */
export interface DiscEntry { readonly name: string; readonly size: number; readonly directory: boolean }
export interface DiscFilesystem {
  file(path: string): Promise<ByteSource | undefined>
  list(directory?: string): Promise<readonly DiscEntry[] | undefined>
}

const sectorSize = 2048, maxRead = 64 * 1024 * 1024, maxDirectory = 8 * 1024 * 1024,
  maxRecords = 65536, cacheBudget = 32 * 1024 * 1024, maxFiles = 4096
const invalid = (detail: string): never => { throw new Error('Invalid ISO filesystem: ' + detail) }
function range(offset: number, length: number, size: number) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      offset > size || length > size - offset) invalid('read or extent outside its data range')
}
function both16(bytes: Uint8Array, at: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), value = view.getUint16(at, true)
  if (value !== view.getUint16(at + 2)) invalid('inconsistent 16-bit field')
  return value
}
function both32(bytes: Uint8Array, at: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), value = view.getUint32(at, true)
  if (value !== view.getUint32(at + 4)) invalid('inconsistent 32-bit field')
  return value
}

interface Section { start: number; size: number; unit: number; gap: number }
interface Entry extends DiscEntry { size: number; key: number; identifier: string; version: string; flags: number; sections: Section[] }
interface Directory { entries: Entry[]; charge: number }
interface Volume { bytes: number; block: number; sequence: number; joliet: boolean; root: Entry }

// CDFS NameSup/DirSup separate ';version' and remove one empty-extension dot.
function splitName(text: string) {
  const separator = text.indexOf(';'), name = separator < 0 ? text : text.slice(0, separator),
    version = separator < 0 ? '' : text.slice(separator + 1)
  return { name: name.endsWith('.') ? name.slice(0, -1) : name, version }
}
function identifier(bytes: Uint8Array, joliet: boolean): string {
  if (joliet && bytes.length % 2) invalid('odd Joliet identifier length')
  let text = ''
  for (let at = 0; at < bytes.length; at += joliet ? 2 : 1) {
    const code = joliet ? bytes[at]! * 256 + bytes[at + 1]! : bytes[at]!
    if (!code || code === 47 || code === 92 || (!joliet && code > 127)) invalid('unsupported file identifier')
    text += String.fromCharCode(code)
  }
  return text
}
function record(bytes: Uint8Array, key: number, volume: Omit<Volume, 'root'>): Entry {
  if (bytes.length < 34 || bytes[0] !== bytes.length || 33 + bytes[32]! > bytes.length || !bytes[32])
    invalid('incomplete directory record')
  const location = both32(bytes, 2), size = both32(bytes, 10), flags = bytes[25]!,
    unit = bytes[26]! * volume.block, gap = bytes[27]! * volume.block, attributes = bytes[1]! * volume.block,
    start = location * volume.block + attributes + (unit && attributes ? gap : 0), directory = !!(flags & 2),
    special = bytes[32] === 1 && bytes[33]! <= 1,
    rawName = special ? (bytes[33] === 0 ? '.' : '..') : identifier(bytes.subarray(33, 33 + bytes[32]!), volume.joliet),
    { name, version } = special ? { name: rawName, version: '' } : splitName(rawName)
  if (!name || (!special && (name === '.' || name === '..')) || (special && !directory)) invalid('invalid directory identifier')
  if (both16(bytes, 28) !== volume.sequence) invalid('file section belongs to another volume')
  if ((!unit && gap) || (directory && (unit || gap || (flags & 128)))) invalid('unsupported directory or interleave layout')
  if (unit && attributes && attributes !== unit) invalid('interleaved attributes must occupy one file unit')
  if (flags & 96) invalid('reserved directory flags')
  const span = size && unit ? Math.floor((size - 1) / unit) * (unit + gap) + (size - 1) % unit + 1 : size
  range(start, span, volume.bytes)
  return { key, identifier: rawName, name, version, size, directory, flags, sections: [{ start, size, unit, gap }] }
}
function readVolume(bytes: Uint8Array, joliet: boolean, available: number): Volume {
  const block = both16(bytes, 128), blocks = both32(bytes, 80), sequence = both16(bytes, 124),
    volumeBytes = blocks * block, setSize = both16(bytes, 120)
  if (![512, 1024, 2048].includes(block) || !blocks || !sequence || sequence > setSize || bytes[881] !== 1)
    invalid('unsupported volume description')
  range(0, volumeBytes, available)
  const volume = { bytes: volumeBytes, block, sequence, joliet },
    root = record(bytes.subarray(156, 156 + bytes[156]!), 156, volume)
  if (!root.directory || root.name !== '.') invalid('missing root directory')
  return { ...volume, root }
}

class Filesystem implements DiscFilesystem {
  private readonly directories = new Map<string, Directory>()
  private readonly loading = new Map<string, Promise<Directory>>()
  private readonly files = new Map<number, { source: ByteSource; charge: number }>()
  private cached = 0
  private fileBytes = 0
  private scanning: Promise<void> = Promise.resolve()
  constructor(private readonly reader: TrackReader, private readonly volume: Volume) {}

  private async sectionRead(section: Section, offset: number, length: number): Promise<Uint8Array> {
    range(offset, length, section.size)
    if (!section.unit) return this.reader.read(section.start + offset, length)
    const out = new Uint8Array(length)
    let written = 0
    while (written < length) {
      const at = offset + written, unit = Math.floor(at / section.unit), within = at % section.unit,
        count = Math.min(length - written, section.unit - within)
      out.set(await this.reader.read(section.start + unit * (section.unit + section.gap) + within, count), written)
      written += count
    }
    return out
  }
  private async scan(directory: Entry): Promise<Directory> {
    if (directory.size > maxDirectory) invalid('directory exceeds 8 MiB')
    const entries: Entry[] = [], section = directory.sections[0]!
    let pending: Entry | undefined, records = 0, charge = 128
    for (let at = 0; at < directory.size;) {
      const count = Math.min(sectorSize - (section.start + at) % sectorSize, directory.size - at),
        bytes = await this.sectionRead(section, at, count)
      for (let pos = 0; pos < bytes.length && bytes[pos];) {
        const length = bytes[pos]!
        if (length > bytes.length - pos) invalid('directory record crosses a sector')
        if (++records > maxRecords) invalid('directory exceeds 65536 records')
        const next = record(bytes.subarray(pos, pos + length), section.start + at + pos, this.volume)
        pos += length
        if (pending) {
          if (next.identifier !== pending.identifier || (next.flags & 111) !== (pending.flags & 111))
            invalid('nonconsecutive multi-extent file sections')
          pending.sections.push(next.sections[0]!); pending.size += next.size
          if (!Number.isSafeInteger(pending.size)) invalid('file size is not an exact byte offset')
          charge += 32
        } else {
          pending = next
          charge += 160 + next.identifier.length * 4 + next.name.length * 4 + next.version.length * 4
        }
        if (charge > cacheBudget) invalid('directory metadata exceeds 32 MiB')
        if (next.flags & 128) continue
        if (pending.name !== '.' && pending.name !== '..' && !(pending.flags & 4)) entries.push(pending)
        pending = undefined
      }
      at += count
    }
    if (pending) invalid('missing final file section')
    return { entries, charge }
  }
  private directory(entry: Entry): Promise<Directory> {
    const key = entry.sections[0]!.start + '/' + entry.size, cached = this.directories.get(key)
    if (cached) { this.directories.delete(key); this.directories.set(key, cached); return Promise.resolve(cached) }
    const active = this.loading.get(key)
    if (active) return active
    const work = this.scanning.then(() => this.scan(entry)).then((result) => {
      while (this.cached + result.charge > cacheBudget && this.directories.size) {
        const oldest = this.directories.keys().next().value!
        this.cached -= this.directories.get(oldest)!.charge; this.directories.delete(oldest)
      }
      if (result.charge <= cacheBudget) { this.directories.set(key, result); this.cached += result.charge }
      return result
    }).finally(() => this.loading.delete(key))
    this.scanning = work.then(() => {}, () => {})
    this.loading.set(key, work)
    return work
  }
  private async lookup(path: string): Promise<Entry | undefined> {
    let found: Entry = this.volume.root
    for (const part of pathParts(path)) {
      if (!found.directory) return
      const wanted = splitName(part), name = fold(wanted.name), version = fold(wanted.version)
      const next: Entry | undefined = (await this.directory(found)).entries.find((entry) => fold(entry.name) === name &&
        (!version || fold(entry.version) === version))
      if (!next) return
      found = next
    }
    return found
  }
  async list(path = ''): Promise<readonly DiscEntry[] | undefined> {
    const entry = await this.lookup(path)
    if (!entry?.directory) return
    const names = new Set<string>(), listed: DiscEntry[] = []
    for (const item of (await this.directory(entry)).entries) {
      const name = fold(item.name)
      if (!names.has(name)) { names.add(name); listed.push({ name: item.name, size: item.size, directory: item.directory }) }
    }
    return listed
  }
  async file(path: string): Promise<ByteSource | undefined> {
    const entry = await this.lookup(path)
    if (!entry || entry.directory) return
    const cached = this.files.get(entry.key)
    if (cached) { this.files.delete(entry.key); this.files.set(entry.key, cached); return cached.source }
    const source: ByteSource = { size: entry.size, read: async (offset, length) => {
      range(offset, length, entry.size)
      if (length > maxRead) invalid('single file read exceeds 64 MiB')
      const out = new Uint8Array(length)
      let base = 0, written = 0
      for (const section of entry.sections) {
        const start = Math.max(offset, base), end = Math.min(offset + length, base + section.size)
        for (let at = start; at < end;) {
          const count = Math.min(65536, end - at)
          out.set(await this.sectionRead(section, at - base, count), written)
          written += count; at += count
        }
        base += section.size
        if (written === length) break
      }
      return out
    } }
    if (entry.sections.length === 1 && !entry.sections[0]!.unit && this.reader.canBorrow) {
      const section = entry.sections[0]!
      source.borrowBlob = (offset, length, checkpoint) => {
        range(offset, length, entry.size)
        return this.reader.borrowBlob(section.start + offset, length, checkpoint)
      }
    }
    const charge = 160 + entry.identifier.length * 4 + entry.name.length * 4 + entry.version.length * 4 + entry.sections.length * 32
    while (this.files.size && (this.files.size >= maxFiles || this.fileBytes + charge > cacheBudget)) {
      const oldest = this.files.keys().next().value!
      this.fileBytes -= this.files.get(oldest)!.charge; this.files.delete(oldest)
    }
    if (charge <= cacheBudget) { this.files.set(entry.key, { source, charge }); this.fileBytes += charge }
    return source
  }
}

/** Preserve ISO/Joliet selection on bridged discs. A UDF recognition area
 * in place of an ISO descriptor selects the UDF volume on the same track. */
export async function openDiscFilesystem(source: ByteSource, track: DiscVolumeTrack): Promise<DiscFilesystem | undefined> {
  const reader = new TrackReader(source, track)
  let primary: Volume | undefined
  for (let sector = 16; sector < 80 && (sector + 1) * sectorSize <= reader.size; sector++) {
    const bytes = await reader.read(sector * sectorSize, sectorSize)
    const id = String.fromCharCode(...bytes.subarray(1, 6))
    if (!primary && id === 'BEA01' && bytes[0] === 0 && bytes[6] === 1) return openUdfVolume(reader, sector)
    if (id !== 'CD001' || bytes[6] !== 1) {
      if (primary) invalid('incomplete volume descriptor sequence')
      return
    }
    if (bytes[0] === 255) return primary ? new Filesystem(reader, primary) : undefined
    if (bytes[0] === 1 && !primary) primary = readVolume(bytes, false, reader.size)
    else if (bytes[0] === 2 && primary && bytes[88] === 37 && bytes[89] === 47 &&
        (bytes[90] === 64 || bytes[90] === 67 || bytes[90] === 69))
      return new Filesystem(reader, readVolume(bytes, true, reader.size))
  }
  if (primary) invalid('missing volume descriptor terminator within 64 sectors')
  return
}
