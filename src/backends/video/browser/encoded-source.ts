import type { VideoTimeline } from '../../../engine/ports/video.ts'
import { selectMp4Tracks } from '../../../formats/video/mp4-audio.ts'

export const videoEncodedLimits = Object.freeze({ sourceBytes: 128 * 1024 * 1024, ownedBytes: 256 * 1024 * 1024 })
export interface VideoEncodedSource {
  readonly size: number
  readonly bytes: Uint8Array
  retain(): VideoEncodedSource
  release(): void
}
export interface VideoEncodedVariant {
  readonly url: string
  readonly size: number
  release(): void
}
interface SourceRecord { bytes?: Uint8Array; size: number; references: number }

/** Accounts retained sources, Blob URLs and the selector's temporary copy.
 * Browser decoder allocations and delayed garbage collection are separate.
 * Limits may be reduced by embedders but never enlarged beyond production. */
export class VideoEncodedResources {
  private sourceBytes = 0
  private ownedBytes = 0
  private sources = 0
  private readonly limits: { sourceBytes: number; ownedBytes: number }
  constructor(limits: Partial<typeof videoEncodedLimits> = {}) {
    this.limits = { ...videoEncodedLimits, ...limits }
    for (const key of ['sourceBytes', 'ownedBytes'] as const)
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 0 || this.limits[key] > videoEncodedLimits[key])
        throw new Error('Invalid video encoded resource limit')
  }
  private reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.ownedBytes - this.ownedBytes)
      throw new Error('Video owned encoded resource budget exceeded')
    this.ownedBytes += bytes
    let live = true
    return () => { if (live) { live = false; this.ownedBytes -= bytes } }
  }
  source(bytes: Uint8Array): VideoEncodedSource {
    if (bytes.length > this.limits.sourceBytes - this.sourceBytes)
      throw new Error('Video source resource budget exceeded')
    const release = this.reserve(bytes.length), record: SourceRecord = { bytes, size: bytes.length, references: 0 }
    this.sourceBytes += record.size
    this.sources++
    const lease = (): VideoEncodedSource => {
      if (!record.bytes) throw new Error('Video encoded source is closed')
      record.references++
      let live = true
      const current = () => { if (!live || !record.bytes) throw new Error('Video encoded source is closed') }
      return {
        size: record.size,
        get bytes() { current(); return record.bytes! },
        retain() { current(); return lease() },
        release: () => {
          if (!live) return
          live = false
          if (--record.references) return
          record.bytes = undefined
          this.sourceBytes -= record.size
          this.sources--
          release()
        },
      }
    }
    return lease()
  }
  private blob(bytes: Uint8Array, mime: string): VideoEncodedVariant {
    const release = this.reserve(bytes.length)
    let url: string
    try { url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime })) }
    catch (error) { release(); throw error }
    let live = true
    return { url, size: bytes.length, release() {
      if (!live) return
      live = false
      try { URL.revokeObjectURL(url) } finally { release() }
    } }
  }
  original(source: VideoEncodedSource, mime: string): VideoEncodedVariant { return this.blob(source.bytes, mime) }
  private async selectedBlob(source: VideoEncodedSource, index: number, timeline: VideoTimeline,
    mime: string, valid: () => void): Promise<VideoEncodedVariant> {
    const video = timeline.selectedVideoStream ?? 0,
      selected = await selectMp4Tracks(source.bytes,
        { video, ...(timeline.audioStreams ? { audio: index } : {}) }, { checkpoint: valid,
      yieldControl: () => new Promise<void>((resolve) => { setTimeout(resolve, 0) }) })
    valid()
    if (!selected) throw new Error('Alternate stream selection requires a supported MP4 container')
    if (selected.bytes.length !== source.size || selected.audioStreams !== timeline.audioStreams ||
        selected.videoStreams !== timeline.videoStreams ||
        (timeline.videoTracks && selected.selectedVideoTrackId !== timeline.videoTracks[video]?.id))
      throw new Error('MP4 stream selection disagrees with the original video timeline')
    return this.blob(selected.bytes, mime)
  }
  async select(source: VideoEncodedSource, index: number, timeline: VideoTimeline,
    mime: string, valid: () => void): Promise<VideoEncodedVariant> {
    valid()
    const retained = source.retain()
    let releaseCopy: (() => void) | undefined
    try {
      releaseCopy = this.reserve(retained.size)
      // selectedBlob's stack/temporary bytes are gone before this outer scope
      // refunds the copy. The old Blob and the new Blob are both charged while
      // replacement is being prepared; allocation failure cannot evict the old.
      return await this.selectedBlob(retained, index, timeline, mime, valid)
    } finally { releaseCopy?.(); retained.release() }
  }
  inspect(): { sources: number; sourceBytes: number; ownedBytes: number } {
    return { sources: this.sources, sourceBytes: this.sourceBytes, ownedBytes: this.ownedBytes }
  }
}
