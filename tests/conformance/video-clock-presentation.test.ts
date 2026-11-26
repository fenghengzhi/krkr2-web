import test from 'node:test'
import assert from 'node:assert/strict'
import { hasClockAlignedPresentation, VideoSampleHistory, videoSeekTime, waitForClockPresentation,
  type ClockPresentationSource, type ClockPresentationTarget } from '../../src/backends/video/browser/clock-seek.ts'
import type { VideoTimeline } from '../../src/engine/ports/video.ts'
import { videoFrameAt, videoPresentedFrameAt, videoReportedFrameAt } from '../../src/engine/media/video-time.ts'

function seekable(ranges: readonly (readonly [number, number])[]) {
  return { seekable: { length: ranges.length,
    start: (index: number) => ranges[index]![0], end: (index: number) => ranges[index]![1] } }
}

test('finite video seeks preserve the media origin and clamp only before the actual seekable start', () => {
  // 170 Firefox fragmented/interleaved: first PTS 1/6 s; seek(0) produced
  // another real presentation at that same clock, never a zero-clock seeked.
  const offset = seekable([[1 / 6, 37 / 6]]), ordinary = seekable([[0, 6]])
  for (const time of [0, 0.05, 1 / 6]) assert.equal(videoSeekTime(offset, time), 1 / 6)
  for (const time of [0.25, 2, 6]) assert.equal(videoSeekTime(offset, time), time)
  assert.equal(videoSeekTime(ordinary, 0), 0, 'A browser which can address the initial edit keeps zero')
  assert.equal(videoSeekTime(seekable([]), 0), 0, 'No guessed origin without an available range')
  assert.equal(videoSeekTime(seekable([[0, 1], [3, 6]]), 2), 2, 'No permissive interior-gap fallback')
  assert.equal(videoSeekTime(offset, -1), -1, 'Invalid public requests still reach normal validation')
  assert.equal(videoSeekTime(offset, 7), 7, 'No permissive end-of-stream fallback')
  assert.equal(videoSeekTime(seekable([[Number.NaN, 6]]), 0), 0)
})

/** Controlled media/callback boundaries; real decoding and complete RGBA
 * handoffs remain in the three-browser video-audio-tracks/handoff suites. */
function fixture(aborted = false, source?: ClockPresentationSource,
  target?: ClockPresentationTarget, position = 500) {
  const abort = new AbortController(), callbacks = new Map<number, VideoFrameRequestCallback>(),
    cancelled: number[] = [], observed: number[] = [], order: string[] = []
  let id = 0, resolveSeek!: () => void, expire!: () => void, timerCleared = false,
    current = true, outcome = 'pending'
  const pendingSeek = new Promise<void>((resolve) => { resolveSeek = resolve }),
    state = {
      currentTime: 0, readyState: 1, seeking: true,
      requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
        order.push('request'); callbacks.set(++id, callback); return id
      },
      cancelVideoFrameCallback(handle: number) { cancelled.push(handle); callbacks.delete(handle) },
    }
  if (aborted) abort.abort()
  const pending = waitForClockPresentation(state as HTMLVideoElement, position, 7, abort.signal,
    () => { if (!current) throw new Error('Graph or operation was superseded') },
    () => { order.push('seek'); state.currentTime = position / 1000; return pendingSeek },
    (expired) => { expire = expired; return () => { timerCleared = true } },
    (metadata) => observed.push(metadata.mediaTime), source, target)
  void pending.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
  const metadata = (change: Partial<VideoFrameCallbackMetadata> = {}): VideoFrameCallbackMetadata => ({
    presentationTime: performance.now(), expectedDisplayTime: performance.now(),
    mediaTime: 0.666667, presentedFrames: 8, width: 64, height: 48, ...change,
  }), take = () => {
    const entry = callbacks.entries().next().value
    assert(entry, 'A pending callback must exist')
    callbacks.delete(entry[0])
    return entry[1]
  }
  return { state, pending, abort, observed, order, cancelled, callbacks, metadata, take,
    fire(change?: Partial<VideoFrameCallbackMetadata>) { take()(performance.now(), metadata(change)) },
    seeked() { state.seeking = false; state.readyState = 4; resolveSeek() },
    resolveSeek() { resolveSeek() }, retire() { current = false }, expire() { expire() },
    get outcome() { return outcome }, get timerCleared() { return timerCleared },
  }
}

