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
