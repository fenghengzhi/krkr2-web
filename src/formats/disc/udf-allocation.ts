import type { TrackReader } from './track.ts'

export const udfBlock = 2048
export class UdfFormatError extends Error {}
export function udfError(reason: string): never { throw new UdfFormatError('UDF: ' + reason) }
export const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
export interface IcbAddress { block: number; partition: number }
export interface SparedPacket { original: number; physical: number }
export interface UdfPartition {
  start: number
  blocks: number
  metadata?: UdfRun[]
  sparing?: { packetSize: number; packets: SparedPacket[] }
}

export function longAddress(view: DataView, at: number): IcbAddress {
  return { block: view.getUint32(at + 4, true), partition: view.getUint16(at + 8, true) }
}
/** Return the first physically contiguous portion of a logical extent. Most
 * DVD files span thousands of unchanged packets and need only one run. */
export function mappedExtent(partitions: UdfPartition[], address: IcbAddress, bytes: number) {
  const part = partitions[address.partition]
  if (!part || address.block >= part.blocks || Math.ceil(bytes / udfBlock) > part.blocks - address.block)
    return udfError('extent outside its physical partition')
  const block = address.block, sparing = part.sparing
  if (part.metadata) {
    const offset = block * udfBlock, run = part.metadata[runIndex(part.metadata, offset)]
    if (!run || run.physical === undefined) return udfError('unrecorded metadata partition block')
    const within = offset - run.offset
    return { physical: (run.physical + within) / udfBlock, bytes: Math.min(bytes, run.length - within) }
  }
  if (!sparing?.packets.length) return { physical: part.start + block, bytes }
  const { packets, packetSize } = sparing, within = block % packetSize, packet = block - within
  let low = 0, high = packets.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (packets[middle]!.original < packet) low = middle + 1
    else high = middle
  }
  const next = packets[low]
  if (next?.original === packet)
    return { physical: next.physical + within, bytes: Math.min(bytes, (packetSize - within) * udfBlock) }
  return { physical: part.start + block, bytes: next ? Math.min(bytes, (next.original - block) * udfBlock) : bytes }
}

/** ECMA-167 descriptor tag and CRC-ITU-T, initial value zero. The tag's
 * location is absolute in a volume sequence and partition-relative in an ICB. */
export function descriptor(bytes: Uint8Array, location?: number): DataView {
  if (bytes.length < 16) return udfError('short descriptor tag')
  const view = viewOf(bytes), version = view.getUint16(2, true), length = view.getUint16(10, true)
  let sum = 0, crc = 0
  for (let i = 0; i < 16; i++) if (i !== 4) sum += bytes[i]!
  if ((version !== 2 && version !== 3) || (sum & 255) !== bytes[4] ||
      (location !== undefined && view.getUint32(12, true) !== location) || length > bytes.length - 16)
    return udfError('inconsistent descriptor tag')
  for (const byte of bytes.subarray(16, 16 + length)) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff
  }
  if (crc !== view.getUint16(8, true)) return udfError('descriptor CRC mismatch')
  return view
}

export interface UdfRun { offset: number; length: number; block: number; physical?: number }
export function runIndex(runs: UdfRun[], offset: number): number {
  let low = 0, high = runs.length
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (runs[middle]!.offset <= offset) low = middle
    else high = middle
  }
  return low
}

function* mappedRuns(partitions: UdfPartition[], address: IcbAddress, length: number) {
  for (let offset = 0; offset < length;) {
    const block = address.block + offset / udfBlock
    const span = mappedExtent(partitions, { partition: address.partition, block }, length - offset)
    yield { ...span, block, offset }
    offset += span.bytes
  }
}

export async function readAllocatedRuns(reader: TrackReader, partitions: UdfPartition[], start: Uint8Array, mode: number, partition: number, size: number): Promise<UdfRun[]> {
  if (mode !== 0 && mode !== 1) return udfError('unsupported allocation descriptor type')
  const width = mode === 0 ? 8 : 16, seen = new Set<number>(), runs: UdfRun[] = []
  let table = start, written = 0, count = 0
  for (;;) {
    if (table.length % width !== 0) return udfError('incomplete allocation descriptor')
    const view = viewOf(table)
    let continuation: Uint8Array | undefined
    for (let at = 0; at < table.length; at += width) {
      if (++count > 65536) return udfError('too many allocation descriptors')
      const raw = view.getUint32(at, true), length = raw & 0x3fffffff, kind = raw >>> 30
      if (!length) break
      const address = { block: view.getUint32(at + 4, true), partition: mode === 0 ? partition : view.getUint16(at + 8, true) }
      if (kind === 3) {
        if (at + width !== table.length || length < 24 || length > 1024 * 1024 || seen.size >= 1024)
          return udfError('invalid allocation extent continuation')
        const bytes = new Uint8Array(length)
        for (const run of mappedRuns(partitions, address, length)) {
          if (run.offset === 0) {
            if (seen.has(run.physical)) return udfError('repeated allocation extent continuation')
            seen.add(run.physical)
          }
          bytes.set(await reader.read(run.physical * udfBlock, run.bytes), run.offset)
        }
        const next = descriptor(bytes, address.block), fields = next.getUint32(20, true)
        if (next.getUint16(0, true) !== 258 || fields > bytes.length - 24) return udfError('bad allocation extent descriptor')
        continuation = bytes.subarray(24, 24 + fields)
      } else {
        if (!Number.isSafeInteger(written + length)) return udfError('file length exceeds exact byte offsets')
        const visible = Math.min(length, size - written)
        if (kind === 0) {
          for (const run of mappedRuns(partitions, address, length)) {
            if (run.offset >= visible) break
            runs.push({ offset: written + run.offset, length: Math.min(run.bytes, visible - run.offset),
              block: run.block, physical: run.physical * udfBlock })
            if (runs.length > 131072) return udfError('too many recorded file extents')
          }
        } else {
          // An allocated but unrecorded extent has an address. A sparse
          // unallocated extent has none. Both return zero bytes to the game.
          if (kind === 1) mappedExtent(partitions, address, length)
          if (visible > 0) runs.push({ offset: written, length: visible, block: address.block })
        }
        written += length
      }
    }
    if (!continuation) break
    table = continuation
  }
  if (written < size) return udfError('file allocation is shorter than its information length')
  return runs
}

export function parseFileEntry(bytes: Uint8Array, location: number) {
  const view = descriptor(bytes, location)
  const id = view.getUint16(0, true), type = bytes[27]!, mode = view.getUint16(34, true) & 7
  if ((id !== 261 && id !== 266) || view.getUint16(20, true) !== 4)
    return udfError('expected a direct file entry or extended file entry')
  const base = id === 261 ? 176 : 216, start = base + view.getUint32(base - 8, true), length = view.getUint32(base - 4, true)
  const size = Number(view.getBigUint64(56, true))
  if (!Number.isSafeInteger(size) || start + length > bytes.length) return udfError('invalid file entry lengths')
  const allocation = bytes.subarray(start, start + length), embedded = mode === 3
  if (embedded && size > allocation.length) return udfError('truncated embedded file')
  return { mode, type, size, allocation, embedded }
}