test('clock frame seek accepts a fresh 0.666667 PTS at the exact 0.5 media clock only after seek completion', async () => {
  const f = fixture()
  assert.deepEqual(f.order, ['request', 'seek'])
  f.fire()
  await Promise.resolve()
  assert.equal(f.outcome, 'pending', 'Presentation alone cannot stand in for seeked')
  f.seeked()
  await f.pending
  assert.deepEqual(f.observed, [0.666667])
  assert.equal(f.state.currentTime, 0.5)
  assert.equal(f.timerCleared, true)
  assert.equal(f.callbacks.size, 0)
})

test('an earliest-position seek still requires a newly submitted first sample and the actual clamped clock', async () => {
  const timeline: VideoTimeline = { times: [1000 / 6, 250, 1000 / 3], duration: 1000,
    frameDuration: 1000 / 12, videoStreams: 1, audioStreams: 2 },
    position = videoSeekTime(seekable([[1 / 6, 1]]), 0) * 1000,
    target: ClockPresentationTarget = {
      contains: (time) => videoReportedFrameAt(timeline, time) === 0,
      exact: (time) => videoPresentedFrameAt(timeline, time) === 0,
    }, f = fixture(false, undefined, target, position)
  try {
    f.seeked()
    f.fire({ mediaTime: 0.166667, presentedFrames: 7 })
    f.fire({ mediaTime: 0.25, presentedFrames: 8 })
    await Promise.resolve()
    assert.equal(f.outcome, 'pending', 'Neither an old counter nor the next sample proves the requested first frame')
    f.fire({ mediaTime: 0.166667, presentedFrames: 8 })
    await f.pending
    assert.deepEqual(f.observed, [0.166667])
    assert.equal(f.state.currentTime, 1 / 6)
    assert.equal(f.callbacks.size, 0); assert.equal(f.timerCleared, true)
  } finally { f.abort.abort(); await f.pending.catch(() => {}) }
})

test('a normal time seek accepts Firefox\'s fresh clock inside the selected sample, never an adjacent sample', async () => {
  // Frozen ffprobe packet integers from video-interleaved.mp4, time_base 1/12288.
  // The real Firefox callback reports 1.0, between PTS 11527 and 12551.
  const timeline: VideoTimeline = { times: [0, 10503, 11527, 12551, 13575].map((pts) => pts * 1000 / 12288),
    duration: 73991 * 1000 / 12288, frameDuration: 1000 / 12, videoStreams: 1, audioStreams: 1 },
    index = videoFrameAt(timeline, 1000),
    target: ClockPresentationTarget = {
      contains: (time) => videoReportedFrameAt(timeline, time) === index,
      exact: (time) => videoPresentedFrameAt(timeline, time) === index,
    },
    f = fixture(false, undefined, target, 1000)
  try {
    f.seeked()
    f.fire({ mediaTime: 1.021403 })
    f.fire({ mediaTime: 0.854736 })
    await Promise.resolve()
    assert.equal(f.outcome, 'pending', 'A fresh adjacent sample must not satisfy the selected interval')
    assert.deepEqual(f.observed, [])
    f.fire({ mediaTime: 1, presentedFrames: 7 })
    f.fire({ mediaTime: 1, presentationTime: -1 })
    await Promise.resolve()
    assert.equal(f.outcome, 'pending', 'A matching interval must still be a new presentation')
    f.fire({ mediaTime: 1, presentedFrames: 8 })
    await f.pending
    assert.deepEqual(f.observed, [1])
    assert.equal(f.state.currentTime, 1)
    assert.equal(f.callbacks.size, 0)
    assert.equal(f.timerCleared, true)
  } finally { f.abort.abort(); await f.pending.catch(() => {}) }
  const repeat = fixture(false, { timeline, previousTime: timeline.times[index]!, seenSamples: new Set([index]) }, target, 1000)
  try {
    repeat.seeked()
    repeat.fire({ mediaTime: 1, presentationTime: -1 })
    await Promise.resolve()
    assert.equal(repeat.outcome, 'pending', 'A repeated interval-only clock still needs a new timestamp')
    repeat.fire({ mediaTime: 11527 / 12288, presentationTime: -1 })
    await repeat.pending
    assert.deepEqual(repeat.observed, [11527 / 12288], 'An exact target sample preserves the original normal-seek contract')
    assert.equal(repeat.state.currentTime, 1)
  } finally { repeat.abort.abort(); await repeat.pending.catch(() => {}) }
})

