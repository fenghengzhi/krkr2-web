import { extentBorrower } from '../../engine/storage/resource-source.ts'
import type { ArchiveReader, ByteSource } from '../../engine/ports/storage.ts'

export interface SectorLayout { bytes: number; payload: number }
export interface DiscVolumeTrack {
  file: string
  first: number
  end?: number
  layout: SectorLayout
}

export function isDataSector(bytes: Uint8Array, { bytes: stride, payload }: SectorLayout): boolean {
  if (stride === 2352) {
    if (bytes[0] !== 0 || bytes[11] !== 0 || bytes[15] !== (payload === 16 ? 1 : 2)) return false
    for (let i = 1; i <= 10; i++) if (bytes[i] !== 255) return false
  }
  if (payload === 8 || payload === 24) {
    const sub = payload - 8
    if (bytes[sub + 2]! & 32) return false // XA Form 2 does not carry 2048-byte logical blocks.
    for (let i = 0; i < 4; i++) if (bytes[sub + i] !== bytes[sub + 4 + i]) return false
  }
  return true
}

const sectorSize = 2048, maxRead = 64 * 1024 * 1024
const invalid = (detail: string): never => { throw new Error('Invalid disc track: ' + detail) }
function range(offset: number, length: number, size: number) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      offset > size || length > size - offset) invalid('read or extent outside its data range')
}
/** Map logical 2048-byte sectors to the selected CUE track, preserving the
 * headers of raw sectors for Mode 1 / Mode 2 Form 1 validation. */
export class TrackReader {
  readonly size: number
  readonly canBorrow: boolean
  private readonly track: DiscVolumeTrack
  private readonly borrow: ByteSource['borrowBlob']
  constructor(private readonly source: ByteSource, track: DiscVolumeTrack, private readonly join?: ArchiveReader['joinBlobs']) {
    this.track = { ...track, layout: { ...track.layout } }
    this.borrow = source.borrowBlob?.bind(source)
    const { bytes, payload } = track.layout
    if (!Number.isSafeInteger(source.size) || source.size < 0 || !Number.isSafeInteger(track.first) || track.first < 0 ||
        (track.end !== undefined && (!Number.isSafeInteger(track.end) || track.end < track.first)) ||
        !((bytes === 2048 && payload === 0) || (bytes === 2352 && (payload === 16 || payload === 24)) ||
          (bytes === 2336 && payload === 8))) invalid('unsupported track geometry')
    const end = Math.min(Math.floor(source.size / bytes), track.end ?? Infinity)
    if (track.first > end) invalid('track starts after its data')
    this.size = (end - track.first) * sectorSize
    if (!Number.isSafeInteger(this.size)) invalid('track size is not an exact byte offset')
    this.canBorrow = bytes === sectorSize && payload === 0 && !!this.borrow
  }
  async borrowBlob(offset: number, length: number, checkpoint?: () => void | Promise<void>) {
    range(offset, length, this.size)
    if (!this.canBorrow || !this.borrow) throw new Error('Disc track has no contiguous Blob backing')
    await checkpoint?.()
    const blob = await this.borrow(this.track.first * sectorSize + offset, length, checkpoint)
    await checkpoint?.()
    if (blob.size !== length) invalid('borrowed Blob has an inconsistent size')
    return blob
  }
  fileBorrower(extents: { start: number; size: number }[]): ByteSource['borrowBlob'] {
    if (!this.canBorrow) return
    return extentBorrower(extents, (offset, length, check) => this.borrowBlob(offset, length, check), this.join)
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    range(offset, length, this.size)
    if (length > maxRead) invalid('single read exceeds 64 MiB')
    const out = new Uint8Array(length), { bytes: stride, payload } = this.track.layout
    let written = 0
    while (written < length) {
      const at = offset + written, sector = Math.floor(at / sectorSize), within = at % sectorSize,
        sectors = Math.min(Math.floor(65536 / stride), Math.ceil((within + length - written) / sectorSize)),
        count = Math.min(length - written, sectors * sectorSize - within),
        physical = (this.track.first + sector) * stride,
        raw = await this.source.read(physical, sectors * stride)
      if (raw.length !== sectors * stride) invalid('short sector read')
      if (stride === sectorSize) out.set(raw.subarray(within, within + count), written)
      else {
        let remaining = count, skip = within, destination = written
        for (let i = 0; i < sectors; i++) {
          const data = raw.subarray(i * stride, (i + 1) * stride)
          if (!isDataSector(data, this.track.layout)) invalid('unsupported or incomplete data sector')
          const take = Math.min(remaining, sectorSize - skip)
          out.set(data.subarray(payload + skip, payload + skip + take), destination)
          remaining -= take; destination += take; skip = 0
        }
      }
      written += count
    }
    return out
  }
}
