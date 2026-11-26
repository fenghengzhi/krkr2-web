import { videoSourceLimits, type VideoCommand, type VideoTimeline } from '../../../engine/ports/video.ts'
import { selectMp4Tracks, selectMp4TracksBlob } from '../../../formats/video/mp4-audio.ts'

export const videoEncodedLimits = Object.freeze({
  sourceBytes: videoSourceLimits.bufferedBytes,
  borrowedBytes: videoSourceLimits.borrowedBytes,
  ownedBytes: 256 * 1024 * 1024,
})
export interface VideoEncodedSource {
  readonly size: number
  readonly bytes?: Uint8Array
  readonly blob?: Blob
  retain(): VideoEncodedSource
  release(): void
}
export interface VideoEncodedVariant {
  readonly url: string
  readonly size: number
  release(): void
}
interface SourceRecord { data?: Blob | Uint8Array; size: number; references: number }
type OpenBytes = Extract<VideoCommand, { op: 'open' }>['bytes']

/** Charge resident encoded copies separately from file views. Blob variants
 * lease the backing until their last URL is revoked. Decoder allocations and
 * delayed garbage collection are outside this accounting. */
export class VideoEncodedResources {
  private sourceBytes = 0
  private borrowedBytes = 0
  private ownedBytes = 0
  private sources = 0
  private readonly limits: typeof videoEncodedLimits
  constructor(limits: Partial<typeof videoEncodedLimits> = {}) {
    this.limits = { ...videoEncodedLimits, ...limits }
    for (const key of ['sourceBytes', 'borrowedBytes', 'ownedBytes'] as const)
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 0 || this.limits[key] > videoEncodedLimits[key])
        throw new Error('Invalid video encoded resource limit')
  }
  private charge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.ownedBytes - this.ownedBytes)
      throw new Error('Video owned encoded resource budget exceeded')
    this.ownedBytes += bytes
  }
  source(input: OpenBytes, takeRelease?: () => (() => void) | undefined): VideoEncodedSource {
    let data: Uint8Array | Blob, borrowed = false
    if (input instanceof Uint8Array) data = input
    else {
      if (!(input.blob instanceof Blob) || typeof input.buffered !== 'boolean')
        throw new Error('Invalid video Blob source')
      data = input.blob
      borrowed = !input.buffered
    }
    const size = data instanceof Uint8Array ? data.byteLength : data.size,
      pool = borrowed ? 'borrowedBytes' : 'sourceBytes'
    if (!Number.isSafeInteger(size) || size < 0 || size > this.limits[pool] - this[pool])
      throw new Error('Video source resource budget exceeded')
    if (!borrowed) this.charge(size)
    this[pool] += size
    this.sources++
    const record: SourceRecord = { data, size, references: 0 }, onRelease = takeRelease?.()
    const lease = (): VideoEncodedSource => {
      record.references++
      let live = true
      const current = () => {
        if (!live || !record.data) throw new Error('Video encoded source is closed')
        return record.data
      }
      return {
        size: record.size,
        get bytes() { const value = current(); return value instanceof Uint8Array ? value : undefined },
        get blob() { const value = current(); return value instanceof Blob ? value : undefined },
        retain() { current(); return lease() },
        release: () => {
          if (!live) return
          live = false
          if (--record.references) return
          record.data = undefined
          this[pool] -= record.size
          if (!borrowed) this.ownedBytes -= record.size
          this.sources--
          onRelease?.()
        },
      }
    }
    return lease()
  }
  private publish(create: () => Blob, release: () => void): VideoEncodedVariant {
    let url: string, size: number
    try {
      const blob = create()
      size = blob.size
      url = URL.createObjectURL(blob)
    } catch (error) { release(); throw error }
    let live = true
    return { url, size, release() {
      if (!live) return
      live = false
      try { URL.revokeObjectURL(url) } finally { release() }
    } }
  }
  private copy(bytes: Uint8Array, mime: string): VideoEncodedVariant {
    const size = bytes.byteLength
    this.charge(size)
    return this.publish(() => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }),
      () => { this.ownedBytes -= size })
  }
  original(source: VideoEncodedSource, mime: string): VideoEncodedVariant {
    const blob = source.blob
    if (!blob) return this.copy(source.bytes!, mime)
    const backing = source.retain()
    return this.publish(() => blob.slice(0, blob.size, mime), () => backing.release())
  }
  private patched(source: VideoEncodedSource, blob: Blob, patches: readonly { offset: number; bytes: Uint8Array }[],
    mime: string): VideoEncodedVariant {
    const parts: BlobPart[] = []
    let end = 0, patchBytes = 0
    for (const patch of patches) {
      if (!Number.isSafeInteger(patch.offset) || patch.offset < end || !patch.bytes.length ||
          patch.bytes.length > blob.size - patch.offset)
        throw new Error('Invalid MP4 selection patch extent')
      if (patch.offset > end) parts.push(blob.slice(end, patch.offset))
      parts.push(patch.bytes as Uint8Array<ArrayBuffer>)
      end = patch.offset + patch.bytes.length
      patchBytes += patch.bytes.length
    }
    if (end < blob.size) parts.push(blob.slice(end))
    this.charge(patchBytes)
    const backing = source.retain()
    return this.publish(() => new Blob(parts, { type: mime }), () => {
      this.ownedBytes -= patchBytes
      backing.release()
    })
  }
  async select(source: VideoEncodedSource, index: number, timeline: VideoTimeline,
    mime: string, valid: () => void): Promise<VideoEncodedVariant> {
    valid()
    const retained = source.retain(), video = timeline.selectedVideoStream ?? 0,
      selection = { video, ...(timeline.audioStreams ? { audio: index } : {}) }
    let temporary = 0
    const reserveMetadata = (bytes: number) => { this.charge(bytes); temporary += bytes }
    const options = { checkpoint: valid, yieldControl: () => new Promise<void>((resolve) => setTimeout(resolve, 0)), reserveMetadata,
      completeFragmentDurations: true }
    try {
      const blob = retained.blob
      if (!blob) reserveMetadata(retained.size)
      const selected = blob ? await selectMp4TracksBlob(blob, selection, options)
        : await selectMp4Tracks(retained.bytes!, selection, options)
      valid()
      if (!selected) throw new Error('Alternate stream selection requires a supported MP4 container')
      const size = 'patches' in selected ? selected.size : selected.bytes.length
      if (size !== retained.size || selected.audioStreams !== timeline.audioStreams ||
          selected.videoStreams !== timeline.videoStreams ||
          (timeline.videoTracks && selected.selectedVideoTrackId !== timeline.videoTracks[video]?.id))
        throw new Error('MP4 stream selection disagrees with the original video timeline')
      return 'patches' in selected ? this.patched(retained, blob!, selected.patches, mime) : this.copy(selected.bytes, mime)
    } finally {
      this.ownedBytes -= temporary
      retained.release()
    }
  }
  inspect(): { sources: number; sourceBytes: number; ownedBytes: number } {
    return { sources: this.sources, sourceBytes: this.sourceBytes + this.borrowedBytes, ownedBytes: this.ownedBytes }
  }
}
