import { BinaryReader } from '../binary/reader.ts'
import { checkedCrc32 } from '../binary/crc32.ts'
import type { DeflateRange, DeflateRangePool } from '../binary/deflate-ranges.ts'
import { MAX_RESOURCE_BYTES } from '../../engine/ports/storage.ts'
import { normalizePath } from '../../engine/storage/resolver.ts'
import type { ByteSource, Inflater, Resource } from '../../engine/ports/storage.ts'
import { cp437 } from './names.ts'
import { zipEndOffsets, type ExecutableZipLocation } from './executable.ts'
import { borrowResourceBlob, resourceReadBounds, resourceViewBounds } from '../../engine/storage/resource-source.ts'

export const MAX_ZIP_ENTRIES = 100000
export interface ZipCodecs {
  inflate: Inflater
  utf8(bytes: Uint8Array): string
  /** Checks cancellation and cooperatively yields to the host while doing index/CRC work. */
  checkpoint(): Promise<void>
  compressedRanges?: DeflateRangePool
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
      if (data.u32() === (await checkedCrc32(raw, () => codecs.checkpoint())))
        name = codecs.utf8(data.slice(data.remaining))
    }
    name ??= (codecs.legacyName ?? cp437)(raw)
  }
  if (name.includes('>')) throw new Error('ZIP entry contains an archive address delimiter')
  return name
}

