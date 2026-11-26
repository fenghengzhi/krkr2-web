import type { VideoTimeline } from '../../../engine/ports/video.ts'
import { videoPresentedFrameAt } from '../../../engine/media/video-time.ts'

export interface ClockPresentationSource {
  timeline: VideoTimeline
  previousTime: number
  seenSamples: Pick<ReadonlySet<number>, 'has'>
}

/** One bit per validated MP4 sample, allocated only after the first observed
 * PTS. The format reader admits at most one million samples per active track.
 * Keep all history, including long playback; never evict an old sample and
 * make it eligible for the additional proof again. */
export class VideoSampleHistory {
  private bits?: Uint8Array
  private complete: boolean
  constructor(private readonly sampleCount: number) {
    this.complete = Number.isSafeInteger(sampleCount) && sampleCount > 0 && sampleCount <= 1000000
  }
  get available(): boolean { return this.complete }
  get allocatedBytes(): number { return this.bits?.byteLength ?? 0 }
  record(frame: number | undefined): void {
    if (!this.complete) return
    if (frame === undefined || !Number.isSafeInteger(frame) || frame < 0 || frame >= this.sampleCount) {
      this.dispose()
      return
    }
    this.bits ??= new Uint8Array(Math.ceil(this.sampleCount / 8))
    const at = frame >>> 3
    this.bits[at] = this.bits[at]! | (1 << (frame & 7))
  }
  has(frame: number): boolean {
    // Incomplete/retired history conservatively refuses every extra proof,
    // including references captured by an operation before its retirement.
    if (!this.complete || !Number.isSafeInteger(frame) || frame < 0 || frame >= this.sampleCount) return true
    return !!(this.bits && (this.bits[frame >>> 3]! & (1 << (frame & 7))))
  }
  dispose(): void { this.complete = false; this.bits = undefined }
}

/** AVFoundation's WebKit metadata uses now-(currentTime-framePTS) for its
 * presentation timestamp. A paused seek inside a sample can therefore report
 * a new buffer with a timestamp before this request. Recover that acquisition
 * time only for a new, uniquely indexed sample containing both frozen clocks.
 * Same-sample, previously observed or unindexed frames keep the original gate.
 * Timeline/position/previousTime are milliseconds; DOM mediaTime is seconds. */
export function hasClockAlignedPresentation(source: ClockPresentationSource, position: number,
  currentSeconds: number, metadata: VideoFrameCallbackMetadata, startedAt: number, receivedAt: number): boolean {
  const { timeline, previousTime, seenSamples } = source,
    frame = videoPresentedFrameAt(timeline, metadata.mediaTime * 1000),
    previous = videoPresentedFrameAt(timeline, previousTime)
  if (frame === undefined || previous === undefined || frame === previous || seenSamples.has(frame) ||
      !Number.isFinite(metadata.presentationTime) || metadata.presentationTime < 0 ||
      !Number.isFinite(currentSeconds) || !Number.isFinite(position) ||
      !Number.isFinite(startedAt) || !Number.isFinite(receivedAt)) return false
  const start = timeline.times[frame]!, end = timeline.times[frame + 1] ?? timeline.duration,
    current = currentSeconds * 1000
  if (!Number.isFinite(end) || end <= start || position < start || position >= end ||
      current < start || current >= end || Math.abs(current - position) > 0.001) return false
  const acquiredAt = metadata.presentationTime + (currentSeconds - metadata.mediaTime) * 1000
  return acquiredAt >= startedAt && acquiredAt <= receivedAt
}

/** A public frame seek sets a media clock. A fresh compositor submission is a
 * separate condition: its mediaTime need not equal that requested clock.
 * Keep this gate distinct from exact-PTS lookup and retained-image comparison. */
export interface ClockPresentationTarget {
  contains(mediaTime: number): boolean
  exact(mediaTime: number): boolean
}

export function waitForClockPresentation(
  video: HTMLVideoElement,
  position: number,
  previousFrames: number,
  signal: AbortSignal,
  current: () => void,
  seek: () => Promise<void>,
  deadline: (expired: () => void) => () => void,
  observe: (metadata: VideoFrameCallbackMetadata) => void,
  source?: ClockPresentationSource,
  target?: ClockPresentationTarget,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    let settled = false, sought = false, presented = false, callback: number | undefined
    let cancelTimeout = () => {}
    const done = (error?: unknown) => {
      if (settled) return
      settled = true
      cancelTimeout()
      if (callback !== undefined) video.cancelVideoFrameCallback(callback)
      signal.removeEventListener('abort', cancel)
      error ? reject(error) : resolve()
    }, complete = () => {
      if (settled || !sought || !presented) return
      try {
        current()
        if (video.seeking || video.readyState < 2 ||
            Math.abs(video.currentTime * 1000 - position) > 0.001)
          throw new Error('Video frame seek changed the requested media clock')
        done()
      } catch (error) { done(error) }
    }, cancel = () => done(new Error('Video operation cancelled')),
      request = () => {
        callback = video.requestVideoFrameCallback((_now, metadata) => {
          callback = undefined
          if (settled) return
          try {
            current()
            // A counter increase remains mandatory for either timestamp
            // proof. No readyState, pixel similarity or seeked-only fallback.
            const mediaTime = metadata.mediaTime * 1000
            // Ordinary position seeks already accepted the selected sample's
            // exact PTS before this shared gate. Preserve that domain when a
            // browser backdates compositor timestamps, including revisiting a
            // seen sample. Interval-only reports still require timestamp proof.
            if ((target && !target.contains(mediaTime)) ||
                !Number.isSafeInteger(metadata.presentedFrames) || metadata.presentedFrames <= previousFrames ||
                ((!Number.isFinite(metadata.presentationTime) || metadata.presentationTime < startedAt) &&
                 !target?.exact(mediaTime) &&
                 !(source && hasClockAlignedPresentation(source, position, video.currentTime,
                   metadata, startedAt, performance.now())))) {
              request()
              return
            }
            observe(metadata)
            presented = true
            complete()
          } catch (error) { done(error) }
        })
      }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) { cancel(); return }
    cancelTimeout = deadline(() => done(new Error('Video frame seek presentation timed out')))
    try {
      current()
      // Arm before assigning currentTime. The media/compositor thread can
      // publish a paused seek's sole frame during that assignment; rVFC is a
      // next-frame notification and does not replay a submission missed before
      // registration. Timestamp/counter checks above still reject old frames.
      request()
      const pending = seek()
      void pending.then(() => { sought = true; complete() }, done)
    } catch (error) { done(error) }
  })
}
