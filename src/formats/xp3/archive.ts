import { BinaryReader } from '../binary/reader.ts'
import type { ByteSource, Inflater, Resource } from '../../engine/ports/storage.ts'
import { MAX_RESOURCE_BYTES } from '../../engine/ports/storage.ts'
import { resourceReadBounds } from '../../engine/storage/resource-source.ts'
export { MAX_RESOURCE_BYTES } from '../../engine/ports/storage.ts'

const signature = [0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01]
export function hasXp3Signature(bytes: Uint8Array, offset = 0): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte)
}

/** KRKR2's TVPGetXP3ArchiveOffset accepts an XP3 at zero, or the first
 * 16-byte-aligned mark after an MZ header. It does not parse or execute PE
 * code. Keep the archive-relative index/segment offsets in a bounded view. */
export async function findXp3Archive(source: ByteSource,
  options: { checkpoint?: () => void | Promise<void> } = {},
): Promise<{ offset: number; source: ByteSource } | undefined> {
  if (!Number.isSafeInteger(source.size) || source.size < 0) throw new Error('Invalid XP3 source size')
  const read = async (offset: number, length: number) => {
    resourceReadBounds(source.size, offset, length)
    await options.checkpoint?.()
    const bytes = await source.read(offset, length)
    await options.checkpoint?.()
    if (bytes.length !== length) throw new Error('Short XP3 archive read')
    return bytes
  }
  const prefix = await read(0, Math.min(11, source.size))
  if (hasXp3Signature(prefix)) return { offset: 0, source }
  if (prefix[0] !== 0x4d || prefix[1] !== 0x5a) return
  const blockSize = 256 * 1024
  for (let offset = 16; offset <= source.size - signature.length; offset += blockSize) {
    const bytes = await read(offset, Math.min(blockSize, source.size - offset))
    for (let at = 0; at + signature.length <= bytes.length; at += 16) {
      if (!(at % (64 * 1024))) await options.checkpoint?.()
      if (!hasXp3Signature(bytes, at)) continue
      const base = offset + at, size = source.size - base
      return { offset: base, source: { size,
        async read(offset, length) {
          resourceReadBounds(size, offset, length)
          return read(base + offset, length)
        },
      } }
    }
  }
}
interface Segment {
  compressed: boolean
  offset: number
  size: number
  stored: number
}

export interface Xp3Resource extends Resource {
  readonly xp3: { fileHash: number | undefined; protected: boolean }
}

