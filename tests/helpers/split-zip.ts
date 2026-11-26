import { centralRecords } from './zip-fixtures.ts'

/** Convert a classic test ZIP to PKZIP disk-relative addresses. Cuts can be
 * inside file data or between directory records. No product reader is used. */
export function splitZipFixture(archive: Buffer, cuts: number[]): Buffer[] {
  const bytes = Buffer.from(archive), starts = [0, ...cuts]
  const { end, central, records } = centralRecords(bytes)
  const diskAt = (position: number) => starts.filter((start) => start <= position).length - 1
  for (const [index, cut] of cuts.entries()) {
    if (cut <= starts[index]! || cut > end) throw new Error('Invalid fixture volume boundary')
    for (const row of records) {
      const stop = row.at + 46 + bytes.readUInt16LE(row.at + 28) +
        bytes.readUInt16LE(row.at + 30) + bytes.readUInt16LE(row.at + 32)
      if ((row.local < cut && cut < row.data) || (row.at < cut && cut < stop))
        throw new Error('Fixture cut crosses a ZIP header')
    }
  }
  for (const row of records) {
    const disk = diskAt(row.local)
    bytes.writeUInt16LE(disk, row.at + 34)
    bytes.writeUInt32LE(row.local - starts[disk]!, row.at + 42)
  }
  const last = diskAt(end), directoryDisk = diskAt(central)
  bytes.writeUInt16LE(last, end + 4)
  bytes.writeUInt16LE(directoryDisk, end + 6)
  bytes.writeUInt16LE(records.filter((row) => diskAt(row.at) === last).length, end + 8)
  bytes.writeUInt32LE(central - starts[directoryDisk]!, end + 16)
  return starts.map((at, i) => bytes.subarray(at, starts[i + 1] ?? bytes.length))
}
