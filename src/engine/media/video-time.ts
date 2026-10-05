import type { VideoTimeline } from '../ports/video.ts'
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