function sourceClock(times = [0, 250, 1000], duration = 1250): ClockPresentationSource {
  const timeline: VideoTimeline = { times, duration, frameDuration: 250, videoStreams: 1, audioStreams: 2 }
  return { timeline, previousTime: 0, seenSamples: new Set([0]) }
}
function sample(mediaTime: number, presentationTime: number): VideoFrameCallbackMetadata {
  return { mediaTime, presentationTime, expectedDisplayTime: presentationTime,
    presentedFrames: 8, width: 64, height: 48 }
}

test('per-decoder sample history retains every bit beyond 4096 and releases independently at graph retirement', () => {
  const oldGraph = new VideoSampleHistory(8195), nextGraph = new VideoSampleHistory(17),
    largestGraph = new VideoSampleHistory(1000000)
  assert.equal(oldGraph.allocatedBytes, 0, 'History allocates only for an observed PTS')
  for (let frame = 0; frame <= 8192; frame++) oldGraph.record(frame)
  oldGraph.record(8194)
  assert.equal(oldGraph.allocatedBytes, 1025)
  assert.equal(oldGraph.available, true)
  for (const frame of [0, 7, 8, 4095, 4096, 4097, 8192, 8194]) assert.equal(oldGraph.has(frame), true)
  assert.equal(oldGraph.has(8193), false)
  const source = { ...sourceClock(Array.from({ length: 8195 }, (_, frame) => frame * 1000), 8195000),
    previousTime: 8192000, seenSamples: oldGraph }
  assert.equal(hasClockAlignedPresentation(source, 8193500, 8193.5, sample(8193, 600), 1000, 1200), true,
    'A new sample after long playback still has the extra proof')
  assert.equal(hasClockAlignedPresentation(source, 4096500, 4096.5, sample(4096, 600), 1000, 1200), false,
    'Long playback does not forget a previously observed sample')
  largestGraph.record(0); largestGraph.record(999999)
  assert.equal(largestGraph.allocatedBytes, 125000)
  assert.equal(largestGraph.has(0), true); assert.equal(largestGraph.has(999999), true)
  assert.equal(largestGraph.has(999998), false)
  largestGraph.dispose()
  assert.equal(largestGraph.allocatedBytes, 0)
  assert.equal(nextGraph.has(0), false, 'A replacement decoder does not inherit an old graph\'s proof')
  nextGraph.record(0); nextGraph.record(16)
  assert.equal(nextGraph.allocatedBytes, 3, 'The final partial byte belongs to this track only')
  oldGraph.dispose(); oldGraph.dispose(); oldGraph.record(8193)
  assert.equal(oldGraph.allocatedBytes, 0)
  assert.equal(oldGraph.available, false)
  assert.equal(oldGraph.has(8193), true, 'A retained reference to retired history cannot admit a new sample')
  assert.equal(nextGraph.available, true); assert.equal(nextGraph.has(16), true)
  nextGraph.record(undefined)
  assert.equal(nextGraph.allocatedBytes, 0); assert.equal(nextGraph.available, false)
  nextGraph.record(1)
  assert.equal(nextGraph.has(1), true, 'An unknown PTS cannot be erased by a later known report')
  for (const size of [0, -1, 1000001, Number.NaN]) {
    const unavailable = new VideoSampleHistory(size)
    unavailable.record(0)
    assert.equal(unavailable.available, false); assert.equal(unavailable.allocatedBytes, 0)
  }
})

