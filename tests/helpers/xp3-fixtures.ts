import { deflateSync } from 'node:zlib'

const u64 = (value: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes }
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
const chunk = (tag: string, bytes: Buffer) => Buffer.concat([Buffer.from(tag), u64(bytes.length), bytes])
export const xp3Signature = Buffer.from([88, 80, 51, 13, 10, 32, 10, 26, 139, 103, 1])

/** Authored XP3 records with explicit little-endian archive-relative offsets.
 * This writer is independent of the production reader and native mark scan. */
export function xp3Fixture(files: Record<string, string | Uint8Array>,
  options: { compressed?: boolean; continuation?: boolean } = {},
): { bytes: Buffer; indexOffsets: number[]; segmentOffsets: number[] } {
  const payloads: Buffer[] = [], records: Buffer[] = [], segmentOffsets: number[] = []
  let position = 19
  for (const [name, value] of Object.entries(files)) {
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value),
      encoded = deflateSync(bytes), payload = options.compressed ? encoded : bytes,
      text = Buffer.from(name, 'utf16le'), characters = Buffer.alloc(2)
    characters.writeUInt16LE(name.length)
    segmentOffsets.push(position)
    records.push(chunk('File', Buffer.concat([
      chunk('info', Buffer.concat([u32(0), u64(bytes.length), u64(payload.length), characters, text])),
      chunk('segm', Buffer.concat([u32(Number(!!options.compressed)), u64(position), u64(bytes.length), u64(payload.length)])),
      // The zlib trailer supplies an independent Adler-32, including for raw
      // payload fixtures; do not use the production archive reader's helper.
      chunk('adlr', u32(encoded.readUInt32BE(encoded.length - 4))),
    ])))
    payloads.push(payload)
    position += payload.length
  }
  const groups = options.continuation && records.length ? records : [Buffer.concat(records)],
    indices: Buffer[] = [], indexOffsets: number[] = []
  for (const [at, raw] of groups.entries()) {
    const encoded = options.compressed ? deflateSync(raw) : raw, more = at + 1 < groups.length,
      header = Buffer.concat([Buffer.from([Number(!!options.compressed) | (more ? 0x80 : 0)]),
        u64(encoded.length), ...(options.compressed ? [u64(raw.length)] : [])])
    indexOffsets.push(position)
    position += header.length + encoded.length + (more ? 8 : 0)
    indices.push(Buffer.concat([header, encoded, ...(more ? [u64(position)] : [])]))
  }
  return { bytes: Buffer.concat([xp3Signature, u64(indexOffsets[0]!), ...payloads, ...indices]),
    indexOffsets, segmentOffsets }
}

/** An inert MZ prefix for testing resource extraction. It is never executed. */
export function embedXp3(bytes: Uint8Array, offset = 256 * 1024 + 16): Buffer {
  if (!Number.isSafeInteger(offset) || offset < 16 || offset % 16) throw new Error('Invalid fixture alignment')
  const prefix = Buffer.alloc(offset)
  prefix.set([0x4d, 0x5a])
  return Buffer.concat([prefix, Buffer.from(bytes)])
}
