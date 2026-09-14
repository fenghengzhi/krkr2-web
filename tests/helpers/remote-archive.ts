import { zipFixture, centralRecords } from './zip-fixtures.ts'
import { crc32 } from '../../src/formats/binary/crc32.ts'

function checksum(bytes: Uint8Array): number {
  const iterator = crc32(bytes)
  let step = iterator.next()
  while (!step.done) step = iterator.next()
  return step.value
}
function u16(n: number) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
function u32(n: number) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
function u64(n: number) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}
function chunk(tag: string, body: Buffer) {
  return Buffer.concat([Buffer.from(tag), u64(body.length), body])
}

/** Preserve the independent stored ZIP's members, adding unused data on either side of a late script. */
export function remoteArchive(kind: 'zip' | 'xp3'): Buffer {
  const original = zipFixture('0-stream0-local640-zip640.zip')
  const entries = centralRecords(original).records.map((record) => ({
    name: record.name,
    bytes: original.subarray(record.data, record.data + original.readUInt32LE(record.at + 24)),
  }))
  entries.push(
    { name: 'pad-a.bin', bytes: Buffer.alloc(4 * 1024 * 1024) },
    { name: 'late.tjs', bytes: Buffer.from('73') },
    { name: 'pad-b.bin', bytes: Buffer.alloc(4 * 1024 * 1024) },
  )
  let offset = kind === 'xp3' ? 19 : 0
  const payload: Buffer[] = [],
    records: Buffer[] = []
  for (const { name, bytes } of entries) {
    if (kind === 'zip') {
      const text = Buffer.from(name),
        local = Buffer.alloc(30),
        central = Buffer.alloc(46),
        crc = checksum(bytes)
      local.writeUInt32LE(0x04034b50)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x800, 6)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(bytes.length, 18)
      local.writeUInt32LE(bytes.length, 22)
      local.writeUInt16LE(text.length, 26)
      central.writeUInt32LE(0x02014b50)
      central.writeUInt16LE(20, 4)
      central.writeUInt16LE(20, 6)
      central.writeUInt16LE(0x800, 8)
      central.writeUInt32LE(crc, 16)
      central.writeUInt32LE(bytes.length, 20)
      central.writeUInt32LE(bytes.length, 24)
      central.writeUInt16LE(text.length, 28)
      central.writeUInt32LE(offset, 42)
      payload.push(local, text, bytes)
      records.push(central, text)
      offset += local.length + text.length + bytes.length
    } else {
      records.push(
        chunk(
          'File',
          Buffer.concat([
            chunk(
              'info',
              Buffer.concat([
                u32(0),
                u64(bytes.length),
                u64(bytes.length),
                u16(name.length),
                Buffer.from(name, 'utf16le'),
              ]),
            ),
            chunk(
              'segm',
              Buffer.concat([u32(0), u64(offset), u64(bytes.length), u64(bytes.length)]),
            ),
          ]),
        ),
      )
      payload.push(bytes)
      offset += bytes.length
    }
  }
  const index = Buffer.concat(records)
  if (kind === 'xp3')
    return Buffer.concat([
      Buffer.from([88, 80, 51, 13, 10, 32, 10, 26, 139, 103, 1]),
      u64(offset),
      ...payload,
      Buffer.from([0]),
      u64(index.length),
      index,
    ])
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(index.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...payload, index, end])
}
