import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { PortAudioBackend } from '../../src/backends/audio/port-backend.ts'
import { SourceSeeks } from '../../src/backends/audio/source-seeks.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, emptyLoops, type AudioCommand, type AudioResult, type PcmReadRequest } from '../../src/engine/ports/audio.ts'
import type { AudioRequest } from '../../src/protocol/audio.ts'
import { AudioClock, wave } from '../helpers/audio.ts'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function observed<T>(signal: AbortSignal, event: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Audio seek observation was cancelled'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    event.then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
const samples = wave(Array.from({ length: 40000 }, (_, at) => at < 16384 ? .25 : .5), 1000)
function opening(read: (offset: number, length: number) => Promise<Uint8Array>): Extract<AudioCommand, { op: 'openSource' }> {
  return { op: 'openSource', id: 1, kind: 'wave', source: { size: samples.length, read }, bufferedBytes: 0,
    loops: emptyLoops(), settings: defaultSoundSettings() }
}
const seek = { op: 'set', id: 1, property: 'position', value: 16391 } as const

test('a real WAVE source seek waits for only the destination page, preserving active, paused and stopped transport until commit', { timeout: 30000 }, async (t) => {
  for (const mode of ['playing', 'paused', 'stopped']) {
    const clock = new AudioClock(), entered = deferred(), release = deferred(), output: number[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left) => output.push(...left), 1000)
    let complete = false
    try {
      await audio.command(opening(async (offset, length) => {
        if (offset === 44 + 16384 * 2) { entered.resolve(); await release.promise }
        return samples.slice(offset, offset + length)
      }))
      if (mode !== 'stopped') await audio.command({ op: 'play', id: 1 })
      if (mode === 'paused') await audio.command({ op: 'set', id: 1, property: 'paused', value: true })
      const epoch = audio.mixer.snapshot(1).epoch, pending = audio.command(seek).then((result) => { complete = true; return result })
      void pending.catch(() => {})
      await observed(t.signal, entered.promise); await turn()
      assert.equal(complete, false); assert.equal(audio.mixer.snapshot(1).position, 0)
      assert.equal(audio.mixer.snapshot(1).epoch, epoch)
      clock.advance(20)
      assert.deepEqual(output, mode === 'playing' ? Array(20).fill(.25) : [])
      release.resolve()
      const result = await pending
      assert.equal(result.sourceReady, true); assert.equal(result.snapshot?.position, 16391)
      assert.equal(result.snapshot?.status, mode === 'stopped' ? 'stop' : 'play')
      assert.equal(result.snapshot?.paused, mode === 'paused')
      if (mode === 'paused') await audio.command({ op: 'set', id: 1, property: 'paused', value: false })
      if (mode === 'stopped') await audio.command({ op: 'play', id: 1 })
      output.length = 0; clock.advance(20)
      assert.deepEqual(output, Array(20).fill(.5), 'No settleAudioPages or clock tick is needed before the first actual target PCM')
      assert.equal(audio.mixer.snapshot(1).position, 16411)
      assert(audio.mixer.inspectStreams().pending <= 4); assert(audio.mixer.inspectStreams().bytes <= 16 * 4096 * 4)
    } finally { release.resolve(); await audio.close(); assert.equal(clock.tasks.size, 0) }
  }
})

test('a port seek waits for the actual target streamData ACK without requiring render ticks or later background pages', { timeout: 30000 }, async (t) => {
  const channel = new MessageChannel(), mixer = new AudioMixer(1000), installed = deferred<{ serial: number; result: AudioResult }>(),
    background = deferred(), backgroundEntered = deferred(), requests: PcmReadRequest[] = []
  let complete = false
  channel.port2.onmessage = ({ data }: MessageEvent<AudioRequest>) => {
    const { command, serial } = data
    if (command.op === 'open' || command.op === 'focusMode') { channel.port2.postMessage({ type: 'reply', serial, error: 'Unexpected fallback' }); return }
    try {
      const result = mixer.command(command), flush = () => {
        for (const request of mixer.takeStreamRequests()) { requests.push(request); channel.port2.postMessage({ type: 'streamRead', request }) }
      }
      if (command.op === 'seekSource' && result.sourceReady === false) flush()
      if (command.op === 'streamData' && command.request.position === 16384) { installed.resolve({ serial, result }); return }
      channel.port2.postMessage({ type: 'reply', serial, result }); flush()
    } catch (error) { channel.port2.postMessage({ type: 'reply', serial, error: String(error) }) }
  }
  const audio = new PortAudioBackend(channel.port1)
  try {
    await audio.command(opening(async (offset, length) => {
      if (offset === 44 + 20480 * 2) { backgroundEntered.resolve(); await background.promise }
      return samples.slice(offset, offset + length)
    }))
    await audio.command({ op: 'pauseAll', paused: true })
    const pending = audio.command(seek).then((result) => { complete = true; return result })
    void pending.catch(() => {})
    const held = await observed(t.signal, installed.promise)
    await turn(); assert.equal(complete, false); assert.equal(mixer.snapshot(1).position, 0)
    channel.port2.postMessage({ type: 'reply', serial: held.serial, result: held.result })
    assert.equal((await pending).snapshot?.position, 16391)
    await observed(t.signal, backgroundEntered.promise)
    assert.equal(complete, true, 'An unrelated prefetch remains held after public seek completion')
    assert.equal(mixer.frames, 0); assert(requests.some((request) => request.position === 16384))
    await audio.command({ op: 'pauseAll', paused: false }); await audio.command({ op: 'play', id: 1 })
    const left = new Float32Array(20), right = new Float32Array(20)
    mixer.render(left, right); assert.deepEqual([...left], Array(20).fill(.5)); assert.deepEqual(left, right)
  } finally { background.resolve(); try { await audio.close() } finally { channel.port2.close() } }
})