test('clock-aligned proof preserves the archived WebKit seek clock and earlier raw presentation timestamp', () => {
  // 127 WebKit journal: seek starts at 8233 ms; a new counter reports picture
  // PTS .75 s with presentationTime 8166 ms at callback receipt 8274 ms.
  // DirectShow-style integral 100 ns frame 10 is 833.3333 ms, just before the
  // next exact 12 fps sample 2500/3 ms. Do not round it onto that next sample.
  const source = sourceClock([0, 750, 2500 / 3, 1000]), metadata = sample(0.75, 8166)
  assert.equal(hasClockAlignedPresentation(source, 833.3333, 0.8333333, metadata, 8233, 8274), true)
  assert.equal(metadata.presentationTime, 8166, 'Raw browser evidence is never rewritten')
  assert.equal(metadata.mediaTime, 0.75)
  assert.equal(hasClockAlignedPresentation(source, 2500 / 3, 5 / 6, metadata, 8233, 8274), false,
    'The old sample cannot prove the exact next-sample boundary')
})

test('clock-aligned proof uses half-open actual sample intervals including the final sample', () => {
  const source = sourceClock(), first = sample(0.25, 8000), final = sample(1, 8000)
  assert.equal(hasClockAlignedPresentation(source, 250, 0.25, first, 8000, 9000), true)
  assert.equal(hasClockAlignedPresentation(source, 249.999, 0.249999, first, 8000, 9000), false)
  assert.equal(hasClockAlignedPresentation(source, 999.999, 0.999999, first, 8000, 9000), true)
  assert.equal(hasClockAlignedPresentation(source, 1000, 1, first, 8000, 9000), false)
  assert.equal(hasClockAlignedPresentation(source, 1000, 1, final, 8000, 9000), true)
  assert.equal(hasClockAlignedPresentation(source, 1249.999, 1.249999, final, 8000, 9000), true)
  assert.equal(hasClockAlignedPresentation(source, 1250, 1.25, final, 8000, 9000), false)
  assert.equal(hasClockAlignedPresentation(sourceClock([0, 250, 1000], 1000), 1000, 1,
    final, 8000, 9000), false, 'An empty final interval is not an image proof')
})

test('clock-aligned proof requires a new unique source PTS and a known previous presentation', () => {
  const source = sourceClock(), metadata = sample(0.25, 8000)
  const proves = (candidate: ClockPresentationSource, frame = metadata) =>
    hasClockAlignedPresentation(candidate, 500, 0.5, frame, 8200, 8300)
  assert.equal(proves(source), true)
  assert.equal(proves({ ...source, previousTime: 250 }), false)
  assert.equal(proves({ ...source, previousTime: 125 }), false)
  assert.equal(proves({ ...source, seenSamples: new Set([0, 1]) }), false)
  assert.equal(proves(sourceClock([0, 250, 250, 1000])), false, 'Duplicate PTS is ambiguous')
  assert.equal(proves(source, sample(0.5, 8000)), false, 'A requested clock is not an exact source PTS')
  assert.equal(proves(source, sample(Number.NaN, 8000)), false)
})

