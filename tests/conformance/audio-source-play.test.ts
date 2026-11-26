import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { PortAudioBackend } from '../../src/backends/audio/port-backend.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, emptyLoops, type AudioCommand, type AudioEvent, type StreamingPcmAsset } from '../../src/engine/ports/audio.ts'
import { AudioClock, settleAudioPages, wave } from '../helpers/audio.ts'
import type { AudioRequest } from '../../src/protocol/audio.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function observed(signal: AbortSignal, promise: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Wave startup observation was cancelled'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(() => { signal.removeEventListener('abort', abort); resolve() },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
const rate = 48000, bytes = wave(Array.from({ length: rate * 2 }, (_, frame) => frame < rate ? .25 : .5), rate)
const opening = (read: (offset: number, length: number) => Promise<Uint8Array>): Extract<AudioCommand, { op: 'openSource' }> => ({
  op: 'openSource', id: 1, kind: 'wave', source: { size: bytes.length, read }, bufferedBytes: 0,
  loops: { links: [], labels: [{ position: 0, name: 'begin' }, { position: 24000, name: 'half' }] }, settings: defaultSoundSettings(),
})

test('ordinary WAVE play primes the four native 125 ms units and keeps exact PCM through a delayed rolling read', { timeout: 30000 }, async (t) => {
  const first = deferred(), firstEntered = deferred(), later = deferred(), laterEntered = deferred(),
    clock = new AudioClock(), output: number[] = [], events: AudioEvent[] = [], reads: number[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left) => output.push(...left), rate)
  let played = false
  audio.listen((event) => events.push(event))
  try {
    await audio.command(opening(async (offset, length) => {
      if (offset >= 44) reads.push((offset - 44) / 2)
      if (offset === 44 + 8192 * 2) { firstEntered.resolve(); await first.promise }
      if (offset === 44 + 24576 * 2) { laterEntered.resolve(); await later.promise }
      return bytes.slice(offset, offset + length)
    }))
    const pending = audio.command({ op: 'play', id: 1 }).then((result) => { played = true; return result })
    void pending.catch(() => {})
    await observed(t.signal, firstEntered.promise)
    assert.equal(played, false); assert.equal(audio.mixer.snapshot(1).status, 'stop')
    assert.equal(audio.mixer.snapshot(1).position, 0); assert.deepEqual(events, [])
    clock.advance(20); assert.deepEqual(output, [])
    first.resolve(); const started = await pending
    assert.equal(started.sourceReady, true); assert.equal(started.snapshot?.status, 'play')
    assert.equal(started.snapshot?.position, 0); assert.deepEqual(events, [])
    for (const page of [0, 4096, 8192, 12288, 16384, 20480]) assert(reads.includes(page))
    await observed(t.signal, laterEntered.promise)
    clock.advance(300)
    assert.deepEqual(output, Array(14400).fill(.25), 'A 300 ms delayed future page cannot starve the prepared startup PCM')
    assert.equal(audio.mixer.snapshot(1).position, 14400)
    assert(audio.mixer.inspectStreams().pending <= 4)
    later.resolve(); await settleAudioPages(audio)
    // Continue through the first one-second window and natural EOF. Every
    // sample is compared; the host timer only controls read availability.
    for (let at = 300; at < 2020; at += 20) {
      clock.advance(20); await settleAudioPages(audio)
    }
    assert.deepEqual(output, [...Array(rate).fill(.25), ...Array(rate).fill(.5), ...Array(960).fill(0)])
    assert.deepEqual(events.filter((event) => event.type === 'label').map((event) => event.label), ['begin', 'half'])
    assert.equal(events.filter((event) => event.type === 'ended').length, 1)
    assert.equal(audio.mixer.snapshot(1).status, 'stop')
    assert(audio.mixer.inspectStreams().bytes <= 16 * 4096 * 4)
    const readZero = reads.filter((frame) => frame === 0).length
    await audio.command({ op: 'play', id: 1 })
    assert(reads.filter((frame) => frame === 0).length > readZero, 'Natural replay refills the evicted beginning')
    output.length = 0; clock.advance(20); assert.deepEqual(output, Array(960).fill(.25))
    await audio.command({ op: 'stop', id: 1 })
    const warmReads = reads.filter((frame) => frame < 24000).length
    await audio.command({ op: 'play', id: 1 })
    assert.equal(reads.filter((frame) => frame < 24000).length, warmReads, 'A cached replay does not decode startup pages again')
  } finally { first.resolve(); later.resolve(); await audio.close(); assert.equal(clock.tasks.size, 0) }
})

