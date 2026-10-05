import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readVideoTimeline } from '../../src/formats/video/mp4.ts'
import { videoFrameAt, videoFrameTime, videoPresentedFrameAt, videoReportedFrameAt,
  videoClockFrameAt, videoClockFrameTime, videoClockSnapshot } from '../../src/engine/media/video-time.ts'
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
  assert.equal(timeline.frameDuration, 1000 / 12)
  timeline.times.forEach((time, frame) => assert.ok(Math.abs(time - (frame * 1000) / 12) < 1e-9))
  assert.equal(videoFrameAt(timeline, 1000), 12)
  assert.equal(videoFrameAt(timeline, 999), 11)
  assert.ok(Math.abs(videoFrameTime(timeline, 6) - 500) < 1e-9)
  assert.throws(() => videoFrameTime(timeline, 18), /outside/)
  await assert.rejects(readVideoTimeline(source.subarray(0, source.length - 1)), /Truncated/)
})

test('public media time rounds position and frame independently while total time truncates', () => {
  const timeline = { times: [0, 40, 80, 120], frameDuration: 40, duration: 160.75, audioStreams: 0, videoStreams: 1 }
  assert.deepEqual(videoClockSnapshot(timeline, 59.6, 160.75),
    { position: 60, frame: 1, fps: 25, numberOfFrame: 4, totalTime: 160 })
  assert.equal(videoClockFrameAt(timeline, 60), 2, 'Native frame half-ties round upward')
  assert.equal(videoClockFrameAt(timeline, 59.999), 1)
  assert.equal(videoClockSnapshot(timeline, 0.5, 160.75).position, 1)
  assert.equal(videoClockSnapshot(timeline, 0.499, 160.75).position, 0)
  assert.equal(videoClockFrameAt(timeline, 160.75), 4, 'EOF reports duration/cadence, not the last image index')
  assert.equal(videoFrameAt(timeline, 160.75), 3)
})

test('public frame clock ignores CTS origin and uneven sample intervals', () => {
  const delayed = { times: [80, 120, 160], frameDuration: 40, duration: 200, audioStreams: 0, videoStreams: 1 },
    variable = { ...delayed, times: [0, 20, 100], duration: 120 }
  assert.deepEqual(videoClockSnapshot(delayed, 120, 200),
    { position: 120, frame: 3, fps: 25, numberOfFrame: 5, totalTime: 200 })
  assert.equal(videoFrameAt(delayed, 120), 1, 'Picture index remains independent of the public clock')
  assert.equal(videoClockFrameTime(delayed, 1, 200), 40)
  assert.equal(videoClockFrameAt(variable, 70), 2)
  assert.equal(videoFrameAt(variable, 70), 1)
  assert.equal(videoClockFrameTime(variable, 1, 120), 40)
  assert.throws(() => videoClockFrameTime(variable, 3, 120), /outside/)
  assert.throws(() => videoClockFrameTime(undefined, 1, 120), /frame clock/)
})

test('public frame seeking uses the native 100 ns clock without widening exact PTS identity', () => {
  const timeline = { times: [0, 1000 / 12, 2000 / 12], frameDuration: 1000 / 12,
    duration: 250, audioStreams: 0, videoStreams: 1 }
  assert.equal(videoClockFrameTime(timeline, 1, 250), 83.3333)
  assert.equal(videoClockFrameAt(timeline, 83.333), 1)
  assert.equal(videoPresentedFrameAt(timeline, 83.3333), 1)
  assert.equal(videoPresentedFrameAt(timeline, 82), undefined)
  assert.equal(videoClockFrameAt(timeline, 82), 1)
  assert.deepEqual(videoClockSnapshot(undefined, 12.7, 400.9),
    { position: 13, frame: -1, fps: 0, numberOfFrame: 0, totalTime: 400 })
})

test('real regular and fragmented 12 fps files retain cadence independently of presentation offsets', async () => {
  for (const name of ['numbered-multitrack', 'numbered-fragmented', 'numbered-interleaved', 'numbered-separate-fragments']) {
    const timeline = await readVideoTimeline(readFileSync(resolve(`out/verification/video-tracks/${name}.mp4`)))
    assert(timeline)
    assert.equal(timeline.frameDuration, 1000 / 12, name)
    assert.equal(timeline.times.length, 72, name)
    assert.equal(videoClockSnapshot(timeline, 2000, timeline.duration).frame, 24, name)
    assert.equal(videoClockSnapshot(timeline, 2000, timeline.duration).fps, 12, name)
    if (name !== 'numbered-multitrack') {
      assert(timeline.times[0]! > 0, name)
      assert(timeline.duration > 6000, name)
      assert.notEqual(videoClockSnapshot(timeline, 2000, timeline.duration).frame, videoFrameAt(timeline, 2000), name)
    }
  }
})

test('a real VFR stream separates codec nominal frame requests from CTS, with an explicit container-clock fallback', async () => {
  const source = readFileSync(resolve('out/verification/video-tracks/numbered-variable.mp4')),
    timeline = await readVideoTimeline(source)
  assert(timeline)
  assert.equal(timeline.times.length, 72)
  // The archived independent FFprobe reports r_frame_rate=12/1 while its
  // avg_frame_rate=864/107. VUI supplies the former; it does not rewrite CTS.
  assert.equal(timeline.frameDuration, 1000 / 12)
  assert(Math.abs(timeline.times[1]! - 1000 / 12) < 1e-9)
  assert.equal(timeline.times[2], 250)
  const request = videoClockFrameTime(timeline, 2, timeline.duration)
  assert(request > timeline.times[1]! && request < timeline.times[2]!)
  assert.equal(videoClockFrameAt(timeline, request), 2)
  assert.equal(videoReportedFrameAt(timeline, request), 1)
  assert.equal(videoPresentedFrameAt(timeline, request), undefined,
    'A nominal public frame is not necessarily a presentation timestamp')

  // Declare the same samples as in-band avc3: a static avcC SPS can no longer
  // prove their clock. This controlled metadata variant keeps the real uneven
  // CTS and the previous literal average-clock fallback assertions intact.
  const inBand = Buffer.from(source), avcC = inBand.indexOf('avcC'), avc1 = inBand.lastIndexOf('avc1', avcC)
  assert(avc1 >= 4 && avcC > avc1)
  assert(inBand.readUInt32BE(avc1 - 4) > avcC - avc1)
  inBand.write('avc3', avc1, 'ascii')
  const fallback = await readVideoTimeline(inBand)
  assert(fallback); assert.deepEqual(fallback.times, timeline.times)
  assert(Math.abs(fallback.frameDuration - 107000 / 864) < 1e-9)
  const averageRequest = videoClockFrameTime(fallback, 1, fallback.duration)
  assert(averageRequest > fallback.times[1]! && averageRequest < fallback.times[2]!)
  assert.equal(videoClockFrameAt(fallback, averageRequest), 1)
  assert.equal(videoReportedFrameAt(fallback, averageRequest), 1)
  assert.equal(videoPresentedFrameAt(fallback, averageRequest), undefined)
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
