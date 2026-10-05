import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import type { ByteSource, Resource } from '../../src/engine/ports/storage.ts'
import { AudioClock, wave as shortWave } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function observed<T>(signal: AbortSignal, pending: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Timed out waiting for the streaming Session boundary'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    pending.then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** A real PCM RIFF with a sparse payload: allocate only requested ranges. */
function longWave() {
  const dataBytes = 64 * 1024 * 1024 + 16384, size = dataBytes + 44, frames = dataBytes / 2,
    header = new Uint8Array(44), view = new DataView(header.buffer),
    words = [0x2000, 0xc000, 0x6000, 0xe000], reads: Array<{ offset: number; length: number }> = []
  header.set(new TextEncoder().encode('RIFF'), 0)
  view.setUint32(4, size - 8, true)
  header.set(new TextEncoder().encode('WAVEfmt '), 8)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 1000, true)
  view.setUint32(28, 2000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  header.set(new TextEncoder().encode('data'), 36)
  view.setUint32(40, dataBytes, true)
  let completeReads = 0
  const source: ByteSource = { size, async read(offset, length) {
    assert(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset + length <= size)
    assert(length <= 1024 * 1024, 'The streaming path cannot request an unbounded encoded range')
    reads.push({ offset, length })
    const bytes = new Uint8Array(length)
    for (let at = 0; at < length; at++) {
      const absolute = offset + at
      if (absolute < header.length) bytes[at] = header[absolute]!
      else {
        const dataAt = absolute - header.length, word = words[Math.floor(dataAt / 2) % words.length]!
        bytes[at] = (word >>> ((dataAt % 2) * 8)) & 255
      }
    }
    return bytes
  } }
  const resource: Resource = { name: 'long.wav', size, source, async read() {
    completeReads++
    throw new Error('A >64 MiB WAV must use Resource.source, not a complete-file read')
  } }
  return { resource, reads, frames, size, completeReads: () => completeReads,
    bytesRead: () => reads.reduce((sum, read) => sum + read.length, 0) }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: Session starts a >64 MiB sparse WAV, seeks by range, delivers labels and releases streaming audio`, { timeout: 60000 }, async () => {
    const wave = longWave(), far = wave.frames - 4096, clock = new AudioClock(),
      blocks: Array<{ left: Float32Array; right: Float32Array }> = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
        (left, right) => blocks.push({ left: left.slice(), right: right.slice() }), 1000),
      script = String.raw`
var streamLabels=[];
class StreamSound extends WaveSoundBuffer {
  function StreamSound(){super.WaveSoundBuffer(null);}
  function onLabel(name){streamLabels.add(name);}
}
var sound=new StreamSound();sound.open("long.wav");sound.play();
function seekFar(){sound.samplePosition=${far};return sound.samplePosition;}
function halt(){sound.stop();return sound.status+"|"+sound.samplePosition;}
`,
      harness = await headless({
        'startup.tjs': binary
          ? 'Scripts.compileStorage("stream-session.tjs","savedata/stream-session.cjs",false,true,false);Scripts.execStorage("savedata/stream-session.cjs");'
          : 'Scripts.execStorage("stream-session.tjs");',
        'stream-session.tjs': script,
        'long.wav.sli': `#2.00\nLabel {Position=20;Name="early";}\nLabel {Position=${far + 20};Name="late";}\nLabel {Position=${far + 21};Name=":[0]++";}`,
      }, { audio, now: () => clock.now, schedule: clock.schedule }),
      { session } = harness
    session.mount([wave.resource])
    let failed = false, primary: unknown
    const settlePages = async () => {
      const deadline = performance.now() + 10000
      while (audio.mixer.inspectStreams().pending > 0) {
        assert(performance.now() < deadline, 'The requested PCM page must settle')
        assert.notEqual(session.snapshot().state, 'failed', 'A failed Session cannot satisfy a page wait')
        await nextTurn()
      }
      await session.idle()
    }
    try {
      assert(wave.size > 64 * 1024 * 1024)
      assert.equal(audio.streaming, true)
      await session.start()
      await session.idle()
      const compiled = session.exportSaves().find((entry) => entry.path === 'savedata/stream-session.cjs')
      if (binary) {
        assert(compiled)
        assert.equal(new TextDecoder().decode(compiled.bytes.subarray(0, 4)), 'TJS2')
        assert(compiled.bytes.length > 16)
      } else assert.equal(compiled, undefined)
      assert.equal(await session.evaluate('[sound.status,sound.samplePosition,sound.frequency,sound.channels,sound.bits,sound.totalTime].join("|")'),
        `play|0|1000|1|16|${wave.frames}`)
      assert.equal(await session.evaluate('[sound.labels.early.samplePosition,sound.labels.late.samplePosition].join("|")'), `20|${far + 20}`)
      assert.equal(wave.completeReads(), 0)
      assert(wave.bytesRead() > 0 && wave.bytesRead() < 1024 * 1024, 'Playback must start after bounded header/pages, not the full payload')
      assert(wave.reads.every((read) => read.offset + read.length < 44 + far * 2), 'Opening must not prefetch the distant seek target')
      assert.equal(audio.mixer.inspectStreams().voices, 1)
      assert(audio.mixer.inspectStreams().bytes > 0)
      assert(audio.mixer.inspectStreams().bytes <= 1024 * 1024)

      blocks.length = 0
      clock.advance(40)
      await settlePages()
      assert.equal(await session.evaluate('sound.samplePosition'), '40')
      assert.equal(await session.evaluate('streamLabels.join("|")'), 'early')
      const expected = Array.from({ length: 40 }, (_, at) => [0.25, -0.5, 0.75, -0.25][at % 4]!)
      assert.deepEqual(blocks.flatMap((block) => [...block.left]), expected)
      assert.deepEqual(blocks.flatMap((block) => [...block.right]), expected)

      assert.equal(await session.evaluate('seekFar()'), String(far))
      blocks.length = 0
      clock.advance(20)
      await settlePages()
      assert.equal(await session.evaluate('sound.samplePosition'), String(far), 'A missing seek page must not advance source time')
      assert.equal(await session.evaluate('sound.status'), 'play')
      assert.equal(await session.evaluate('streamLabels.join("|")'), 'early')
      assert.equal(blocks.reduce((sum, block) => sum + block.left.length, 0), 20)
      assert(blocks.every((block) => block.left.every((value) => value === 0) && block.right.every((value) => value === 0)))
      assert(wave.reads.some((read) => read.offset >= 44 + far * 2), 'The seek must request the distant source range')

      blocks.length = 0
      clock.advance(40)
      await settlePages()
      assert.equal(await session.evaluate('sound.samplePosition'), String(far + 40))
      assert.equal(await session.evaluate('streamLabels.join("|")'), 'early|late|:[0]++')
      assert.equal(await session.evaluate('sound.flags[0]'), '1')
      assert.deepEqual(blocks.flatMap((block) => [...block.left]), expected)
      assert.deepEqual(blocks.flatMap((block) => [...block.right]), expected)
      assert.equal(wave.completeReads(), 0)
      assert(wave.bytesRead() < 1024 * 1024, 'Seeking across the large gap must not scan intervening PCM')
      assert.equal(await session.evaluate('halt()'), 'stop|0')
      assert.equal(audio.inspect().clockTasks, 0)
    } catch (error) { failed = true; primary = error }
    const cleanup: unknown[] = []
    try { await session.stop() } catch (error) { cleanup.push(error) }
    try {
      assert.equal(session.snapshot().handles, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      assert.equal(audio.inspect().voices, 0)
      assert.equal(audio.inspect().pendingCreates, 0)
      assert.equal(audio.inspect().clockTasks, 0)
      assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
      assert.equal(clock.tasks.size, 0)
      const readsAtStop = wave.reads.length
      clock.advance(1000)
      await nextTurn()
      assert.equal(wave.reads.length, readsAtStop, 'Retired playback cannot schedule another source read')
    } catch (error) { cleanup.push(error) }
    if (failed && cleanup.length) throw new AggregateError([primary, ...cleanup], 'Stream Session and cleanup failed', { cause: primary })
    if (failed) throw primary
    if (cleanup.length) throw new AggregateError(cleanup, 'Stream Session cleanup failed')
  })

  for (const range of [true, false])
  test(`${mode}/${range ? 'range' : 'buffered'}: Session stop cancels a WAV opening before its first borrowed read settles`, { timeout: 60000 }, async (t) => {
    const wave = longWave(), entered = deferred<void>(), gate = deferred<void>(), late = deferred<void>(),
      clock = new AudioClock(), blocks: Float32Array[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
        (left) => blocks.push(left.slice()), 1000),
      script = 'Debug.message("stream-before-open");var sound=new WaveSoundBuffer(null);sound.open("long.wav");Debug.message("stream-after-open");sound.play();',
      { session, logs } = await headless({
        'startup.tjs': binary
          ? 'Scripts.compileStorage("stream-cancel.tjs","savedata/stream-cancel.cjs",false,true,false);Scripts.execStorage("savedata/stream-cancel.cjs");'
          : 'Scripts.execStorage("stream-cancel.tjs");',
        'stream-cancel.tjs': script,
      }, { audio, now: () => clock.now, schedule: clock.schedule })
    let reads = 0, released = false, originalSettled = false
    const release = () => { released = true; gate.resolve() }
    const heldRead = async (read: () => Promise<Uint8Array>) => {
      reads++
      entered.resolve()
      await gate.promise
      try { return await read() }
      finally { originalSettled = true; late.resolve() }
    }
    const buffered = shortWave([0.25, -0.5, 0.75, -0.25], 1000)
    session.mount([range
      ? { ...wave.resource, source: { size: wave.size,
        read: (offset, length) => heldRead(() => wave.resource.source!.read(offset, length)) } }
      : { name: 'long.wav', size: buffered.length, read: () => heldRead(async () => buffered.slice()) }])
    const starting = session.start(), startResult = starting.then(
      () => ({ rejected: false as const }), (error: unknown) => ({ rejected: true as const, error }))
    let failed = false, primary: unknown
    const stopped = () => {
      assert.equal(session.snapshot().state, 'stopped')
      assert.equal(session.snapshot().handles, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      assert.equal(audio.inspect().voices, 0)
      assert.equal(audio.inspect().pendingCreates, 0)
      assert.equal(audio.inspect().clockTasks, 0)
      assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
      assert.equal(clock.tasks.size, 0)
      assert.equal(blocks.length, 0)
      assert(!logs.some((line) => line.includes('stream-after-open')))
    }
    try {
      await observed(t.signal, Promise.race([entered.promise, starting.then(() => {
        throw new Error('Startup completed before entering the first source read')
      })]))
      assert(logs.some((line) => line.includes('stream-before-open')))
      assert.equal(reads, 1)
      assert.equal(wave.completeReads(), 0)
      assert.equal(originalSettled, false)
      if (binary) {
        const compiled = session.exportSaves().find((entry) => entry.path === 'savedata/stream-cancel.cjs')
        assert(compiled)
        assert.equal(new TextDecoder().decode(compiled.bytes.subarray(0, 4)), 'TJS2')
      }
      await observed(t.signal, session.stop())
      assert.equal((await startResult).rejected, true)
      assert.equal(released, false, 'Stop must settle while the original borrowed I/O is still blocked')
      assert.equal(originalSettled, false)
      stopped()
      release()
      await observed(t.signal, late.promise)
      await nextTurn()
      clock.advance(1000)
      await nextTurn()
      assert.equal(originalSettled, true)
      assert.equal(reads, 1, 'Late source bytes cannot resume decoder opening or issue more reads')
      stopped()
    } catch (error) { failed = true; primary = error }
    const cleanup: unknown[] = []
    // Release before cleanup even when the expected boundary was never reached.
    release()
    try { await session.stop() } catch (error) { cleanup.push(error) }
    await startResult
    if (failed && cleanup.length) throw new AggregateError([primary, ...cleanup], 'Stream cancellation and cleanup failed', { cause: primary })
    if (failed) throw primary
    if (cleanup.length) throw new AggregateError(cleanup, 'Stream cancellation cleanup failed')
  })
}