export async function readXp3(
  source: ByteSource,
  inflate: Inflater,
  options: { verifyAdler32?: boolean; checkpoint?: () => void | Promise<void> } = {},
): Promise<Xp3Resource[]> {
  const located = await findXp3Archive(source, options)
  if (!located) throw new Error('XP3 signature not found')
  source = located.source
  const header = await source.read(0, 19)
  if (!hasXp3Signature(header))
    throw new Error('Unsupported XP3 signature')
  let pointer = 11
  const resources: Xp3Resource[] = []
  const visited = new Set<number>()
  let totalIndex = 0
  for (let chain = 0; chain < 64; chain++) {
    const offset = new BinaryReader(await source.read(pointer, 8)).u64()
    if (visited.has(offset)) throw new Error('Cyclic XP3 index')
    visited.add(offset)
    const flag = new BinaryReader(await source.read(offset, 1)).u8()
    const method = flag & 7
    if (method > 1) throw new Error(`Unsupported XP3 index compression: ${method}`)
    const sizes = new BinaryReader(await source.read(offset + 1, method === 1 ? 16 : 8))
    const stored = sizes.u64()
    const unpacked = method === 1 ? sizes.u64() : stored
    totalIndex += unpacked
    if (stored > MAX_RESOURCE_BYTES || totalIndex > MAX_RESOURCE_BYTES)
      throw new Error('XP3 index exceeds 64 MiB budget')
    const start = offset + 1 + (method === 1 ? 16 : 8)
    const encoded = await source.read(start, stored)
    const index = new BinaryReader(method === 1 ? await inflate(encoded, unpacked) : encoded)
    while (index.remaining) {
      const tag = index.tag()
      const chunk = new BinaryReader(index.slice(index.u64()))
      if (tag !== 'File') continue
      let name: string | undefined
      let fileSize = -1
      let archivedSize = -1
      let protectedStorage = false
      let checksum: number | undefined
      const segments: Segment[] = []
      while (chunk.remaining) {
        const field = chunk.tag()
        const data = new BinaryReader(chunk.slice(chunk.u64()))
        if (field === 'info') {
          if (name !== undefined) throw new Error('Duplicate XP3 info chunk')
          protectedStorage = !!(data.u32() & 0x80000000)
          fileSize = data.u64()
          archivedSize = data.u64()
          name = data.utf16(data.u16())
        } else if (field === 'segm') {
          while (data.remaining) {
            const method = data.u32()
            if (method > 1) throw new Error(`Unsupported XP3 segment compression: ${method}`)
            const segment = {
              compressed: method === 1,
              offset: data.u64(),
              size: data.u64(),
              stored: data.u64(),
            }
            if (segment.offset > source.size || segment.stored > source.size - segment.offset)
              throw new Error('XP3 segment is outside the archive')
            if (!segment.compressed && segment.size !== segment.stored)
              throw new Error('XP3 raw segment size mismatch')
            segments.push(segment)
          }
        } else if (field === 'adlr') checksum = data.u32()
      }
      if (
        !name ||
        fileSize < 0 ||
        segments.reduce((sum, s) => sum + s.size, 0) !== fileSize ||
        segments.reduce((sum, s) => sum + s.stored, 0) !== archivedSize
      )
        throw new Error('Invalid XP3 file metadata')
      const resourceName = name
      // A zlib segment requires whole-segment inflation with the current
      // decoder. Do not disguise that work as an arbitrary range capability.
      // Explicit Adler verification likewise keeps the complete-read path.
      const ranged: ByteSource | undefined = !options.verifyAdler32 && segments.every((segment) => !segment.compressed)
        ? {
            size: fileSize,
            async read(offset, length) {
              resourceReadBounds(fileSize, offset, length)
              await options.checkpoint?.()
              const output = new Uint8Array(length)
              let position = 0
              for (const segment of segments) {
                const start = Math.max(offset, position), end = Math.min(offset + length, position + segment.size)
                if (end > start) {
                  await options.checkpoint?.()
                  const bytes = await source.read(segment.offset + start - position, end - start)
                  await options.checkpoint?.()
                  if (bytes.length !== end - start) throw new Error(`Short XP3 segment read: ${resourceName}`)
                  output.set(bytes, start - offset)
                }
                position += segment.size
                if (position >= offset + length) break
              }
              await options.checkpoint?.()
              return output
            },
          }
        : undefined
      resources.push({
        name,
        size: fileSize,
        xp3: { fileHash: checksum, protected: protectedStorage },
        ...(ranged ? { source: ranged } : {}),
        async read() {
          if (fileSize > MAX_RESOURCE_BYTES)
            throw new Error(`Resource exceeds 64 MiB decode budget: ${resourceName}`)
          const output = new Uint8Array(fileSize)
          let position = 0
          for (const segment of segments) {
            const bytes = await source.read(segment.offset, segment.stored)
            output.set(segment.compressed ? await inflate(bytes, segment.size) : bytes, position)
            position += segment.size
          }
          // TVP passes this field to extraction filters; it need not be a
          // content checksum. Integrity validation is an explicit tool option.
          if (options.verifyAdler32 && checksum !== undefined && adler32(output) !== checksum)
            throw new Error(`XP3 checksum mismatch: ${resourceName}`)
          return output
        },
      })
    }
    if (!(flag & 0x80)) return resources
    pointer = start + stored
  }
  throw new Error('XP3 index continuation limit exceeded')
}

export function adler32(bytes: Uint8Array): number {
  let a = 1,
    b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}
