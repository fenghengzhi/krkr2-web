import type { VideoMode, VideoTimeline } from '../ports/video.ts'

/** DirectShow's MEDIA_TIME public properties use the average frame period,
 * not the index of the sample currently visible. Keep these clock conversions
 * separate from PTS lookup and full-image identity checks below. */
export function videoClockFrameAt(timeline: VideoTimeline | undefined, time: number): number {
  if (!timeline || !Number.isFinite(timeline.frameDuration) || timeline.frameDuration <= 0) return -1
  return Math.max(0, Math.trunc(time / timeline.frameDuration + 0.5))
}
export function videoClockSnapshot(timeline: VideoTimeline | undefined, time: number, duration: number) {
  const frame = videoClockFrameAt(timeline, time), numberOfFrame = videoClockFrameAt(timeline, duration)
  return {
    position: Math.max(0, Math.trunc(time + 0.5)),
    frame,
    fps: frame < 0 ? 0 : 1000 / timeline!.frameDuration,
    numberOfFrame: Math.max(0, numberOfFrame),
    totalTime: Math.max(0, Math.trunc(duration)),
  }
}
export function videoClockFrameTime(timeline: VideoTimeline | undefined, frame: number, duration: number): number {
  if (!timeline || videoClockFrameAt(timeline, duration) < 0)
    throw new Error('This video container has no supported frame clock')
  if (!Number.isInteger(frame) || frame < 0 || frame >= videoClockFrameAt(timeline, duration))
    throw new Error('Video frame is outside the stream')
  // Native SetFrame converts AvgTimePerFrame * frame to integral 100 ns units.
  return Math.trunc((timeline.frameDuration / 1000) * 10000000 * frame) / 10000
}

/** VideoOvlImpl's EC_UPDATE consumer preserves the layer renderer's frame
 * within one frame of GetFrame(), correcting larger differences. Mixer mode
 * always uses GetFrame(). The producer supplies rendererFrame separately:
 * BufferRenderer's media sample value is not a presentation-order index. */
export function videoClockFrameUpdate(mode: VideoMode, clockFrame: number, rendererFrame?: number): number {
  if (mode !== 1 || rendererFrame === undefined || !Number.isSafeInteger(rendererFrame)) return clockFrame
  return clockFrame + 1 < rendererFrame || clockFrame - 1 > rendererFrame ? clockFrame : rendererFrame
}

export function videoFrameAt(timeline: VideoTimeline, time: number): number {
  let low = 0,
    high = timeline.times.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (timeline.times[mid]! <= time + 1e-6) low = mid + 1
    else high = mid
  }
  return Math.max(0, low - 1)
}
export function videoFrameTime(timeline: VideoTimeline | undefined, frame: number): number {
  if (!timeline?.times.length) throw new Error('This video container has no supported frame index')
  if (!Number.isInteger(frame) || frame < 0 || frame >= timeline.times.length)
    throw new Error('Video frame is outside the stream')
  return timeline.times[frame]!
}

/** Match a presented PTS, not an arbitrary playback position. Browsers expose
 * decoded timestamps at microsecond precision (e.g. 0.833333 seconds for a
 * 12 fps frame at 5/6 seconds). A floor lookup can misidentify that frame and
 * wait for another callback an already paused video will never produce. */
export function videoPresentedFrameAt(timeline: VideoTimeline, time: number): number | undefined {
  if (!Number.isFinite(time) || !timeline.times.length) return
  let low = 0, high = timeline.times.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (timeline.times[mid]! < time) low = mid + 1
    else high = mid
  }
  let frame = Math.min(low, timeline.times.length - 1), distance = Math.abs(timeline.times[frame]! - time)
  if (low > 0 && low < timeline.times.length) {
    const previousDistance = Math.abs(timeline.times[low - 1]! - time)
    if (previousDistance === distance) return // No unique nearest presentation.
    if (previousDistance < distance) { frame = low - 1; distance = previousDistance }
  }
  if (timeline.times[frame - 1] === timeline.times[frame] ||
      timeline.times[frame + 1] === timeline.times[frame]) return
  return distance <= 0.001 ? frame : undefined
}

/** Some browser seek callbacks report the requested point inside a sample,
 * rather than that sample's exact PTS. This identifies a reported interval,
 * not proof of decoded image identity. Track replacement additionally compares
 * the complete paused images at the same media-clock position. */
export function videoReportedFrameAt(timeline: VideoTimeline, time: number): number | undefined {
  if (!Number.isFinite(time) || !timeline.times.length) return
  const exact = videoPresentedFrameAt(timeline, time)
  if (exact !== undefined) return exact
  const frame = videoFrameAt(timeline, time), start = timeline.times[frame]!,
    end = timeline.times[frame + 1] ?? timeline.duration
  if (timeline.times[frame - 1] === start || timeline.times[frame + 1] === start) return
  if (time > start && time < end) return frame
}
