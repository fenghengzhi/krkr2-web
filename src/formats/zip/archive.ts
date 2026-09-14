import { BinaryReader } from '../binary/reader.ts'
import { crc32 } from '../binary/crc32.ts'
import { MAX_RESOURCE_BYTES } from '../../engine/ports/storage.ts'
import { normalizePath } from '../../engine/storage/resolver.ts'
import type { ByteSource, Inflater, Resource } from '../../engine/ports/storage.ts'
import { cp437 } from './names.ts'

export const MAX_ZIP_ENTRIES = 100000
export interface ZipCodecs {
  inflate: Inflater
  utf8(bytes: Uint8Array): string
  /** Checks cancellation and cooperatively yields to the host while doing index/CRC work. */
  checkpoint(): Promise<void>
  legacyName?(bytes: Uint8Array): string
}
export interface ZipResource extends Resource {
  readonly zip: { method: number; encrypted: boolean; crc32: number }
}
interface Entry {
  name: string
  rawName: Uint8Array
  flags: number
  method: number
  checksum: number
  stored: number
  size: number
  offset: number
  zip64: boolean
  directory: boolean
  symlink: boolean
}
function fields(bytes: Uint8Array): Map<number, Uint8Array> {
  const input = new BinaryReader(bytes),
    result = new Map<number, Uint8Array>()
  while (input.remaining) {
    const id = input.u16(),
      value = input.slice(input.u16())
    if (result.has(id) && (id === 1 || id === 0x7075)) throw new Error('Duplicate ZIP extra field')
    // Unknown extras need not be retained once their framing is validated.
    if (id === 1 || id === 0x7075) result.set(id, value)
  }
  return result
}
async function checksum(bytes: Uint8Array, codecs: ZipCodecs): Promise<number> {
  const work = crc32(bytes)
  try {
    while (true) {
      const next = work.next()
      if (next.done) return next.value
      await codecs.checkpoint()
    }
  } finally {
    work.return(0)
  }
}
function requiredZip64(extra: Map<number, Uint8Array>): BinaryReader {
  const data = extra.get(1)
  if (!data) throw new Error('Missing ZIP64 extra field')
  return new BinaryReader(data)
}
function bounds(offset: number, length: number, end: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > end ||
    length > end - offset
  )
    throw new Error('ZIP range outside archive structure')
}
async function filename(
  raw: Uint8Array,
  flags: number,
  extra: Map<number, Uint8Array>,
  codecs: ZipCodecs,
): Promise<string> {
  let name: string | undefined
  if (flags & 0x800) name = codecs.utf8(raw)
  else {
    const unicode = extra.get(0x7075)
    if (unicode && unicode.length >= 5 && unicode[0] === 1) {
      const data = new BinaryReader(unicode)
      data.u8()
      if (data.u32() === (await checksum(raw, codecs)))
        name = codecs.utf8(data.slice(data.remaining))
    }
    name ??= (codecs.legacyName ?? cp437)(raw)
  }
  if (name.includes('>')) throw new Error('ZIP entry contains an archive address delimiter')
  // ZIP paths stay inside the virtual game root; no filesystem extraction takes place.
  return normalizePath(name)
}

