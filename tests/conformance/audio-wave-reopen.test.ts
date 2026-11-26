import test from 'node:test'
import assert from 'node:assert/strict'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { PortAudioBackend } from '../../src/backends/audio/port-backend.ts'
import { defaultSoundSettings, emptyLoops, type AudioCommand, type AudioEvent, type PcmAsset } from '../../src/engine/ports/audio.ts'
import type { AudioRequest } from '../../src/protocol/audio.ts'
import type { ByteSource } from '../../src/engine/ports/storage.ts'
import { AudioClock, settleAudioPages, wave } from '../helpers/audio.ts'

const pcm = (sample: number): PcmAsset => ({ kind: 'pcm', sampleRate: 1000, sampleCount: 1000,
  channels: 1, bits: 16, loops: emptyLoops(), data: [new Float32Array(1000).fill(sample)] })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function observed<T>(signal: AbortSignal, value: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Audio fixture observation was cancelled'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    value.then((result) => { signal.removeEventListener('abort', abort); resolve(result) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

test('Wave unload preserves a completed fade target across delayed load, while real close retires every control', () => {
  const mixer = new AudioMixer(1000), settings = defaultSoundSettings()
  mixer.command({ op: 'load', id: 1, kind: 'wave', asset: pcm(0.5), settings })
  mixer.command({ op: 'fade', id: 1, target: 0, time: 120, delay: 0 })
  const retained = mixer.command({ op: 'unload', id: 1 }).snapshot!
  assert.equal(retained.status, 'unload'); assert.equal(retained.fading, true)
  assert.equal(retained.sampleCount, 0); assert.equal(retained.channels, 0)
  const left = new Float32Array(140), right = new Float32Array(140), events = mixer.render(left, right)
  assert.deepEqual([...left], Array(140).fill(0)); assert.deepEqual(right, left)
  assert.equal(events.length, 1); assert.equal(events[0]?.type, 'fade')
  assert.equal(mixer.snapshot(1).volume, 0)
  assert.equal(mixer.hasClockWork, false)
  const next = mixer.command({ op: 'load', id: 1, kind: 'wave', asset: pcm(0.25), settings }).snapshot!
  assert.equal(next.volume, 0, 'Stale captured settings cannot resurrect the pre-open volume')
  assert.equal(next.fading, false); assert.equal(next.status, 'stop')
  mixer.command({ op: 'close', id: 1 })
  assert.deepEqual(mixer.inspect(), { voices: 0, fadingVoices: 0, liveMidiNotes: 0, clockWork: false })
})

test('a stopped public seek requests its real destination without rendering and closes a held old page before reuse', { timeout: 30000 }, async (t) => {
  const bytes = wave(Array(16000).fill(0.5), 1000), replacement = wave(Array(16000).fill(0.25), 1000),
    clock = new AudioClock(), output: number[] = [], gate = deferred<void>(), entered = deferred<void>(),
    failures: unknown[] = [], ranges: number[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left) => output.push(...left), 1000)
  let releases = 0, closing: Promise<unknown> | undefined
  const open = (source: ByteSource): Extract<AudioCommand, { op: 'openSource' }> => ({ op: 'openSource',
    id: 1, kind: 'wave', source, bufferedBytes: 0, settings: defaultSoundSettings(), loops: emptyLoops(),
    releaseSource: () => { releases++ } })
  try {
    await audio.command(open({ size: bytes.length, async read(at, length) {
      ranges.push(at)
      if (at >= 44 + 8192 * 2) { entered.resolve(); await gate.promise }
      return bytes.slice(at, at + length)
    } }))
    const seeking = audio.command({ op: 'set', id: 1, property: 'position', value: 8196 })
    void seeking.catch(() => {})
    await observed(t.signal, entered.promise)
    assert.equal(audio.mixer.snapshot(1).status, 'stop')
    assert.equal(audio.mixer.snapshot(1).position, 0, 'The held target has not committed its public seek')
    assert.equal(audio.inspect().clockTasks, 0); assert.deepEqual(output, [])
    assert(ranges.includes(44 + 8192 * 2))
    assert.equal(audio.mixer.inspectStreams().pending, 1, 'The stopped seek waits only for its target page, not unrelated prefetch')
    closing = audio.command({ op: 'close', id: 1 })
    await assert.rejects(seeking, /superseded/)
    await observed(t.signal, closing)
    assert.equal(releases, 1)
    assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
    await audio.command(open({ size: replacement.length, async read(at, length) { return replacement.slice(at, at + length) } }))
    gate.resolve()
    await audio.command({ op: 'play', id: 1 }); await settleAudioPages(audio)
    clock.advance(20)
    await audio.command({ op: 'inspect', id: 1 })
    assert.deepEqual(output, Array(20).fill(0.25), 'Late retired source bytes cannot enter the replacement stream')
    assert.equal(audio.mixer.snapshot(1).position, 20)
  } catch (error) { failures.push(error) }
  gate.resolve()
  try { await closing } catch (error) { if (!failures.includes(error)) failures.push(error) }
  try { await audio.close(); assert.equal(releases, 2); assert.equal(clock.tasks.size, 0) }
  catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Stopped seek prefetch or cleanup failed', { cause: failures[0] })
})

