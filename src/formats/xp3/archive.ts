import { BinaryReader } from '../binary/reader.ts'
import type { ByteSource, Inflater, Resource } from '../../engine/ports/storage.ts'
import { MAX_RESOURCE_BYTES } from '../../engine/ports/storage.ts'
export { MAX_RESOURCE_BYTES } from '../../engine/ports/storage.ts'

const signature = [0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01]
export function hasXp3Signature(bytes: Uint8Array): boolean {
  return signature.every((byte, i) => bytes[i] === byte)
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
  options: { verifyAdler32?: boolean } = {},
): Promise<Xp3Resource[]> {
  const header = await source.read(0, 19)
  if (!hasXp3Signature(header))
    throw new Error('Unsupported XP3 signature (embedded EXE archives are not supported)')
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
      resources.push({
        name,
        size: fileSize,
        xp3: { fileHash: checksum, protected: protectedStorage },
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
