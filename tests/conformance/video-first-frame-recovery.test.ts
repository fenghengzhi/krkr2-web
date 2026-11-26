import test from 'node:test'
import assert from 'node:assert/strict'
import { pauseRecoveredVideo, recoverVideoFirstFrame } from '../../src/backends/video/browser/first-frame-recovery.ts'

function fixture() {
  let expire!: () => void, cancelled = false, allowed = true, starts = 0, plays = 0,
    resolve!: () => void, reject!: (error: unknown) => void
  const errors: unknown[] = [], state = {
    paused: true, muted: false, readyState: 4, frames: 0,
    getVideoPlaybackQuality() { return { totalVideoFrames: this.frames } as VideoPlaybackQuality },
    play() { plays++; state.paused = false; return new Promise<void>((yes, no) => { resolve = yes; reject = no }) },
    pause() { state.paused = true },
  }, recovery = recoverVideoFirstFrame(state, {
    schedule(callback, delay) { assert.equal(delay, 1000); expire = callback; return () => { cancelled = true } },
    allowed: () => allowed,
    started() { starts++ }, failed(error) { errors.push(error) },
  })
  return { state, recovery, errors, expire: () => expire(), allow: (value: boolean) => { allowed = value },
    resolve: () => resolve(), reject: (error: unknown) => reject(error),
    get starts() { return starts }, get plays() { return plays }, get cancelled() { return cancelled } }
}

test('first-frame recovery leaves ordinary preloading, submitted images and inactive candidates alone', () => {
  for (const reason of ['ordinary', 'loading', 'submitted', 'inactive', 'no-quality'] as const) {
    const f = fixture()
    try {
      if (reason === 'loading') f.state.readyState = 2
      if (reason === 'submitted') f.state.frames = 1
      if (reason === 'inactive') f.allow(false)
      if (reason === 'no-quality') Reflect.set(f.state, 'getVideoPlaybackQuality', undefined)
      if (reason !== 'ordinary') f.expire()
      f.recovery.resume()
      assert.equal(f.plays, 0, reason)
      assert.equal(f.state.muted, false)
    } finally { f.recovery.close() }
    f.expire()
    assert.equal(f.plays, 0, 'Retired timers cannot restart a decoder')
    assert.equal(f.cancelled, true)
  }
})

test('a stalled private decoder starts muted once and is paused before its owner restores the real frame and clock', async () => {
  const f = fixture()
  f.expire()
  assert.deepEqual([f.starts, f.plays, f.state.paused, f.state.muted], [1, 1, false, true])
  f.resolve(); await Promise.resolve()
  f.recovery.resume()
  assert.equal(f.plays, 1)
  // play() resolving is deliberately not a frame-completion signal.
  assert.equal(f.cancelled, false)
  f.recovery.close(); f.recovery.close()
  assert.deepEqual([f.state.paused, f.state.muted, f.cancelled, f.errors.length], [true, false, true, 0])
})

test('autoplay denial preserves the original real-frame wait without repeated play or invented completion', async () => {
  const f = fixture()
  f.expire(); f.reject(new DOMException('Playback denied', 'NotAllowedError')); await Promise.resolve()
  assert.equal(f.recovery.denied, 'Playback denied')
  f.recovery.resume(); f.recovery.resume()
  assert.deepEqual([f.plays, f.state.paused, f.state.muted, f.cancelled, f.errors.length], [1, true, false, false, 0])
  f.recovery.close()
})

test('suspended and retired recovery cannot start background playback or resume a replaced decoder', async () => {
  const f = fixture()
  f.recovery.suspend(); f.expire()
  assert.equal(f.plays, 0)
  f.recovery.resume()
  assert.equal(f.plays, 1)
  f.recovery.suspend(); f.recovery.resume()
  f.reject(new DOMException('Paused', 'AbortError')); await Promise.resolve()
  assert.equal(f.plays, 2, 'A resumed private open can finish its interrupted warmup')
  f.recovery.close()
  f.resolve(); await Promise.resolve()
  f.recovery.resume()
  assert.deepEqual([f.plays, f.state.paused, f.state.muted, f.errors.length], [2, true, false, 0])
})

test('warmup restoration waits for the stopped clock event, including synchronous pause and already-paused media', async () => {
  class Video extends EventTarget { paused = false; clock = 0 }
  for (const mode of ['queued', 'synchronous', 'already-paused'] as const) {
    const video = new Video(), controller = new AbortController()
    let scheduled = 0, cancelled = 0, stops = 0, complete = false
    video.paused = mode === 'already-paused'
    const work = pauseRecoveredVideo(video, controller.signal, {
      schedule(_callback, delay) { assert.equal(delay, 15000); scheduled++; return () => { cancelled++ } },
      stop() {
        stops++; video.paused = true
        if (mode === 'synchronous') {
          video.clock = .47592458333315335
          video.dispatchEvent(new Event('pause'))
        }
      },
    }).then(() => { complete = true })
    await Promise.resolve()
    if (mode === 'queued') {
      assert.equal(complete, false, 'paused=true with cached zero is not a stopped clock observation')
      assert.equal(video.clock, 0)
      video.clock = .47592458333315335
      video.dispatchEvent(new Event('pause'))
    }
    await work
    assert.equal(complete, true); assert.equal(stops, 1)
    assert.equal(scheduled, mode === 'already-paused' ? 0 : 1)
    assert.equal(cancelled, scheduled)
    assert.equal(video.clock, mode === 'already-paused' ? 0 : .47592458333315335)
  }
})

test('warmup pause cancellation, missing events and synchronous cleanup errors remain bounded failures', async () => {
  class Video extends EventTarget { paused = false }
  for (const mode of ['cancelled-before', 'cancelled-after', 'no-event', 'stop-error'] as const) {
    const video = new Video(), controller = new AbortController(), original = new Error('Pause cleanup failed')
    let expire!: () => void, cancelled = 0, stops = 0
    if (mode === 'cancelled-before') controller.abort()
    const work = pauseRecoveredVideo(video, controller.signal, {
      schedule(callback, delay) { assert.equal(delay, 15000); expire = callback; return () => { cancelled++ } },
      stop() {
        stops++; video.paused = true
        if (mode === 'stop-error') { video.dispatchEvent(new Event('pause')); throw original }
      },
    })
    if (mode === 'cancelled-after') controller.abort()
    if (mode === 'no-event') expire()
    await assert.rejects(work, (error) => mode === 'stop-error' ? error === original
      : error instanceof Error && error.message === (mode === 'no-event' ? 'Video recovery pause timed out' : 'Video recovery pause cancelled'))
    assert.equal(stops, 1)
    assert.equal(cancelled, mode === 'cancelled-before' ? 0 : 1)
    video.dispatchEvent(new Event('pause'))
  }
})
