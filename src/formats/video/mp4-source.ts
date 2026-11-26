/** Structural Blob interface: the format layer also builds without DOM libs. */
export interface Mp4BlobSource {
  readonly size: number
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> }
}
export interface Mp4MetadataOptions {
  checkpoint?(): void | Promise<void>
  yieldControl?(): void | Promise<void>
  /** Incremental temporary-buffer charge before each allocation/read. The
   * caller releases its accumulated reservation in finally, including failure.
   * Parser objects/sample tables are separately bounded by their existing caps. */
  reserveMetadata?(bytes: number): void
}
export interface Mp4Patch { offset: number; bytes: Uint8Array<ArrayBuffer> }
export const mp4MetadataByteLimit = 64 * 1024 * 1024
export const mp4TimelineStarts = ['ftyp', 'moov', 'free', 'wide', 'mdat']
export const mp4SelectionStarts = ['ftyp', 'moov', 'mdat', 'styp', 'moof', 'mfra', 'sidx', 'pdin', 'pssh', 'uuid', 'free', 'skip', 'wide']
const padding = ['free', 'skip', 'wide']
interface Part { start: number; bytes: Uint8Array<ArrayBuffer>; view: DataView; padding: boolean }

export async function cooperateMp4(options: Mp4MetadataOptions): Promise<void> {
  await options.checkpoint?.()
  await options.yieldControl?.()
  await options.checkpoint?.()
}
export const mp4Tag = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))

/** Metadata at original file offsets. Missing ranges are deliberately not
 * readable: a parser regression must not silently replace media with zeroes. */
export class Mp4Data {
  private cached = 0
  private readonly writes: Array<{ start: number; end: number; part: Part }> = []
  constructor(readonly length: number, private readonly parts: Part[],
    readonly contiguous?: Uint8Array<ArrayBuffer>) {}
  static owned(bytes: Uint8Array<ArrayBuffer>): Mp4Data {
    return new Mp4Data(bytes.length, [{ start: 0, bytes, view: new DataView(bytes.buffer), padding: false }], bytes)
  }
  private part(at: number, length: number): Part {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0 ||
        at > this.length || length > this.length - at) throw new Error('MP4 metadata read is outside the file')
    let part = this.parts[this.cached]
    if (!part || at < part.start || at + length > part.start + part.bytes.length) {
      let low = 0, high = this.parts.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (this.parts[mid]!.start <= at) low = mid + 1
        else high = mid
      }
      this.cached = low - 1
      part = this.parts[this.cached]
    }
    if (!part || at < part.start || at + length > part.start + part.bytes.length)
      throw new Error('MP4 parser requested unloaded media or padding bytes')
    return part
  }
  getUint8(at: number): number { const p = this.part(at, 1); return p.view.getUint8(at - p.start) }
  getUint16(at: number): number { const p = this.part(at, 2); return p.view.getUint16(at - p.start) }
  getUint32(at: number): number { const p = this.part(at, 4); return p.view.getUint32(at - p.start) }
  getInt32(at: number): number { const p = this.part(at, 4); return p.view.getInt32(at - p.start) }
  getBigUint64(at: number): bigint { const p = this.part(at, 8); return p.view.getBigUint64(at - p.start) }
  tag(at: number): string { const p = this.part(at, 4); return mp4Tag(p.bytes, at - p.start) }
  set(bytes: readonly number[], at: number): void {
    const part = this.part(at, bytes.length)
    part.bytes.set(bytes, at - part.start)
    if (!this.contiguous) this.writes.push({ start: at, end: at + bytes.length, part })
  }
  setUint16(at: number, value: number): void { this.set([value >>> 8 & 255, value & 255], at) }
  patches(): Mp4Patch[] {
    const spans: Array<{ start: number; end: number; part: Part }> = []
    for (const write of this.writes.sort((a, b) => a.start - b.start)) {
      const previous = spans.at(-1)
      // Coalesce nearby fields, never span an unloaded mdat/padding extent.
      if (previous?.part === write.part && write.start - previous.end <= 4096)
        previous.end = Math.max(previous.end, write.end)
      else spans.push({ ...write })
    }
    return spans.map(({ start, end, part }) => ({ offset: start,
      bytes: part.bytes.subarray(start - part.start, end - part.start) }))
  }
  async appendTo(append: (buffer: ArrayBuffer & { fileStart: number; usedBytes: number }) => unknown,
    options: Mp4MetadataOptions): Promise<void> {
    let count = 0, work = 0
    for (const part of this.parts) {
      await options.checkpoint?.()
      work += part.bytes.length
      if (++count % 128 === 0 || work >= 1024 * 1024) {
        await options.yieldControl?.()
        await options.checkpoint?.()
        work = 0
      }
      let bytes = part.bytes
      if (part.padding) {
        // MP4Box 2.4.1 can skip sparse mdat but not incomplete free/skip/wide.
        // Present only this header as discardable media to its metadata parser;
        // actual source kind/extent and sample validation remain unchanged.
        bytes = Uint8Array.from(bytes)
        bytes.set([109, 100, 97, 116], 4)
      }
      append(Object.assign(bytes.buffer, { fileStart: part.start, usedBytes: 0 }))
    }
    await options.checkpoint?.()
  }
}