for (const mode of ['headless', 'port'] as const)
  test(`${mode}: real PCM sources retire on unload while fade timing survives a suspended replacement decoder`, { timeout: 30000 }, async (t) => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], events: AudioEvent[] = [],
      failures: unknown[] = [], gate = deferred<void>(), entered = deferred<void>(), channel = new MessageChannel(),
      remote = new AudioMixer(1000), releases = [0, 0],
      audio = mode === 'headless'
        ? new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
          left.push(...l); right.push(...r)
        }, 1000)
        : new PortAudioBackend(channel.port1)
    audio.listen((event) => events.push(event))
    const pump = () => {
      for (const request of remote.takeStreamRequests()) channel.port2.postMessage({ type: 'streamRead', request })
    }
    channel.port2.onmessage = (event: MessageEvent<AudioRequest>) => {
      const { serial, command } = event.data
      try {
        if (command.op === 'open' || command.op === 'focusMode') throw new Error('Expected real portable PCM load')
        channel.port2.postMessage({ type: 'reply', serial, result: remote.command(command) })
        pump()
      } catch (error) { channel.port2.postMessage({ type: 'reply', serial, error: String(error) }) }
    }
    const mixer = mode === 'headless' ? (audio as HeadlessAudioBackend).mixer : remote,
      advance = async (ms: number) => {
        if (mode === 'headless') clock.advance(ms)
        else {
          const l = new Float32Array(ms), r = new Float32Array(ms)
          for (const event of mixer.render(l, r)) channel.port2.postMessage({ type: 'event', event })
          pump()
          left.push(...l); right.push(...r)
        }
        await audio.command({ op: 'inspect', id: 1 })
      }, opening = (index: number, held: boolean): Extract<AudioCommand, { op: 'openSource' }> => {
        const bytes = wave(Array(16000).fill(index ? 0.25 : 0.5), 1000)
        let first = true
        const source: ByteSource = { size: bytes.length, async read(at, length) {
          if (held && first) { first = false; entered.resolve(); await gate.promise }
          return bytes.slice(at, at + length)
        } }
        return { op: 'openSource', id: 1, kind: 'wave', source, bufferedBytes: 0, loops: emptyLoops(),
          settings: defaultSoundSettings(), releaseSource: () => { releases[index] = releases[index]! + 1 } }
      }
    let pending: Promise<unknown> | undefined
    try {
      await audio.command(opening(0, false)); await audio.command({ op: 'play', id: 1 })
      await audio.command({ op: 'fade', id: 1, target: 0, time: 120, delay: 0 })
      await advance(20)
      assert.deepEqual(left, Array(20).fill(0.5))
      const unloaded = await audio.command({ op: 'unload', id: 1 })
      assert.equal(unloaded.snapshot?.fading, true)
      assert.deepEqual(releases, [1, 0])
      assert.deepEqual(mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
      pending = audio.command(opening(1, true)); void pending.catch(() => {})
      await observed(t.signal, entered.promise)
      await advance(50)
      assert.equal(mixer.snapshot(1).volume, 50000)
      assert.equal(mixer.snapshot(1).position, 0)
      gate.resolve(); await pending
      assert.equal(mixer.snapshot(1).volume, 50000)
      assert.equal(mixer.snapshot(1).fading, true)
      await audio.command({ op: 'play', id: 1 }); await advance(50)
      // Native 50% volume selects -1505 hundredths dB, not half amplitude.
      assert.deepEqual(left, [...Array(20).fill(0.5), ...Array(50).fill(0),
        ...Array(49).fill(Math.fround(0.25 * 10 ** (-1505 / 2000))), 0])
      assert.deepEqual(right, left)
      assert.equal(events.filter((event) => event.type === 'fade').length, 1)
      assert.equal(mixer.snapshot(1).position, 50)
      await audio.command({ op: 'close', id: 1 })
      assert.deepEqual(releases, [1, 1]); assert.equal(mixer.inspect().voices, 0)
      assert.equal(mixer.inspectStreams().voices, 0)
    } catch (error) { failures.push(error) }
    gate.resolve()
    try { await pending } catch (error) { if (!failures.includes(error)) failures.push(error) }
    try { await audio.close() } catch (error) { failures.push(error) }
    channel.port1.close(); channel.port2.close()
    try { assert.equal(clock.tasks.size, 0) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave stream reopen or cleanup failed', { cause: failures[0] })
  })
