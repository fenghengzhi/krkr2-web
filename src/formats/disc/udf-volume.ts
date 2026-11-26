import type { TrackReader } from './track.ts'

import { readAllocatedRuns, descriptor, parseFileEntry, longAddress, mappedExtent, udfBlock, udfError, UdfFormatError, viewOf,
  type IcbAddress, type SparedPacket, type UdfPartition } from './udf-allocation.ts'

// The root ICB is relative to a logical partition. The volume recognition
// sequence and anchor use absolute 2048-byte sectors within this track.
export interface UdfVolume { label: string; partitions: UdfPartition[]; root: IcbAddress; mirror?: () => Promise<UdfVolume> }

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

// UDF 2.01 §§2.2.9, 2.2.11. Original packet addresses are partition-relative;
// replacement packets and sparing tables have absolute addresses on this track.
async function readSparing(reader: TrackReader, part: UdfPartition, map: DataView): Promise<UdfPartition> {
  const packetSize = map.getUint16(40, true), copies = map.getUint8(42), size = map.getUint32(44, true),
    blocks = reader.size / udfBlock
  if (!packetSize || !copies || copies > 4 || size < 56)
    return udfError('invalid sparable partition map')
  let newest: { sequence: number; packets: SparedPacket[] } | undefined, failure: UdfFormatError | undefined
  for (let i = 0; i < copies; i++) {
    try {
      const start = map.getUint32(48 + i * 4, true)
      if (start + Math.ceil(size / udfBlock) > blocks) udfError('sparing table outside disc')
      // A table can span several sectors. Read its declared entries without
      // loading arbitrary padding reserved for future format updates.
      const header = await reader.read(start * udfBlock, 56), count = viewOf(header).getUint16(48, true)
      const length = 56 + 8 * count
      if (length > size) udfError('incomplete sparing table')
      const crcBytes = viewOf(header).getUint16(10, true) + 16
      if (crcBytes > size) udfError('invalid sparing table CRC length')
      const table = await reader.read(start * udfBlock, Math.max(length, crcBytes)), view = descriptor(table, start)
      if (view.getUint16(0, true) !== 0 || identifier(table, 17, 23) !== '*UDF Sparing Table')
        udfError('invalid sparing table identifier')
      const sequence = view.getUint32(52, true), packets: SparedPacket[] = []
      let previous = -1
      for (let index = 0; index < count; index++) {
        const original = view.getUint32(56 + index * 8, true), physical = view.getUint32(60 + index * 8, true)
        if (original < previous || physical + packetSize > blocks || physical % packetSize)
          udfError('invalid sparing table entry')
        if (original < 0xfffffff0) {
          if (original === previous || original % packetSize || original + packetSize > part.blocks)
            udfError('invalid original packet location')
          packets.push({ original, physical })
        }
        previous = original
      }
      if (!newest || sequence > newest.sequence) newest = { sequence, packets }
    } catch (error) {
      if (!(error instanceof UdfFormatError)) throw error
      failure ??= error
    }
  }
  if (!newest) throw failure ?? new UdfFormatError('UDF: no readable sparing table')
  return { start: part.start, blocks: part.blocks, sparing: { packetSize, packets: newest.packets } }
}

// UDF 2.50 §§2.2.10, 2.2.13: a metadata block is an offset in a
// special file on the physical or sparable partition. Its mirror has its
// own file entry and can have a completely different extent layout.
async function readMetadata(reader: TrackReader, backing: UdfPartition, map: DataView, mirror: boolean): Promise<UdfPartition> {
  const block = map.getUint32(mirror ? 44 : 40, true)
  const span = mappedExtent([backing], { partition: 0, block }, udfBlock)
  const entry = parseFileEntry(await reader.read(span.physical * udfBlock, udfBlock), block)
  if (entry.type !== (mirror ? 251 : 250) || entry.mode !== 0 || !entry.size || entry.size % udfBlock)
    return udfError('invalid metadata file entry')
  const runs = await readAllocatedRuns(reader, [backing], entry.allocation, entry.mode, 0, entry.size)
  if (runs.some((run) => run.length % udfBlock)) return udfError('unaligned metadata extent')
  return { start: 0, blocks: entry.size / udfBlock, metadata: runs }
}

async function readFileSet(reader: TrackReader, partitions: UdfPartition[], lvd: DataView, label: string): Promise<UdfVolume> {
  const address = longAddress(lvd, 248), fileSetBytes = lvd.getUint32(248, true)
  if (!fileSetBytes || fileSetBytes > 64 * udfBlock) return udfError('unsupported file set sequence')
  for (let i = 0; i < Math.ceil(fileSetBytes / udfBlock); i++) {
    const block = address.block + i, { physical } = mappedExtent(partitions, { ...address, block }, fileSetBytes - i * udfBlock)
    const bytes = await reader.read(physical * udfBlock, udfBlock), fsd = descriptor(bytes, block)
    if (fsd.getUint16(0, true) === 256) {
      const root = longAddress(fsd, 400)
      mappedExtent(partitions, root, udfBlock)
      return { label, partitions, root }
    }
    if (fsd.getUint16(0, true) === 8) break
  }
  return udfError('missing file set descriptor')
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
  let at = 440, backingNumber: number | undefined, metadata: DataView | undefined
  for (let i = 0; i < maps; i++) {
    const type = logical[at], length = logical[at + 1]
    if (!length || at + length > 440 + mapBytes) return udfError('incomplete partition map')
    const physical = type === 1 && length === 6
    const kind = type === 2 && length === 64 ? identifier(logical, at + 5, 23) : ''
    const vol = at + (physical ? 2 : 36)
    if (!physical && kind !== '*UDF Sparable Partition' && kind !== '*UDF Metadata Partition')
      return udfError('unsupported partition map')
    if (lvd.getUint16(vol, true) !== 1) return udfError('multiple UDF volumes are not supported')
    const number = lvd.getUint16(vol + 2, true), part = recorded.get(number)
    if (!part) return udfError('unmapped physical partition')
    const map = viewOf(logical.subarray(at, at + length))
    if (kind === '*UDF Metadata Partition') {
      if (i !== 1 || maps !== 2 || number !== backingNumber)
        return udfError('metadata partition does not reference its underlying partition')
      metadata = map
    } else {
      partitions.push(physical ? part : await readSparing(reader, part, map))
      if (i === 0) backingNumber = number
    }
    at += length
  }
  if (at !== 440 + mapBytes) return udfError('unexpected partition map length')
  const labelSize = logical[211]!
  if (labelSize > 127) return udfError('invalid logical volume name')
  const label = udfText(logical.subarray(84, 84 + labelSize))
  if (!metadata) return readFileSet(reader, partitions, lvd, label)
  const backing = partitions[0]!, map = metadata
  const open = async (mirror: boolean) => {
    const part = await readMetadata(reader, backing, map, mirror)
    return readFileSet(reader, [backing, part], lvd, label)
  }
  try {
    const volume = await open(false)
    if (map.getUint8(58) & 1) volume.mirror = () => open(true)
    return volume
  } catch (error) {
    if (!(error instanceof UdfFormatError)) throw error
    return open(true)
  }
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