/** Index central records without decompressing entries. Member payloads are read and checked on demand. */
export async function readZip(source: ByteSource, codecs: ZipCodecs,
  volumes: readonly number[] = [0], executable?: ExecutableZipLocation): Promise<ZipResource[]> {
  const check = () => codecs.checkpoint()
  if (!Number.isSafeInteger(source.size) || source.size < 22)
    throw new Error('Truncated ZIP archive')
  const prefixBytes = executable?.base ?? 0
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0 || prefixBytes >= source.size ||
      (prefixBytes !== 0 && volumes.length !== 1)) throw new Error('Invalid executable ZIP prefix')
  const diskStarts = prefixBytes ? [prefixBytes] : volumes
  if (volumes[0] !== 0 || volumes.some((at, i) =>
    !Number.isSafeInteger(at) || at >= source.size || (i > 0 && at <= volumes[i - 1]!)))
    throw new Error('Invalid ZIP volume boundaries')
  const lastDisk = diskStarts.length - 1
  const address = (disk: number, relative: number) => {
    const start = diskStarts[disk], end = diskStarts[disk + 1] ?? source.size
    if (start === undefined) throw new Error('Split ZIP requires all numbered volumes')
    if (!Number.isSafeInteger(relative) || relative < 0 || relative >= end - start)
      throw new Error('ZIP offset outside declared disk')
    return start + relative
  }
  const read = async (offset: number, length: number) => {
    bounds(offset, length, source.size)
    if (length > MAX_RESOURCE_BYTES) throw new Error('ZIP read exceeds 64 MiB budget')
    await codecs.checkpoint()
    const bytes = await source.read(offset, length)
    if (bytes.length !== length) throw new Error('Short ZIP source read')
    await codecs.checkpoint()
    return bytes
  }
  const tailOffset = executable?.endRecord ?? Math.max(0, source.size - 65557),
    tail = await read(tailOffset, source.size - tailOffset),
    view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let end = -1, missingDisk = false
  for (const at of zipEndOffsets(view)) {
    if (executable && at !== 0) continue
    const thisDisk = view.getUint16(at + 4, true),
      firstDirectoryDisk = view.getUint16(at + 6, true),
      count = view.getUint16(at + 10, true),
      size = view.getUint32(at + 12, true),
      offset = view.getUint32(at + 16, true),
      directoryBase = diskStarts[firstDirectoryDisk]
    if (thisDisk !== 0xffff && thisDisk !== lastDisk ||
      firstDirectoryDisk !== 0xffff && directoryBase === undefined || tailOffset + at < diskStarts[lastDisk]!) {
      missingDisk = true
      continue
    }
    // An EOCD-looking byte sequence inside a comment is not enough to locate an archive.
    if (
      count !== 0xffff &&
      size !== 0xffffffff &&
      offset !== 0xffffffff &&
      directoryBase !== undefined && directoryBase + offset + size !== tailOffset + at
    ) {
      const locatorAt = tailOffset + at - 20
      if (locatorAt < 0 || new BinaryReader(await read(locatorAt, 20)).u32() !== 0x07064b50)
        continue
    }
    end = at
    break
  }
  if (end < 0) {
    if (missingDisk) throw new Error('Split ZIP 缺少分卷或卷号不匹配，请同时选择 .z01 起的全部分卷及最后的 .zip。')
    throw new Error('ZIP end of central directory not found')
  }
  const eocd = tailOffset + end,
    input = new BinaryReader(tail.subarray(end))
  input.u32()
  const disk = input.u16(),
    centralDisk = input.u16(),
    diskCount = input.u16(),
    count32 = input.u16(),
    size32 = input.u32(),
    offset32 = input.u32()
  let count = count32,
    centralSize = size32,
    directoryDisk = centralDisk,
    relativeOffset = offset32,
    centralEnd = eocd,
    zip64Disk: number | undefined, zip64DiskCount: number | undefined
  const required = count32 === 0xffff || size32 === 0xffffffff || offset32 === 0xffffffff ||
    disk === 0xffff || centralDisk === 0xffff
  const locator = eocd >= 20 ? new BinaryReader(await read(eocd - 20, 20)) : undefined
  const classicEndsHere =
    size32 !== 0xffffffff && offset32 !== 0xffffffff && diskStarts[centralDisk] !== undefined &&
    diskStarts[centralDisk]! + offset32 + centralSize === eocd
  // A real locator is outside the central directory. Its signature may also
  // occur in an ordinary member comment at the end of a classic directory.
  if (!classicEndsHere && locator?.u32() === 0x07064b50) {
    zip64Disk = locator.u32()
    const offset = address(zip64Disk, locator.u64())
    if (locator.u32() !== diskStarts.length) throw new Error('Split ZIP64 disk count mismatch')
    bounds(offset, 56, eocd - 20)
    const record = new BinaryReader(await read(offset, 56))
    if (record.u32() !== 0x06064b50) throw new Error('Invalid ZIP64 end signature')
    const length = record.u64()
    if (length < 44 || offset + 12 + length !== eocd - 20) throw new Error('Invalid ZIP64 end size')
    record.u16()
    record.u16()
    if (record.u32() !== zip64Disk) throw new Error('ZIP64 end record on wrong disk')
    directoryDisk = record.u32()
    zip64DiskCount = record.u64()
    count = record.u64()
    centralSize = record.u64()
    relativeOffset = record.u64()
    centralEnd = offset
    if (
      (centralDisk !== 0xffff && centralDisk !== directoryDisk) ||
      (count32 !== 0xffff && count32 !== count) ||
      (size32 !== 0xffffffff && size32 !== centralSize) ||
      (offset32 !== 0xffffffff && offset32 !== relativeOffset)
    )
      throw new Error('ZIP64 end metadata mismatch')
  } else if (required && !(count32 === 0xffff && size32 !== 0xffffffff && offset32 !== 0xffffffff &&
    disk === lastDisk && centralDisk !== 0xffff))
    throw new Error('ZIP64 locator is missing')
  if (count > MAX_ZIP_ENTRIES || centralSize > MAX_RESOURCE_BYTES)
    throw new Error('ZIP index exceeds entry or 64 MiB budget')
  const centralOffset = address(directoryDisk, relativeOffset)
  bounds(centralOffset, centralSize, centralEnd)
  if (centralOffset + centralSize !== centralEnd)
    throw new Error('ZIP central directory offset or size mismatch')
  const central = new BinaryReader(await read(centralOffset, centralSize)),
    entries: Entry[] = []
  const counts = new Array<number>(diskStarts.length).fill(0)
  let recordDisk = directoryDisk
  for (let index = 0; index < count; index++) {
    await codecs.checkpoint()
    while (recordDisk < lastDisk && centralOffset + central.position >= diskStarts[recordDisk + 1]!) recordDisk++
    counts[recordDisk] = counts[recordDisk]! + 1
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
    offset = address(startDisk, offset)
    bounds(offset, 30, centralOffset)
    const decoded = await filename(rawName, flags, extra, codecs),
      name = normalizePath(decoded),
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
      // In Shift_JIS, 0x5c may finish a character such as ソ. Classify an
      // actual decoded separator before normalization removes a trailing slash.
      directory: /[\\/]$/.test(decoded) || !!(attributes & 16) || unix === 0x4000,
      symlink: unix === 0xa000,
    })
  }
  if (((diskCount !== 0xffff || zip64Disk === undefined) && diskCount !== counts[lastDisk]) ||
    (zip64Disk !== undefined && zip64DiskCount !== counts[zip64Disk]))
    throw new Error('ZIP central entry count on disk does not match directory')
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
    .map((entry): ZipResource => {
      const supported = () => {
        const { name, flags, method } = entry
        if (entry.symlink) throw new Error(`ZIP symbolic links are not supported: ${name}`)
        if (flags & 0x2041) throw new Error(`Encrypted ZIP member is not supported: ${name}`)
        if (method !== 0 && method !== 8)
          throw new Error(`Unsupported ZIP compression method ${method}: ${name}`)
        if (flags & ~0x80e) throw new Error(`Unsupported ZIP member flags: ${name}`)
      }
      const locate = async () => {
        supported()
        const { name, size, stored, offset, flags, method } = entry,
          boundary = boundaries.get(offset)!
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
        return start
      }
      let verified: Promise<number> | undefined, verifiedStart: number | undefined
      const scanStored = async (checkpoint?: () => void | Promise<void>) => {
        await checkpoint?.()
        if (verifiedStart !== undefined) return verifiedStart
        const start = await locate()
        let crc = 0
        // Before returning even one stored-member byte, preserve ZIP's full
        // payload CRC contract. This is a bounded-memory complete scan, not a
        // claim that first playback can begin without reading the whole item.
        for (let offset = 0; offset < entry.size; offset += 1024 * 1024) {
          await checkpoint?.()
          const bytes = await read(start + offset, Math.min(1024 * 1024, entry.size - offset))
          crc = await checkedCrc32(bytes, async () => { await check(); await checkpoint?.() }, crc)
        }
        if (crc !== entry.checksum) throw new Error(`ZIP CRC32 mismatch: ${entry.name}`)
        await codecs.checkpoint()
        await checkpoint?.()
        verifiedStart = start
        return start
      }
      // Ordinary range readers share their verification. A video-specific
      // cancellation never rejects or poisons another reader's shared flight.
      const verifyStored = () => verified ??= Promise.resolve().then(() => scanStored())
      const readable = !entry.symlink && !(entry.flags & ~0x80e) && !(entry.flags & 0x2041)
      const pool = readable && entry.method === 8 ? codecs.compressedRanges : undefined
      let position: Promise<number> | undefined, compressed: DeflateRange | undefined
      const range: ByteSource | undefined = readable && ((entry.method === 0 && entry.size === entry.stored) || pool) ? {
        size: entry.size,
        ...(entry.method === 0 && source.borrowBlob ? {
          async borrowBlob(offset: number, length: number, checkpoint?: () => void | Promise<void>) {
            resourceViewBounds(entry.size, offset, length)
            const start = await scanStored(checkpoint)
            return borrowResourceBlob(source, start + offset, length,
              async () => { await codecs.checkpoint(); await checkpoint?.() })
          },
        } : {}),
        async read(offset, length) {
          resourceReadBounds(entry.size, offset, length)
          await codecs.checkpoint()
          if (!pool) return read((await verifyStored()) + offset, length)
          // Resolve the local header once. The stable object also identifies
          // this member across all reads in the session-wide decompressor.
          compressed ??= {
            offset: () => position ??= locate().catch((error: unknown) => { position = undefined; throw error }),
            size: entry.size, stored: entry.stored, zip: { name: entry.name, crc32: entry.checksum },
          }
          const output = new Uint8Array(length)
          await pool.read(source, compressed, offset, output, check)
          return output
        },
      } : undefined
      return {
        name: entry.name,
        size: entry.size,
        zip: { method: entry.method, encrypted: !!(entry.flags & 0x2041), crc32: entry.checksum },
        ...(range ? { source: range } : {}),
        async read() {
          const { name, size, stored, method } = entry
          supported()
          if (size > MAX_RESOURCE_BYTES || stored > MAX_RESOURCE_BYTES)
            throw new Error(`ZIP member exceeds 64 MiB decode budget: ${name}`)
          if (pool && range) return range.read(0, size)
          const start = await locate(), encoded = await read(start, stored),
            output = method === 8 ? await codecs.inflate(encoded, size) : encoded
          await codecs.checkpoint()
          if (output.length !== size) throw new Error(`ZIP decompressed size mismatch: ${name}`)
          if ((await checkedCrc32(output, check)) !== entry.checksum)
            throw new Error(`ZIP CRC32 mismatch: ${name}`)
          await codecs.checkpoint()
          return method === 0 ? Uint8Array.from(output) : output
        },
      }
    })
}
