import type { ByteSource } from '../../engine/ports/storage.ts'

const endSignature = 0x06054b50
const directoryHeader = 0x02014b50
const end64 = 0x06064b50
const locator64 = 0x07064b50

/** The comment length binds an end record to the physical end of the file. */
export function* zipEndOffsets(tail: DataView): Generator<number> {
  for (let i = tail.byteLength - 22; i >= 0; --i)
    if (tail.getUint32(i, true) === endSignature && i + 22 + tail.getUint16(i + 20, true) === tail.byteLength) yield i
}

export interface ExecutableZipLocation {
  base: number
  endRecord: number
}

/** Caller saw an MZ prefix. Locate a single-disk ZIP without interpreting the
 * executable. Writers may count offsets from the MZ or the appended ZIP. */
export async function locateExecutableZip(source: ByteSource, checkpoint: () => Promise<void>): Promise<ExecutableZipLocation | undefined> {
  if (source.size < 22) return
  const read = async (at: number, size: number) => {
    await checkpoint()
    const bytes = await source.read(at, size)
    await checkpoint()
    if (bytes.length !== size) throw new Error('Short executable ZIP read')
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  const centralBase = async (end: number, size: number, offset: number) => {
    const start = end - size, base = start - offset
    if (!Number.isSafeInteger(base) || base < 0 || size < 46 || (await read(start, 4)).getUint32(0, true) !== directoryHeader) return
    return base
  }
  async function zip64Base(end: number): Promise<number | undefined> {
    if (end < 76) return
    const locatorAt = end - 20, locator = await read(locatorAt, 20)
    if (locator.getUint32(0, true) !== locator64 || locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) return
    const logical = Number(locator.getBigUint64(8, true))
    const last = locatorAt - 56
    if (!Number.isSafeInteger(logical) || logical > last) return
    const checkRecord = async (at: number) => {
      const record = await read(at, 56)
      if (record.getUint32(0, true) !== end64 || record.getBigUint64(4, true) !== BigInt(locatorAt - at - 12) ||
          record.getUint32(16, true) !== 0 || record.getUint32(20, true) !== 0) return
      const centralSize = Number(record.getBigUint64(40, true)), centralOffset = Number(record.getBigUint64(48, true))
      if (!Number.isSafeInteger(centralSize) || !Number.isSafeInteger(centralOffset)) return
      const base = await centralBase(at, centralSize, centralOffset)
      if (base === at - logical) return base
    }
    // Most ZIP64 writers use a fixed 56-byte record. Adjusted offsets also
    // locate an extended record directly, irrespective of the stub length.
    for (const at of new Set([last, logical])) {
      const base = await checkRecord(at)
      if (base !== undefined) return base
    }
    // An appended ZIP64 with an extensible data sector has a variable-length
    // end record. Search backwards in ranges, never buffering the stub or game.
    for (let right = last; right > logical + 1;) {
      const left = Math.max(logical + 1, right - 65536), block = await read(left, right - left + 3)
      for (let j = right - left - 1; j >= 0; --j) {
        if (block.getUint32(j, true) !== end64) continue
        const base = await checkRecord(left + j)
        if (base !== undefined) return base
      }
      right = left
    }
  }
  const tailAt = Math.max(0, source.size - 65557), tail = await read(tailAt, source.size - tailAt)
  for (const i of zipEndOffsets(tail)) {
    const end = tailAt + i, disk = tail.getUint16(i + 4, true), centralDisk = tail.getUint16(i + 6, true)
    if ((disk !== 0 && disk !== 0xffff) || (centralDisk !== 0 && centralDisk !== 0xffff)) continue
    // ZIP64 remains authoritative when the optional classic fields fit. A
    // second central header can otherwise look like a plausible first one.
    const large = await zip64Base(end)
    if (large !== undefined) return { base: large, endRecord: end }
    const count = tail.getUint16(i + 10, true)
    const size = tail.getUint32(i + 12, true), offset = tail.getUint32(i + 16, true)
    if (count && size !== 0xffffffff && offset !== 0xffffffff) {
      const base = await centralBase(end, size, offset)
      if (base !== undefined) return { base, endRecord: end }
    }
  }
}
