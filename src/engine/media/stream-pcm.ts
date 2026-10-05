import type { PcmAccess, PcmReadRequest, StreamingPcmAsset } from '../ports/audio.ts'

export const streamPageFrames = 4096
export const streamPagesPerVoice = 16
export const streamRequestsPerVoice = 4
export const streamPcmReservation = (channels: number) => streamPageFrames * streamPagesPerVoice * channels * 4

/** Only the realtime consumer owns this cache. The decoder sees copied page
 * requests; stale replies cannot select a new voice or advance its position. */
export class StreamPcm implements PcmAccess {
  readonly asset: StreamingPcmAsset
  private readonly pages = new Map<number, Float32Array[]>()
  private readonly pending = new Map<number, PcmReadRequest>()
  private readonly requests: PcmReadRequest[] = []
  private serial = 1
  private failure?: Error
  private preflightPages?: Set<number>
  constructor(readonly id: number, asset: StreamingPcmAsset) {
    if (!Number.isSafeInteger(asset.streamId) || asset.streamId < 1 ||
        !Number.isSafeInteger(asset.sampleCount) || asset.sampleCount < 1 ||
        !Number.isInteger(asset.channels) || asset.channels < 1 || asset.channels > 8 ||
        asset.initial.length > streamPagesPerVoice) throw new Error('Invalid PCM stream metadata')
    this.asset = { ...asset, initial: [] }
    for (const block of asset.initial) this.store(block.position, block.data)
  }
  private store(position: number, data: Float32Array[]): void {
    const frames = Math.min(streamPageFrames, this.asset.sampleCount - position)
    if (!Number.isSafeInteger(position) || position < 0 || position % streamPageFrames || frames <= 0 ||
        data.length !== this.asset.channels || data.some((channel) => !(channel instanceof Float32Array) ||
          channel.length !== frames || channel.byteLength !== channel.buffer.byteLength))
      throw new Error('Invalid PCM stream page')
    for (const channel of data)
      for (const value of channel) if (!Number.isFinite(value)) throw new Error('Non-finite streamed PCM')
    this.pages.delete(position)
    this.pages.set(position, data)
    while (this.pages.size > streamPagesPerVoice) this.pages.delete(this.pages.keys().next().value!)
  }
  accept(request: PcmReadRequest, data?: Float32Array[], error?: string): void {
    const pending = this.pending.get(request.position)
    if (request.id !== this.id || request.streamId !== this.asset.streamId ||
        !pending || pending.serial !== request.serial || pending.frames !== request.frames) return
    this.pending.delete(request.position)
    if (error !== undefined) { this.failure = new Error(error); return }
    try {
      if (!data) throw new Error('PCM stream reply has no samples')
      this.store(request.position, data)
    } catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)) }
  }
  /** Count the union of pages needed by one atomic output step. Overlapping
   * ranges share pages; separate steps can reuse the same bounded cache. */
  beginPreflight(): void {
    if (this.preflightPages) throw new Error('PCM stream preflight is already active')
    this.preflightPages = new Set()
  }
  endPreflight(): void { this.preflightPages = undefined }
  ready(position: number, frames: number): boolean {
    if (this.failure) throw this.failure
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(frames) || frames < 0)
      throw new Error('Invalid PCM stream read extent')
    const start = Math.max(0, position), end = Math.min(this.asset.sampleCount, position + frames)
    if (end <= start) return true
    if (end - start > streamPageFrames * (streamPagesPerVoice - 1))
      throw new Error('PCM stream read exceeds the page working set')
    let available = true
    for (let page = Math.floor(start / streamPageFrames) * streamPageFrames; page < end; page += streamPageFrames) {
      if (this.preflightPages) {
        this.preflightPages.add(page)
        if (this.preflightPages.size > streamPagesPerVoice)
          throw new Error('PCM stream output-step page budget exceeds 16 distinct pages')
      }
      const data = this.pages.get(page)
      if (data) {
        this.pages.delete(page)
        this.pages.set(page, data)
      } else {
        available = false
        if (!this.pending.has(page) && this.pending.size < streamRequestsPerVoice) {
          const request = { id: this.id, streamId: this.asset.streamId, serial: this.serial++,
            position: page, frames: Math.min(streamPageFrames, this.asset.sampleCount - page) }
          this.pending.set(page, request)
          this.requests.push(request)
        }
      }
    }
    return available
  }
  sample(channel: number, position: number): number {
    if (position < 0 || position >= this.asset.sampleCount) return 0
    const index = Math.floor(position), next = Math.min(index + 1, this.asset.sampleCount - 1), fraction = position - index
    const at = (frame: number) => {
      const page = Math.floor(frame / streamPageFrames) * streamPageFrames, data = this.pages.get(page)?.[channel]
      if (!data) throw new Error('Streamed PCM was sampled without reserving its pages')
      return data[frame - page]!
    }
    const first = at(index)
    return fraction ? first * (1 - fraction) + at(next) * fraction : first
  }
  takeRequests(): PcmReadRequest[] { return this.requests.splice(0) }
  prefetch(position: number): void {
    const first = Math.floor(Math.max(0, position) / streamPageFrames) * streamPageFrames
    this.ready(first, streamPageFrames * 3)
  }
  inspect(): { pages: number; pending: number; bytes: number } {
    return { pages: this.pages.size, pending: this.pending.size,
      bytes: [...this.pages.values()].reduce((sum, data) => sum + data.reduce((bytes, channel) => bytes + channel.byteLength, 0), 0) }
  }
}