/** Index central records without decompressing entries. Member payloads are read and checked on demand. */
export async function readZip(source: ByteSource, codecs: ZipCodecs): Promise<ZipResource[]> {
  if (!Number.isSafeInteger(source.size) || source.size < 22)
    throw new Error('Truncated ZIP archive')
  const read = async (offset: number, length: number) => {
    bounds(offset, length, source.size)
    if (length > MAX_RESOURCE_BYTES) throw new Error('ZIP read exceeds 64 MiB budget')
    await codecs.checkpoint()
    const bytes = await source.read(offset, length)
    if (bytes.length !== length) throw new Error('Short ZIP source read')
    await codecs.checkpoint()
    return bytes
  }
  const tailOffset = Math.max(0, source.size - 65557),
    tail = await read(tailOffset, source.size - tailOffset),
    view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let end = -1
  for (let at = tail.length - 22; at >= 0; at--) {
    if (
      view.getUint32(at, true) === 0x06054b50 &&
      at + 22 + view.getUint16(at + 20, true) === tail.length
    ) {
      const count = view.getUint16(at + 10, true),
        size = view.getUint32(at + 12, true),
        offset = view.getUint32(at + 16, true)
      // An EOCD-looking byte sequence inside a comment is not enough to locate an archive.
      if (
        count !== 0xffff &&
        size !== 0xffffffff &&
        offset !== 0xffffffff &&
        offset + size !== tailOffset + at
      ) {
        const locatorAt = tailOffset + at - 20
        if (locatorAt < 0 || new BinaryReader(await read(locatorAt, 20)).u32() !== 0x07064b50)
          continue
      }
      end = at
      break
    }
  }
  if (end < 0) throw new Error('ZIP end of central directory not found')
  const eocd = tailOffset + end,
    input = new BinaryReader(tail.subarray(end))
  input.u32()
  const disk = input.u16(),
    centralDisk = input.u16(),
    diskCount = input.u16(),
    count32 = input.u16(),
    size32 = input.u32(),
    offset32 = input.u32()
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count32)
    throw new Error('Split ZIP archives are not supported')
  let count = count32,
    centralSize = size32,
    centralOffset = offset32,
    centralEnd = eocd
  const required = count32 === 0xffff || size32 === 0xffffffff || offset32 === 0xffffffff
  const locator = eocd >= 20 ? new BinaryReader(await read(eocd - 20, 20)) : undefined
  const classicEndsHere =
    size32 !== 0xffffffff && offset32 !== 0xffffffff && centralOffset + centralSize === eocd
  // A real locator is outside the central directory. Its signature may also
  // occur in an ordinary member comment at the end of a classic directory.
  if (!classicEndsHere && locator?.u32() === 0x07064b50) {
    if (locator.u32() !== 0) throw new Error('Split ZIP64 archive is not supported')
    const offset = locator.u64()
    if (locator.u32() !== 1) throw new Error('Split ZIP64 archive is not supported')
    bounds(offset, 56, eocd - 20)
    const record = new BinaryReader(await read(offset, 56))
    if (record.u32() !== 0x06064b50) throw new Error('Invalid ZIP64 end signature')
    const length = record.u64()
    if (length < 44 || offset + 12 + length !== eocd - 20) throw new Error('Invalid ZIP64 end size')
    record.u16()
    record.u16()
    if (record.u32() !== 0 || record.u32() !== 0)
      throw new Error('Split ZIP64 archive is not supported')
    const onDisk = record.u64()
    count = record.u64()
    centralSize = record.u64()
    centralOffset = record.u64()
    centralEnd = offset
    if (
      onDisk !== count ||
      (count32 !== 0xffff && count32 !== count) ||
      (size32 !== 0xffffffff && size32 !== centralSize) ||
      (offset32 !== 0xffffffff && offset32 !== centralOffset)
    )
      throw new Error('ZIP64 end metadata mismatch')
  } else if (required && !(count32 === 0xffff && size32 !== 0xffffffff && offset32 !== 0xffffffff))
    throw new Error('ZIP64 locator is missing')
  if (count > MAX_ZIP_ENTRIES || centralSize > MAX_RESOURCE_BYTES)
    throw new Error('ZIP index exceeds entry or 64 MiB budget')
  bounds(centralOffset, centralSize, centralEnd)
  if (centralOffset + centralSize !== centralEnd)
    throw new Error('ZIP central directory offset or size mismatch')
  const central = new BinaryReader(await read(centralOffset, centralSize)),
    entries: Entry[] = []
  for (let index = 0; index < count; index++) {
    await codecs.checkpoint()
    if (central.u32() !== 0x02014b50) throw new Error('Invalid ZIP central header')
    const madeBy = central.u16()
    central.u16()
    const flags = central.u16(),
      method = central.u16()
    central.u16()
    central.u16()
    const crc = central.u32()
    let stored = central.u32(),
      size = central.u32()
    const nameLength = central.u16(),
      extraLength = central.u16(),
      commentLength = central.u16()
    let startDisk = central.u16()
    central.u16()
    const attributes = central.u32()
    let offset = central.u32()
    const rawName = Uint8Array.from(central.slice(nameLength)),
      extra = fields(central.slice(extraLength))
    central.slice(commentLength)
    const zip64 = size === 0xffffffff || stored === 0xffffffff
    if (zip64 || offset === 0xffffffff || startDisk === 0xffff) {
      const large = requiredZip64(extra)
      if (size === 0xffffffff) size = large.u64()
      if (stored === 0xffffffff) stored = large.u64()
      if (offset === 0xffffffff) offset = large.u64()
      if (startDisk === 0xffff) startDisk = large.u32()
    }
    if (startDisk !== 0) throw new Error('Split ZIP member is not supported')
    bounds(offset, 30, centralOffset)
    const name = await filename(rawName, flags, extra, codecs),
      unix = madeBy >>> 8 === 3 ? (attributes >>> 16) & 0xf000 : 0
    entries.push({
      name,
      rawName,
      flags,
      method,
      checksum: crc,
      stored,
      size,
      offset,
      zip64,
      directory:
        rawName.at(-1) === 47 || rawName.at(-1) === 92 || !!(attributes & 16) || unix === 0x4000,
      symlink: unix === 0xa000,
    })
  }
  if (central.remaining) {
    if (central.u32() !== 0x05054b50) throw new Error('Extra ZIP central directory data')
    central.slice(central.u16()) // Framing only; no signature authenticity claim.
    if (central.remaining) throw new Error('Extra ZIP central directory signature data')
  }
  const offsets = [...new Set(entries.map((entry) => entry.offset))].sort((a, b) => a - b),
    boundaries = new Map(
      offsets.map((offset, index) => [offset, offsets[index + 1] ?? centralOffset]),
    )
  return entries
    .filter((entry) => !entry.directory)
    .map((entry) => ({
      name: entry.name,
      size: entry.size,
      zip: { method: entry.method, encrypted: !!(entry.flags & 0x2041), crc32: entry.checksum },
      async read() {
        const { name, size, stored, offset, flags, method } = entry,
          boundary = boundaries.get(offset)!
        if (entry.symlink) throw new Error(`ZIP symbolic links are not supported: ${name}`)
        if (flags & 0x2041) throw new Error(`Encrypted ZIP member is not supported: ${name}`)
        if (method !== 0 && method !== 8)
          throw new Error(`Unsupported ZIP compression method ${method}: ${name}`)
        if (flags & ~0x80e) throw new Error(`Unsupported ZIP member flags: ${name}`)
        if (size > MAX_RESOURCE_BYTES || stored > MAX_RESOURCE_BYTES)
          throw new Error(`ZIP member exceeds 64 MiB decode budget: ${name}`)
        if (method === 0 && size !== stored)
          throw new Error(`ZIP stored member size mismatch: ${name}`)
        bounds(offset, 30, boundary)
        const local = new BinaryReader(await read(offset, 30))
        if (local.u32() !== 0x04034b50) throw new Error(`Invalid ZIP local header: ${name}`)
        local.u16()
        if (local.u16() !== flags || local.u16() !== method)
          throw new Error(`ZIP local flags/method mismatch: ${name}`)
        local.u16()
        local.u16()
        const crc = local.u32()
        let packed = local.u32(),
          unpacked = local.u32()
        const nameLength = local.u16(),
          extraLength = local.u16(),
          variableLength = nameLength + extraLength,
          start = offset + 30 + variableLength
        bounds(offset + 30, variableLength, boundary)
        bounds(start, stored, boundary)
        const variable = new BinaryReader(await read(offset + 30, variableLength)),
          raw = variable.slice(nameLength),
          extra = fields(variable.slice(extraLength))
        if (
          raw.length !== entry.rawName.length ||
          raw.some((byte, index) => byte !== entry.rawName[index])
        )
          throw new Error(`ZIP local filename mismatch: ${name}`)
        // Streaming writers may emit zero classic sizes plus a ZIP64 local extra,
        // even when the central sizes fit in 32 bits (e.g. Python force_zip64).
        const large = packed === 0xffffffff || unpacked === 0xffffffff || extra.has(1)
        if (large) {
          const data = requiredZip64(extra)
          const original64 = data.u64(),
            stored64 = data.u64()
          if (unpacked === 0xffffffff) unpacked = original64
          if (packed === 0xffffffff) packed = stored64
          if (!(flags & 8) && (original64 !== size || stored64 !== stored))
            throw new Error(`ZIP local ZIP64 size mismatch: ${name}`)
        }
        if (!(flags & 8) && (crc !== entry.checksum || packed !== stored || unpacked !== size))
          throw new Error(`ZIP local size/CRC mismatch: ${name}`)
        if (flags & 8) {
          const wide = entry.zip64 || large,
            descriptorSize = wide ? 20 : 12,
            after = start + stored
          bounds(after, descriptorSize, boundary)
          const bytes = await read(after, Math.min(descriptorSize + 4, boundary - after))
          const matches = (skip: number) => {
            if (bytes.length < skip + descriptorSize) return false
            try {
              const d = new BinaryReader(bytes.subarray(skip))
              return (
                d.u32() === entry.checksum &&
                (wide ? d.u64() : d.u32()) === stored &&
                (wide ? d.u64() : d.u32()) === size
              )
            } catch {
              return false
            }
          }
          const signed = new BinaryReader(bytes).u32() === 0x08074b50
          if (!(signed && matches(4)) && !matches(0))
            throw new Error(`ZIP data descriptor mismatch: ${name}`)
        }
        const encoded = await read(start, stored),
          output = method === 8 ? await codecs.inflate(encoded, size) : encoded
        await codecs.checkpoint()
        if (output.length !== size) throw new Error(`ZIP decompressed size mismatch: ${name}`)
        if ((await checksum(output, codecs)) !== entry.checksum)
          throw new Error(`ZIP CRC32 mismatch: ${name}`)
        await codecs.checkpoint()
        return method === 0 ? Uint8Array.from(output) : output
      },
    }))
}