test('later seeks, Stop and close cancel a held source seek without letting its late page move the new transport', { timeout: 30000 }, async (t) => {
  for (const action of ['seek', 'stop', 'close', 'reopen'] as const) {
    const clock = new AudioClock(), entered = deferred(), release = deferred(),
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, undefined, 1000)
    try {
      await audio.command(opening(async (offset, length) => {
        if (offset === 44 + 16384 * 2) { entered.resolve(); await release.promise }
        return samples.slice(offset, offset + length)
      }))
      await audio.command({ op: 'play', id: 1 })
      const pending = audio.command(seek), rejected = assert.rejects(pending, /superseded/)
      void rejected.catch(() => {})
      await observed(t.signal, entered.promise)
      const later = audio.command(action === 'seek' ? { op: 'set', id: 1, property: 'position', value: 20 }
        : action === 'reopen' ? opening(async (offset, length) => samples.slice(offset, offset + length)) : { op: action, id: 1 })
      void later.catch(() => {})
      await rejected // Must not need the held decoder to finish first.
      release.resolve(); await later; await turn()
      if (action === 'close') assert.equal(audio.inspect().voices, 0)
      else {
        assert.equal(audio.mixer.snapshot(1).position, action === 'seek' ? 20 : 0)
        assert.equal(audio.mixer.snapshot(1).status, action === 'seek' ? 'play' : 'stop')
      }
    } finally { release.resolve(); await audio.close() }
  }
})

test('destination read failures and a bounded seek timeout reject without a fabricated ready result', { timeout: 30000 }, async () => {
  const clock = new AudioClock(), audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, undefined, 1000)
  try {
    await audio.command(opening(async (offset, length) => {
      if (offset === 44 + 16384 * 2) throw new Error('Recording page unavailable')
      return samples.slice(offset, offset + length)
    }))
    await assert.rejects(audio.command(seek), /Recording page unavailable/)
    assert.equal(audio.mixer.snapshot(1).position, 0)
  } finally { await audio.close() }
  let expire!: () => void, cleared = 0, attempts = 0
  const coordinator = new SourceSeeks((callback) => { expire = callback; return () => { cleared++ } }), gate = deferred(),
    request = { id: 1, streamId: 1, serial: 1, position: 16384, frames: 4096 }
  const tracked = coordinator.track(request, gate.promise), pending = coordinator.run({ op: 'seekSource', id: 1, streamId: 1, position: 16391 },
    async () => { attempts++; return { sourceReady: false, events: [] } })
  const rejected = assert.rejects(pending, /target page timed out/)
  expire(); await rejected; gate.resolve(); await tracked
  assert.equal(cleared, 1); assert.equal(attempts, 1)
  const sequence = new SourceSeeks(() => () => {}), delivery = deferred(),
    read = sequence.track(request, delivery.promise)
  let calls = 0
  const joined = sequence.run({ op: 'seekSource', id: 1, streamId: 1, position: 16391 }, async (): Promise<AudioResult> => {
    calls++
    return { sourceReady: calls > 1, events: [{ type: 'error', message: `preserved-result-${calls}` }] }
  })
  await turn(); delivery.resolve(); await read
  assert.deepEqual((await joined).events, [
    { type: 'error', message: 'preserved-result-1' }, { type: 'error', message: 'preserved-result-2' },
  ])
})