test('clock-aligned proof retains the one-microsecond clock gate and both acquisition-time bounds', () => {
  const source = sourceClock(), metadata = sample(0.25, 8000)
  assert.equal(hasClockAlignedPresentation(source, 500, 0.5000009, metadata, 8200, 8300), true)
  assert.equal(hasClockAlignedPresentation(source, 500, 0.5000011, metadata, 8200, 8300), false)
  assert.equal(hasClockAlignedPresentation(source, 500, 0.5, metadata, 8250, 8250), true)
  assert.equal(hasClockAlignedPresentation(source, 500, 0.5, metadata, 8250.001, 8300), false)
  assert.equal(hasClockAlignedPresentation(source, 500, 0.5, metadata, 8200, 8249.999), false)
  for (const presentationTime of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.equal(hasClockAlignedPresentation(source, 500, 0.5, sample(0.25, presentationTime), 0, 9000), false)
  assert.equal(hasClockAlignedPresentation(source, Number.NaN, 0.5, metadata, 8200, 8300), false)
  assert.equal(hasClockAlignedPresentation(source, 500, Number.NaN, metadata, 8200, 8300), false)
  assert.equal(hasClockAlignedPresentation(source, 500, 0.5, metadata, Number.NaN, 8300), false)
  assert.equal(hasClockAlignedPresentation(source, 500, 0.5, metadata, 8200, Number.NaN), false)
})

test('the asynchronous clock gate accepts a new clock-aligned frame only after the real seek completes', async (t) => {
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  const f = fixture(false, sourceClock())
  try {
    now = 1100
    f.fire({ mediaTime: 0.25, presentationTime: 850 })
    await Promise.resolve()
    assert.equal(f.outcome, 'pending')
    assert.deepEqual(f.observed, [0.25])
    f.seeked(); await f.pending
    assert.equal(f.state.currentTime, 0.5)
    assert.equal(f.timerCleared, true)
    assert.equal(f.callbacks.size, 0)
  } finally { f.abort.abort(); await f.pending.catch(() => {}) }
})

test('same-sample and previously seen PTS still need the original fresh-presentation proof', async (t) => {
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  for (const source of [{ ...sourceClock(), previousTime: 250 },
    { ...sourceClock(), seenSamples: new Set([0, 1]) }]) {
    now = 1000
    const f = fixture(false, source)
    try {
      now = 1100
      f.seeked(); f.fire({ mediaTime: 0.25, presentationTime: 850 })
      await Promise.resolve()
      assert.equal(f.outcome, 'pending'); assert.deepEqual(f.observed, [])
      f.fire({ mediaTime: 0.25, presentationTime: 1100 })
      await f.pending
      assert.deepEqual(f.observed, [0.25])
    } finally { f.abort.abort(); await f.pending.catch(() => {}) }
  }
})

test('clock alignment cannot substitute for a strictly increasing integral compositor counter', async (t) => {
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  const f = fixture(false, sourceClock())
  try {
    now = 1100
    f.seeked()
    for (const presentedFrames of [7, 6, 8.5, Number.NaN])
      f.fire({ mediaTime: 0.25, presentationTime: 850, presentedFrames })
    await Promise.resolve()
    assert.equal(f.outcome, 'pending'); assert.deepEqual(f.observed, [])
    f.fire({ mediaTime: 0.25, presentationTime: 850, presentedFrames: 8 })
    await f.pending
    assert.deepEqual(f.observed, [0.25])
  } finally { f.abort.abort(); await f.pending.catch(() => {}) }
})

test('a clock-aligned frame cannot outlive cancellation or retirement while seek completion is pending', async (t) => {
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  for (const ending of ['abort', 'retire'] as const) {
    now = 1000
    const f = fixture(false, sourceClock())
    try {
      now = 1100
      f.fire({ mediaTime: 0.25, presentationTime: 850 })
      assert.deepEqual(f.observed, [0.25])
      const rejected = assert.rejects(f.pending, ending === 'abort' ? /cancelled/ : /superseded/)
      if (ending === 'abort') f.abort.abort(); else f.retire()
      f.seeked(); await rejected
      assert.equal(f.timerCleared, true); assert.equal(f.callbacks.size, 0)
    } finally { f.abort.abort(); await f.pending.catch(() => {}) }
  }
})

test('a pre-seek submission and a replayed compositor counter cannot release the clock seek gate', async () => {
  const f = fixture()
  f.seeked(); await Promise.resolve()
  f.fire({ presentationTime: -1, presentedFrames: 8 })
  f.fire({ presentedFrames: 7 })
  await Promise.resolve()
  assert.equal(f.outcome, 'pending')
  assert.equal(f.observed.length, 0)
  f.fire()
  await f.pending
  assert.deepEqual(f.observed, [0.666667])
  assert.deepEqual(f.order, ['request', 'seek', 'request', 'request'])
})

for (const invalid of ['still-seeking', 'not-decoded', 'clock-moved'] as const)
  test(`fresh presentation cannot commit a clock seek when ${invalid}`, async () => {
    const f = fixture(), rejected = assert.rejects(f.pending, /requested media clock/)
    f.state.seeking = invalid === 'still-seeking'
    f.state.readyState = invalid === 'not-decoded' ? 1 : 4
    f.state.currentTime = invalid === 'clock-moved' ? 0.500002 : 0.5
    f.resolveSeek(); f.fire()
    await rejected
    assert.equal(f.timerCleared, true)
  })

test('a callback from a superseded graph or operation cannot publish its presentation', async () => {
  const f = fixture(), rejected = assert.rejects(f.pending, /superseded/)
  f.seeked(); f.retire(); f.fire()
  await rejected
  assert.equal(f.observed.length, 0)
  assert.equal(f.timerCleared, true)
})

test('cancelling a clock seek ignores an already queued late callback and removes its deadline', async () => {
  const f = fixture(), late = f.take(), rejected = assert.rejects(f.pending, /cancelled/)
  f.abort.abort()
  late(performance.now(), f.metadata())
  f.seeked()
  await rejected
  assert.equal(f.observed.length, 0)
  assert.equal(f.callbacks.size, 0)
  assert.deepEqual(f.cancelled, [1])
  assert.equal(f.timerCleared, true)
})

test('an already cancelled clock seek starts no decoder or callback work', async () => {
  const f = fixture(true)
  await assert.rejects(f.pending, /cancelled/)
  assert.equal(f.order.length, 0)
  assert.equal(f.callbacks.size, 0)
})

test('the clock seek deadline rejects absent presentation and cancels its pending callback', async () => {
  const f = fixture(), rejected = assert.rejects(f.pending, /presentation timed out/)
  f.seeked(); f.expire()
  await rejected
  assert.deepEqual(f.cancelled, [1])
  assert.equal(f.callbacks.size, 0)
  assert.equal(f.timerCleared, true)
})

test('a paused seek which submits its only fresh frame during the setter cannot lose its callback registration', async () => {
  const abort = new AbortController(), callbacks = new Map<number, VideoFrameRequestCallback>(), observed: number[] = []
  let serial = 0, cleared = false, requestedBeforeSeek = false, sought = false
  const video = { currentTime: 0, readyState: 4, seeking: false,
    requestVideoFrameCallback(callback: VideoFrameRequestCallback) { callbacks.set(++serial, callback); return serial },
    cancelVideoFrameCallback(handle: number) { callbacks.delete(handle) },
  }
  const pending = waitForClockPresentation(video as HTMLVideoElement, 1000, 1, abort.signal, () => {}, () => {
    // Model the compositor thread completing before the JS setter returns.
    // Missing this one notification cannot be repaired by paused playback.
    requestedBeforeSeek = callbacks.size === 1
    video.currentTime = 1
    for (const [handle, callback] of [...callbacks]) {
      callbacks.delete(handle)
      callback(performance.now(), { mediaTime: 1, presentationTime: performance.now(),
        expectedDisplayTime: performance.now(), presentedFrames: 2, width: 80, height: 60 })
    }
    return Promise.resolve().then(() => { sought = true })
  }, () => () => { cleared = true }, (metadata) => observed.push(metadata.mediaTime))
  void pending.catch(() => {})
  try {
    assert.equal(requestedBeforeSeek, true)
    assert.deepEqual(observed, [1])
    assert.equal(sought, false, 'fresh pixels alone still do not complete the seek')
    await pending
    assert.equal(sought, true); assert.equal(cleared, true); assert.equal(callbacks.size, 0)
  } finally { abort.abort(); await pending.catch(() => {}) }
})
