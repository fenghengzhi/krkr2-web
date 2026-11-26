import type { TrackReader } from './track.ts'

// ECMA-167 parts 3 and 4; ECMA TR/112 parts 4 and 7 (UDF 2.01 and 1.02).
// All addresses here are 2048-byte DVD logical sectors. ICB block numbers
// later stored in a directory are relative to a mapped partition.
export const udfBlock = 2048
export class UdfFormatError extends Error {}
export function udfError(reason: string): never { throw new UdfFormatError('UDF: ' + reason) }
export const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
export interface IcbAddress { block: number; partition: number }
export interface UdfPartition { start: number; blocks: number }
export interface UdfVolume { label: string; partitions: UdfPartition[]; root: IcbAddress }
export function longAddress(view: DataView, at: number): IcbAddress {
  return { block: view.getUint32(at + 4, true), partition: view.getUint16(at + 8, true) }
}
export function physicalBlock(partitions: UdfPartition[], address: IcbAddress, bytes: number): number {
  const part = partitions[address.partition]
  if (!part || address.block >= part.blocks || Math.ceil(bytes / udfBlock) > part.blocks - address.block)
    return udfError('extent outside its physical partition')
  return part.start + address.block
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

/** OSTA Compressed Unicode uses either one byte per code unit or UCS-2BE. */
export function udfText(bytes: Uint8Array): string {
  if (!bytes.length) return ''
  const compression = bytes[0]
  if (compression !== 8 && compression !== 16 || compression === 16 && bytes.length % 2 !== 1)
    return udfError('unsupported CS0 string')
  let value = ''
  for (let i = 1; i < bytes.length; i += compression / 8)
    value += String.fromCharCode(compression === 8 ? bytes[i]! : bytes[i]! * 256 + bytes[i + 1]!)
  return value
}
const identifier = (bytes: Uint8Array, at: number, size: number) =>
  String.fromCharCode(...bytes.subarray(at, at + size)).replace(/\0+$/, '')

interface Extent { start: number; length: number }
function extent(view: DataView, at: number): Extent {
  return { length: view.getUint32(at, true), start: view.getUint32(at + 4, true) }
}

async function readSequence(reader: TrackReader, sequence: Extent): Promise<UdfVolume> {
  const blocks = reader.size / udfBlock, recorded = new Map<number, UdfPartition & { sequence: number }>()
  const visited = new Set<number>()
  let logical: Uint8Array | undefined, logicalSeq = -1, finished = false
  while (!finished) {
    const count = Math.ceil(sequence.length / udfBlock)
    if (!count || count > 1024 || sequence.start + count > blocks || visited.has(sequence.start))
      return udfError('invalid volume descriptor sequence')
    let next: Extent | undefined
    for (let i = 0; i < count; i++) {
      const block = sequence.start + i
      if (visited.has(block) || visited.size >= 1024) return udfError('volume descriptor sequence exceeds its bounds')
      visited.add(block)
      const bytes = await reader.read(block * udfBlock, udfBlock), view = descriptor(bytes, block)
      const id = view.getUint16(0, true), serial = view.getUint32(16, true)
      if (id === 8) { finished = true; break }
      if (id === 3) { next = extent(view, 20); break }
      if (id === 5) {
        const number = view.getUint16(22, true), start = view.getUint32(188, true), length = view.getUint32(192, true)
        if (!length || start + length > blocks) return udfError('invalid partition descriptor')
        if (serial >= (recorded.get(number)?.sequence ?? -1)) recorded.set(number, { start, blocks: length, sequence: serial })
      } else if (id === 6 && serial >= logicalSeq) { logical = bytes; logicalSeq = serial }
    }
    if (next) sequence = next
    else if (!finished) return udfError('unterminated volume descriptor sequence')
  }
  if (!logical) return udfError('missing logical volume descriptor')
  const lvd = viewOf(logical)
  if (lvd.getUint32(212, true) !== udfBlock || identifier(logical, 217, 23) !== '*OSTA UDF Compliant')
    return udfError('unsupported logical volume or logical block size')
  const maps = lvd.getUint32(268, true), mapBytes = lvd.getUint32(264, true), partitions: UdfPartition[] = []
  if (!maps || maps > 256 || mapBytes > logical.length - 440) return udfError('invalid partition maps')
  let at = 440
  for (let i = 0; i < maps; i++, at += 6) {
    if (at + 6 > 440 + mapBytes || logical[at] !== 1 || logical[at + 1] !== 6 || lvd.getUint16(at + 2, true) !== 1)
      return udfError('only Type 1 physical partition maps on a single volume are supported')
    const part = recorded.get(lvd.getUint16(at + 4, true))
    if (!part) return udfError('unmapped physical partition')
    partitions.push(part)
  }
  if (at !== 440 + mapBytes) return udfError('unexpected partition map length')
  const labelSize = logical[211]!
  if (labelSize > 127) return udfError('invalid logical volume name')
  const label = udfText(logical.subarray(84, 84 + labelSize))
  const address = longAddress(lvd, 248), fileSetBytes = lvd.getUint32(248, true)
  if (!fileSetBytes || fileSetBytes > 64 * udfBlock) return udfError('unsupported file set sequence')
  const start = physicalBlock(partitions, address, fileSetBytes)
  for (let i = 0; i < Math.ceil(fileSetBytes / udfBlock); i++) {
    const bytes = await reader.read((start + i) * udfBlock, udfBlock), fsd = descriptor(bytes, address.block + i)
    if (fsd.getUint16(0, true) === 256) {
      const root = longAddress(fsd, 400)
      physicalBlock(partitions, root, udfBlock)
      return { label, partitions, root }
    }
    if (fsd.getUint16(0, true) === 8) break
  }
  return udfError('missing file set descriptor')
}

/** Called for a BEA01 extended recognition area. Do not search ordinary ISO
 * payloads for magic bytes. Primary and reserve sequences are independent. */
export async function readUdfVolume(reader: TrackReader, begin: number): Promise<UdfVolume | undefined> {
  const blocks = reader.size / udfBlock
  let nsr = false, complete = false
  for (let i = begin + 1; i < Math.min(blocks, begin + 64); i++) {
    const header = await reader.read(i * udfBlock, 7), id = identifier(header, 1, 5)
    if (header[0] !== 0 || header[6] !== 1) return
    if (id === 'NSR02' || id === 'NSR03') nsr = true
    if (id === 'TEA01') { complete = true; break }
  }
  if (!nsr || !complete) return
  let failure: UdfFormatError | undefined
  const sequences = new Set<number>()
  for (const block of new Set([256, blocks - 257, blocks - 1])) {
    if (block < 0 || block >= blocks) continue
    const bytes = await reader.read(block * udfBlock, udfBlock)
    if (viewOf(bytes).getUint16(0, true) !== 2) continue
    try {
      const anchor = descriptor(bytes, block)
      for (const offset of [16, 24]) {
        const seq = extent(anchor, offset)
        if (!seq.length || sequences.has(seq.start)) continue
        sequences.add(seq.start)
        try { return await readSequence(reader, seq) }
        catch (error) { if (!(error instanceof UdfFormatError)) throw error; failure ??= error }
      }
    } catch (error) { if (!(error instanceof UdfFormatError)) throw error; failure ??= error }
  }
  throw failure ?? new UdfFormatError('UDF: no readable anchor and volume sequence')
}
