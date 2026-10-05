import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readVideoTimeline } from '../../src/formats/video/mp4.ts'
import { videoFrameAt, videoFrameTime, videoPresentedFrameAt, videoReportedFrameAt } from '../../src/engine/media/video-time.ts'
test('MP4 B-frames and edit lists resolve to presentation-order frame times', async () => {
  const source = readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)),
    wrapped = new Uint8Array(source.length + 21)
  wrapped.set(source, 13)
  const timeline = await readVideoTimeline(wrapped.subarray(13, 13 + source.length))
  assert.ok(timeline)
  assert.equal(timeline.duration, 1500)
  assert.equal(timeline.audioStreams, 0)
  assert.equal(timeline.videoStreams, 1)
  assert.equal(timeline.times.length, 18)
  timeline.times.forEach((time, frame) => assert.ok(Math.abs(time - (frame * 1000) / 12) < 1e-9))
  assert.equal(videoFrameAt(timeline, 1000), 12)
  assert.equal(videoFrameAt(timeline, 999), 11)
  assert.ok(Math.abs(videoFrameTime(timeline, 6) - 500) < 1e-9)
  assert.throws(() => videoFrameTime(timeline, 18), /outside/)
  await assert.rejects(readVideoTimeline(source.subarray(0, source.length - 1)), /Truncated/)
})

test('reported seek intervals are distinct from exact sample timestamps and do not prove picture identity', async () => {
  const timeline = await readVideoTimeline(readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)))
  assert(timeline)
  // Literal Firefox callback positions in 091's independent numbered frames:
  // both requests actually display frame 15, whose source PTS is 1250 ms.
  assert.equal(videoReportedFrameAt(timeline, 1291.667), 15)
  assert.equal(videoReportedFrameAt(timeline, 1322.687), 15)
  assert.equal(videoPresentedFrameAt(timeline, 1322.687), undefined)
  assert.equal(videoReportedFrameAt(timeline, 833.333), 10)
  assert.equal(videoReportedFrameAt(timeline, 1501), undefined)
  assert.equal(videoReportedFrameAt(timeline, -1), undefined)
  assert.equal(videoReportedFrameAt(timeline, Number.NaN), undefined)
  assert.equal(videoReportedFrameAt({ ...timeline, times: [0, 0] }, 1), undefined)
  assert.equal(videoReportedFrameAt({ ...timeline, times: [] }, 0), undefined)
})

test('presented MP4 timestamps match microsecond-quantized PTS without changing playback floor semantics', async () => {
  const timeline = await readVideoTimeline(readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)))
  assert(timeline)
  // Literal 0.833333 seconds from 087 Chromium's paused candidate in the
  // original failed trace. Its frame was presented; no later callback arrived.
  assert.equal(videoPresentedFrameAt(timeline, 833.333), 10)
  assert.equal(videoPresentedFrameAt(timeline, 833.334), 10)
  assert.equal(videoFrameAt(timeline, 833.333), 9)
  assert.equal(videoPresentedFrameAt(timeline, 750), 9)
  assert.equal(videoPresentedFrameAt(timeline, 833.335), undefined)
  assert.equal(videoPresentedFrameAt(timeline, 800), undefined)
  assert.equal(videoPresentedFrameAt(timeline, Number.NaN), undefined)
  assert.equal(videoPresentedFrameAt({ ...timeline, times: [] }, 0), undefined)
  assert.equal(videoPresentedFrameAt({ ...timeline, times: [0, 0.0005] }, 0.00025), undefined,
    'A midpoint between very close timestamps cannot identify a unique frame')
  assert.equal(videoPresentedFrameAt({ ...timeline, times: [0, 0.0000005] }, 0), 0,
    'Presentation matching must not inherit the playback lookup epsilon')
  assert.equal(videoPresentedFrameAt({ ...timeline, times: [0, 0] }, 0), undefined,
    'Duplicate PTS values cannot identify a unique frame')
})
