import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForClockPresentation } from '../../src/backends/video/browser/clock-seek.ts'

/** Controlled media/callback boundaries; real decoding and complete RGBA
 * handoffs remain in the three-browser video-audio-tracks/handoff suites. */
function fixture(aborted = false) {
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
  const pending = waitForClockPresentation(state as HTMLVideoElement, 500, 7, abort.signal,
    () => { if (!current) throw new Error('Graph or operation was superseded') },
    () => { order.push('seek'); state.currentTime = 0.5; return pendingSeek },
    (expired) => { expire = expired; return () => { timerCleared = true } },
    (metadata) => observed.push(metadata.mediaTime))
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
  assert.deepEqual(f.order, ['seek', 'request'])
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
  assert.deepEqual(f.order, ['seek', 'request', 'request', 'request'])
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