/** Read top-level metadata only, including tail moov and 64-bit box extents.
 * mdat and known padding retain just their 8/16-byte headers. */
export async function readMp4Blob(source: Mp4BlobSource, starts: readonly string[],
  options: Mp4MetadataOptions = {}): Promise<Mp4Data | undefined> {
  const length = source.size
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid MP4 Blob size')
  await options.checkpoint?.()
  if (length < 8) return
  let charged = 0, reads = 0, work = 0
  const reserve = (bytes: number) => {
    if (bytes > mp4MetadataByteLimit - charged) throw new Error('MP4 metadata exceeds the 64 MiB budget')
    options.reserveMetadata?.(bytes)
    charged += bytes
  }, read = async (at: number, length: number): Promise<Uint8Array<ArrayBuffer>> => {
    await options.checkpoint?.()
    work += length
    if (++reads % 128 === 0 || work >= 1024 * 1024) {
      await options.yieldControl?.()
      await options.checkpoint?.()
      work = 0
    }
    reserve(length)
    const buffer = await source.slice(at, at + length).arrayBuffer()
    await options.checkpoint?.()
    if (buffer.byteLength !== length) throw new Error('Truncated MP4 Blob range')
    return new Uint8Array(buffer)
  }
  const parts: Part[] = []
  let boxes = 0
  for (let at = 0; at < length;) {
    if (++boxes > 100000) throw new Error('MP4 box budget exceeded')
    if (length - at < 8) throw new Error('Truncated MP4 box header')
    let bytes = await read(at, 8), view = new DataView(bytes.buffer), size = view.getUint32(0), header = 8
    const kind = mp4Tag(bytes, 4)
    if (at === 0 && !starts.includes(kind)) return
    if (size === 1) {
      if (length - at < 16) throw new Error('Truncated extended MP4 box')
      bytes = await read(at, 16); view = new DataView(bytes.buffer)
      const extended = view.getBigUint64(8)
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MP4 box size exceeds safe integer range')
      size = Number(extended); header = 16
    } else if (size === 0) size = length - at
    if (size < header || size > length - at) throw new Error('Truncated MP4 box extent')
    const skip = kind === 'mdat' || padding.includes(kind)
    if (!skip && size > header) { bytes = await read(at, size); view = new DataView(bytes.buffer) }
    // Synthetic padding headers used by appendTo are included before any
    // parser work so they cannot bypass the total metadata buffer budget.
    if (padding.includes(kind)) reserve(header)
    parts.push({ start: at, bytes, view, padding: padding.includes(kind) })
    at += size
  }
  // Header conversion has already been charged; avoid charging it a second
  // time when appendTo actually makes its private 8/16-byte copy.
  return new Mp4Data(length, parts)
}
