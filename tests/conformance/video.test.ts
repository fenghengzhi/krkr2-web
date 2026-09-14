import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readVideoTimeline } from '../../src/formats/video/mp4.ts'
import { videoFrameAt, videoFrameTime } from '../../src/engine/media/video-time.ts'
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
