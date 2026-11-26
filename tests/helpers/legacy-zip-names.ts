import { crc32, deflateRawSync } from 'node:zlib'

interface Member {
  name: string | Uint8Array
  bytes: string | Uint8Array
  utf8?: boolean
  unicode?: string
  unicodeCrc?: number
}

/** Independent ZIP writer. Supply literal on-disk filename bytes so the
 * player and the fixture do not share a filename encoder or lookup table. */
export function legacyZip(entries: readonly Member[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? Buffer.from(entry.name, 'utf8') : Buffer.from(entry.name)
    const plain = typeof entry.bytes === 'string' ? Buffer.from(entry.bytes, 'utf8') : Buffer.from(entry.bytes)
    const data = deflateRawSync(plain)
    let extra = Buffer.alloc(0)
    if (entry.unicode !== undefined) {
      const replacement = Buffer.from(entry.unicode, 'utf8')
      extra = Buffer.alloc(9 + replacement.length); extra.writeUInt16LE(0x7075)
      extra.writeUInt16LE(5 + replacement.length, 2); extra[4] = 1
      extra.writeUInt32LE(entry.unicodeCrc ?? crc32(name), 5); replacement.copy(extra, 9)
    }
    const header = Buffer.alloc(30), record = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4)
    header.writeUInt16LE(entry.utf8 ? 0x800 : 0, 6); header.writeUInt16LE(8, 8)
    header.writeUInt32LE(crc32(plain), 14); header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(plain.length, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(extra.length, 28)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4)
    header.copy(record, 6, 4, 30); record.writeUInt32LE(offset, 42)
    local.push(header, name, extra, data); central.push(record, name, extra)
    offset += header.length + name.length + extra.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