test('paused WAVE play prepares real pages without advancing, and Stop or close cancels a still-preparing play', { timeout: 30000 }, async (t) => {
  for (const action of ['resume', 'stop', 'close'] as const) {
    const gate = deferred(), entered = deferred(), clock = new AudioClock(), output: number[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left) => output.push(...left), rate)
    try {
      await audio.command(opening(async (offset, length) => {
        if (offset === 44 + 8192 * 2) { entered.resolve(); await gate.promise }
        return bytes.slice(offset, offset + length)
      }))
      await audio.command({ op: 'set', id: 1, property: 'paused', value: true })
      const pending = audio.command({ op: 'play', id: 1 })
      void pending.catch(() => {})
      await observed(t.signal, entered.promise)
      if (action === 'resume') {
        gate.resolve(); const result = await pending
        assert.equal(result.snapshot?.status, 'play'); assert.equal(result.snapshot?.paused, true)
        clock.advance(100); assert.deepEqual(output, []); assert.equal(audio.mixer.snapshot(1).position, 0)
        await audio.command({ op: 'set', id: 1, property: 'paused', value: false })
        clock.advance(20); assert.deepEqual(output, Array(960).fill(.25))
      } else {
        const rejected = assert.rejects(pending, /superseded/), closing = audio.command({ op: action, id: 1 })
        void closing.catch(() => {})
        await rejected; gate.resolve(); await closing
        if (action === 'stop') {
          assert.equal(audio.mixer.snapshot(1).status, 'stop'); assert.equal(audio.mixer.snapshot(1).position, 0)
        } else assert.equal(audio.inspect().voices, 0)
      }
    } finally { gate.resolve(); await audio.close() }
  }
})

test('the normal audio port publishes play only after startup PCM delivery even with a suspended device clock', { timeout: 30000 }, async (t) => {
  const channel = new MessageChannel(), mixer = new AudioMixer(rate), entered = deferred(), release = deferred(), audio = new PortAudioBackend(channel.port1)
  channel.port2.onmessage = ({ data }: MessageEvent<AudioRequest>) => {
    const { command, serial } = data
    if (command.op === 'open' || command.op === 'focusMode') { channel.port2.postMessage({ type: 'reply', serial, error: 'Unexpected fallback' }); return }
    try {
      const result = mixer.command(command), flush = () => {
        for (const request of mixer.takeStreamRequests()) channel.port2.postMessage({ type: 'streamRead', request })
      }
      if ((command.op === 'seekSource' || command.op === 'playSource') && result.sourceReady === false) flush()
      channel.port2.postMessage({ type: 'reply', serial, result }); flush()
    } catch (error) { channel.port2.postMessage({ type: 'reply', serial, error: String(error) }) }
  }
  try {
    await audio.command(opening(async (offset, length) => {
      if (offset === 44 + 8192 * 2) { entered.resolve(); await release.promise }
      return bytes.slice(offset, offset + length)
    }))
    await audio.command({ op: 'pauseAll', paused: true })
    const playing = audio.command({ op: 'play', id: 1 }); void playing.catch(() => {})
    await observed(t.signal, entered.promise)
    assert.equal(mixer.frames, 0); assert.equal(mixer.snapshot(1).status, 'stop')
    release.resolve(); assert.equal((await playing).snapshot?.status, 'play')
    assert.equal(mixer.frames, 0); assert.equal(mixer.snapshot(1).position, 0)
    await audio.command({ op: 'pauseAll', paused: false })
    const left = new Float32Array(12000), right = new Float32Array(12000)
    mixer.render(left, right); assert.deepEqual([...left], Array(12000).fill(.25)); assert.deepEqual(left, right)
  } finally { release.resolve(); try { await audio.close() } finally { channel.port2.close() } }
})

test('startup prefetch retains the 16-page/four-read bound and leaves linked, filtered and CDDA routing on their established path', () => {
  const asset = (sampleRate = 48000): StreamingPcmAsset => ({ kind: 'stream', streamId: 1, sampleRate,
    sampleCount: sampleRate * 2, channels: 1, bits: 16, loops: emptyLoops(),
    initial: [0, 4096].map((position) => ({ position, data: [new Float32Array(4096).fill(.25)] })) })
  for (const mode of ['cdda', 'linked', 'filtered']) {
    const mixer = new AudioMixer(48000), source = asset()
    if (mode === 'linked') source.loops.links.push({ from: 40000, to: 10000, smooth: false, condition: 'no', variable: 0, reference: 0 })
    try {
      mixer.command({ op: 'load', id: 1, kind: mode === 'cdda' ? 'cdda' : 'wave', asset: source, settings: defaultSoundSettings(),
        ...(mode === 'filtered' ? { filters: [{ type: 'phase-vocoder' as const, id: 1, window: 512, overlap: 4, pitch: 1, time: 1 }] } : {}) })
      const result = mixer.command({ op: 'playSource', id: 1, streamId: 1 })
      assert.equal(result.sourceReady, true); assert.equal(result.snapshot?.status, 'play')
    } finally { mixer.command({ op: 'shutdown' }) }
  }
  const mixer = new AudioMixer(48000)
  try {
    mixer.command({ op: 'load', id: 1, kind: 'wave', asset: asset(384000), settings: defaultSoundSettings() })
    let result = mixer.command({ op: 'playSource', id: 1, streamId: 1 }), fetched = 0
    for (let round = 0; !result.sourceReady && round < 16; round++) {
      const requests = mixer.takeStreamRequests(); assert(requests.length > 0 && requests.length <= 4)
      for (const request of requests) {
        assert(request.position < 15 * 4096); fetched++
        mixer.command({ op: 'streamData', request, data: [new Float32Array(request.frames).fill(.25)] })
      }
      result = mixer.command({ op: 'playSource', id: 1, streamId: 1 })
    }
    assert.equal(result.sourceReady, true)
    assert.equal(fetched, 13); assert.equal(result.snapshot?.position, 0)
    assert(mixer.inspectStreams().bytes <= 16 * 4096 * 4); assert(mixer.inspectStreams().pending <= 4)
  } finally { mixer.command({ op: 'shutdown' }) }
})
