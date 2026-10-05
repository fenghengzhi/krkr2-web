import test from 'node:test'
import assert from 'node:assert/strict'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { PortAudioBackend } from '../../src/backends/audio/port-backend.ts'
import { PcmStreamPool, type PcmSourceFactory } from '../../src/backends/audio/stream-pool.ts'
import type { PcmSource } from '../../src/backends/audio/pcm-source.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, emptyLoops, type AudioCommand, type PcmReadRequest,
  type AudioResult, type StreamingPcmAsset } from '../../src/engine/ports/audio.ts'
import type { ByteSource } from '../../src/engine/ports/storage.ts'
import type { AudioRequest } from '../../src/protocol/audio.ts'
import { AudioClock, wave } from '../helpers/audio.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function observed<T>(signal: AbortSignal, event: Promise<T>, operation?: Promise<unknown>): Promise<T> {
  const pending = operation ? Promise.race([event, operation.then(() => {
    throw new Error('Operation settled before the expected asynchronous observation')
  })]) : event
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Timed out waiting for an audio backend observation'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    pending.then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const source = (size = 16): ByteSource => ({ size, async read(_offset, length) { return new Uint8Array(length) } })
const opening = (id: number, input = source(), releaseSource?: () => void): Extract<AudioCommand, { op: 'openSource' }> => ({
  op: 'openSource', id, kind: 'wave', source: input, bufferedBytes: 0, releaseSource,
  loops: emptyLoops(), settings: defaultSoundSettings(),
})
function decoder(read?: PcmSource['read'], close?: PcmSource['close']): PcmSource {
  return {
    info: Object.freeze({ sampleRate: 1000, sampleCount: 40000, channels: 1, bits: 16, loops: emptyLoops() }),
    read: read ?? (async (_position, frames) => [new Float32Array(frames).fill(0.25)]),
    close: close ?? (async () => {}),
  }
}
const request = (id: number, streamId: number, serial = 1, position = 8192): PcmReadRequest =>
  ({ id, streamId, serial, position, frames: 4096 })

test('headless production WAVE source reaches audio beyond its initial pages without a whole-file read', { timeout: 30000 }, async () => {
  const bytes = wave(Array.from({ length: 14000 }, () => 0.5), 1000), ranges: [number, number][] = []
  const input: ByteSource = { size: bytes.length, async read(offset, length) {
    ranges.push([offset, length]); return bytes.slice(offset, offset + length)
  } }
  const clock = new AudioClock(), output: number[] = []
  let releases = 0
  const audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
    (left) => output.push(...left), 1000)
  try {
    const loaded = await audio.command(opening(1, input, () => { releases++ }))
    assert.equal(loaded.snapshot?.sampleCount, 14000)
    assert.equal(audio.streaming, true)
    assert.equal(audio.mixer.inspectStreams().voices, 1)
    assert.equal(releases, 0)
    await audio.command({ op: 'play', id: 1 })
    for (let index = 0; index < 120; index++) { clock.advance(100); await turn() }
    assert.ok(output.length >= 12000)
    assert.ok(output.slice(10000, 11000).every((sample) => sample > 0.49 && sample < 0.51))
    assert.ok(ranges.some(([offset]) => offset >= 44 + 8192 * 2))
    assert.ok(ranges.every(([, length]) => length < bytes.length))
    assert.ok(audio.mixer.inspectStreams().bytes <= 16 * 4096 * 4)
    await audio.command({ op: 'close', id: 1 })
    assert.equal(releases, 1)
    assert.equal(clock.tasks.size, 0)
    assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
  } finally { await audio.close() }
})

test('stream pool limits actual decoder jobs to two and retains retired permits and leases until work settles', { timeout: 30000 }, async () => {
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()], started: number[] = [], released: number[] = []
  let factories = 0, active = 0, maximum = 0
  const pool = new PcmStreamPool(async () => {
    const index = factories++
    return decoder(async (position, frames) => {
      if (position >= 8192) {
        active++; maximum = Math.max(maximum, active); started.push(index)
        try { await gates[index]!.promise } finally { active-- }
      }
      return [new Float32Array(frames).fill(index + 0.25)]
    })
  })
  try {
    const candidates = []
    for (let id = 1; id <= 3; id++) {
      const candidate = await pool.prepare(opening(id, source(), () => released.push(id)), () => {})
      pool.commit(candidate); candidates.push(candidate)
    }
    const reads = candidates.map((candidate) => pool.read(request(candidate.id, candidate.streamId)))
    await turn()
    assert.deepEqual(started, [0, 1])
    assert.equal(maximum, 2)
    const retiring = pool.retire(1)
    assert.equal(await reads[0], undefined)
    await turn()
    assert.deepEqual(released, [])
    assert.deepEqual(started, [0, 1], 'cancellation must not release an actual decoder permit early')
    gates[0]!.resolve()
    await retiring
    await turn()
    assert.deepEqual(released, [1])
    assert.deepEqual(started, [0, 1, 2])
    gates[1]!.resolve(); gates[2]!.resolve()
    const replies = await Promise.all(reads)
    assert.equal(replies[1]?.data?.[0]?.[0], 1.25)
    assert.equal(replies[2]?.data?.[0]?.[0], 2.25)
    assert.equal(maximum, 2)
  } finally {
    for (const gate of gates) gate.resolve()
    await pool.close()
  }
  assert.deepEqual(released.sort(), [1, 2, 3])
})

test('stream request queues are bounded and closed voices cannot publish late pages into reused ids', { timeout: 30000 }, async (t) => {
  const gate = deferred<void>(), entered = deferred<void>()
  let closed = false, releases = 0, factories = 0
  const pool = new PcmStreamPool(async () => ++factories === 1 ? decoder(async (position, frames) => {
    if (position >= 8192) { entered.resolve(); await gate.promise }
    return [new Float32Array(frames).fill(0.25)]
  }, async () => { closed = true }) : decoder())
  try {
    const first = await pool.prepare(opening(7, source(), () => { releases++ }), () => {})
    pool.commit(first)
    const reads = Array.from({ length: 4 }, (_, index) => pool.read(request(7, first.streamId, index + 1, 8192 + index * 4096)))
    await observed(t.signal, entered.promise, reads[0])
    const excess = await pool.read(request(7, first.streamId, 5, 24576))
    assert.match(excess?.error ?? '', /budget/)
    const retiring = pool.retire(7)
    assert.deepEqual(await Promise.all(reads), [undefined, undefined, undefined, undefined])
    const second = await pool.prepare(opening(7), () => {})
    pool.commit(second)
    assert.notEqual(second.streamId, first.streamId)
    assert.equal(await pool.read(request(7, first.streamId, 6)), undefined)
    assert.equal(releases, 0)
    gate.resolve(); await retiring
    assert.equal(closed, true)
    assert.equal(releases, 1)
    assert.ok((await pool.read(request(7, second.streamId)))?.data)
  } finally { gate.resolve(); await pool.close() }
})

test('a failed replacement preserves the active decoder and does not mutate immutable source loop metadata', { timeout: 30000 }, async () => {
  let factories = 0, oldRelease = 0, badRelease = 0
  const original = decoder(), pool = new PcmStreamPool(async () => {
    if (++factories === 2) throw new Error('Recognized corrupt source')
    return original
  })
  try {
    const command = opening(1, source(), () => { oldRelease++ })
    command.loops = { links: [], labels: [{ position: 8192, name: 'external-label' }] }
    const first = await pool.prepare(command, () => {})
    assert.deepEqual(first.asset?.loops, command.loops)
    assert.notEqual(first.asset?.loops, command.loops)
    assert.deepEqual(original.info.loops, emptyLoops())
    pool.commit(first)
    await assert.rejects(pool.prepare(opening(1, source(), () => { badRelease++ }), () => {}), /Recognized corrupt/)
    assert.equal(badRelease, 1)
    assert.equal(oldRelease, 0)
    assert.equal((await pool.read(request(1, first.streamId)))?.data?.[0]?.[0], 0.25)
  } finally { await pool.close() }
  assert.equal(oldRelease, 1)
})

test('unsupported source fallback is private, once-only and rejects oversized input before reading it', { timeout: 30000 }, async () => {
  const bytes = new Uint8Array([4, 5, 6]), pool = new PcmStreamPool(async () => undefined)
  let reads = 0, releases = 0
  try {
    const large = await pool.prepare(opening(1, { size: 64 * 1024 * 1024 + 1,
      async read() { reads++; throw new Error('must not read complete oversized input') } }, () => { releases++ }), () => {})
    await assert.rejects(pool.fallbackBytes(large), /64 MiB/)
    assert.equal(reads, 0)
    await pool.discard(large)
    const small = await pool.prepare(opening(2, { size: bytes.length, async read() { reads++; return bytes } },
      () => { releases++ }), () => {})
    const copy = await pool.fallbackBytes(small)
    bytes[0] = 99
    assert.deepEqual(copy, new Uint8Array([4, 5, 6]))
    assert.equal(reads, 1)
    await assert.rejects(pool.fallbackBytes(small), /already consumed/)
    await pool.discard(small)
    assert.equal(releases, 2)
  } finally { await pool.close() }
})

test('buffered leases and concurrent range fallbacks share a 64 MiB reservation through actual read settlement', { timeout: 30000 }, async (t) => {
  const gate = deferred<Uint8Array>(), started = deferred<void>(), pool = new PcmStreamPool(async () => undefined)
  let secondReads = 0, thirdReads = 0
  const buffered = opening(1, source(32 * 1024 * 1024))
  buffered.bufferedBytes = buffered.source.size
  try {
    const first = await pool.prepare(buffered, () => {})
    const second = await pool.prepare(opening(2, { size: 32 * 1024 * 1024 + 1, async read() {
      secondReads++; started.resolve(); return gate.promise
    } }), () => {})
    await assert.rejects(pool.fallbackBytes(second), /session complete decode budget/)
    assert.equal(secondReads, 0)
    await pool.discard(first)
    const reading = pool.fallbackBytes(second), rejected = assert.rejects(reading, /closed or superseded/)
    await observed(t.signal, started.promise, reading)
    const third = await pool.prepare(opening(3, { size: 32 * 1024 * 1024, async read() {
      thirdReads++; throw new Error('third read entered after prior reservation settled')
    } }), () => {})
    await assert.rejects(pool.fallbackBytes(third), /session complete decode budget/)
    const retiring = pool.retire(2)
    await rejected
    await assert.rejects(pool.fallbackBytes(third), /session complete decode budget/)
    assert.equal(thirdReads, 0)
    gate.resolve(new Uint8Array()); await retiring
    await assert.rejects(pool.fallbackBytes(third), /third read entered/)
    assert.equal(secondReads, 1)
    assert.equal(thirdReads, 1)
  } finally { gate.resolve(new Uint8Array()); await pool.close() }
})

test('headless cancel aborts production decoder opening before borrowed I/O settles and leaves teardown available', { timeout: 30000 }, async (t) => {
  const gate = deferred<Uint8Array>(), entered = deferred<void>(), clock = new AudioClock(), bytes = wave([0.5, 0.25])
  let reads = 0, releases = 0
  const audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, undefined, 1000)
  const pending = audio.command(opening(1, { size: bytes.length, async read() {
    reads++; entered.resolve(); return gate.promise
  } }, () => { releases++ }))
  const rejected = assert.rejects(pending, /closed|superseded/)
  try {
    await observed(t.signal, entered.promise, pending)
    const cancelled = audio.cancel()
    assert.equal(audio.cancel(), cancelled)
    await observed(t.signal, cancelled)
    await rejected
    assert.equal(releases, 1)
    assert.equal(reads, 1)
    gate.resolve(bytes.slice(0, 12))
    await turn()
    assert.equal(reads, 1)
    assert.equal(audio.inspect().voices, 0)
    assert.equal(audio.inspect().pendingCreates, 0)
    assert.equal(clock.tasks.size, 0)
    await audio.command({ op: 'close', id: 1 })
    await assert.rejects(audio.command(opening(2, source(), () => { releases++ })), /closed/)
    await assert.rejects(audio.command({ op: 'create', id: 2, settings: defaultSoundSettings() }), /closed/)
    assert.equal(releases, 2)
  } finally { gate.resolve(bytes.slice(0, 12)); await audio.close() }
})

test('rejected direct mixer load and create of an existing id retain its old decoder for later pages', { timeout: 30000 }, async () => {
  const clock = new AudioClock(), positions: number[] = [], output: number[] = []
  let releases = 0
  const audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
    (left) => output.push(...left), 1000, undefined, async () => decoder(async (position, frames) => {
      positions.push(position); return [new Float32Array(frames).fill(0.25)]
    }))
  try {
    await audio.command(opening(1, source(), () => { releases++ }))
    await assert.rejects(audio.command({ op: 'load', id: 1, settings: defaultSoundSettings(), asset: {
      kind: 'pcm', sampleRate: 1000, sampleCount: 0, channels: 1, bits: 16, data: [new Float32Array()], loops: emptyLoops(),
    } }), /Invalid decoded audio/)
    await audio.command({ op: 'create', id: 1, settings: defaultSoundSettings() })
    assert.equal(releases, 0)
    assert.equal(audio.mixer.inspectStreams().voices, 1)
    await audio.command({ op: 'set', id: 1, property: 'position', value: 12000 })
    await audio.command({ op: 'play', id: 1 })
    clock.advance(20); await turn(); clock.advance(20); await turn()
    assert.ok(positions.includes(8192))
    assert.ok(output.slice(-20).every((sample) => sample === 0.25))
    assert.equal((await audio.command({ op: 'inspect', id: 1 })).snapshot?.status, 'play')
    assert.equal(releases, 0)
  } finally { await audio.close() }
  assert.equal(releases, 1)
})

test('port load ACK gates early refill and transfers only private decoder planes', { timeout: 30000 }, async (t) => {
  const channel = new MessageChannel(), loaded = deferred<{ serial: number; asset: StreamingPcmAsset }>(),
    filled = deferred<Float32Array[]>(), planes: Float32Array[] = [], readPositions: number[] = []
  let releases = 0
  channel.port2.onmessage = ({ data }: MessageEvent<AudioRequest>) => {
    const { serial, command } = data
    if (command.op === 'load' && command.asset.kind === 'stream') {
      loaded.resolve({ serial, asset: command.asset })
      channel.port2.postMessage({ type: 'streamRead', request: request(command.id, command.asset.streamId) })
      return
    }
    if (command.op === 'streamData' && command.data) filled.resolve(command.data)
    channel.port2.postMessage({ type: 'reply', serial, result: { events: [] } })
  }
  const factory: PcmSourceFactory = async () => decoder(async (position, frames) => {
    readPositions.push(position)
    const plane = new Float32Array(frames).fill(0.375); planes.push(plane); return [plane]
  })
  const audio = new PortAudioBackend(channel.port1, undefined, factory)
  try {
    const pending = audio.command(opening(1, source(), () => { releases++ }))
    const { serial, asset } = await observed(t.signal, loaded.promise, pending)
    assert.deepEqual(asset.initial.map((block) => [block.position, block.data[0]!.length]), [[0, 4096], [4096, 4096]])
    await turn()
    assert.deepEqual(readPositions, [0, 4096])
    assert.ok(planes.every((plane) => plane.length === 4096 && plane[0] === 0.375))
    channel.port2.postMessage({ type: 'reply', serial, result: { events: [] } })
    await pending
    assert.equal((await observed(t.signal, filled.promise))[0]![0], 0.375)
    assert.deepEqual(readPositions, [0, 4096, 8192])
    assert.ok(planes.every((plane) => plane.byteLength === 16384))
    const cancelled = audio.cancel()
    assert.equal(audio.cancel(), cancelled)
    await cancelled
    await assert.rejects(audio.command({ op: 'create', id: 2, settings: defaultSoundSettings() }), /closed/)
    assert.equal(releases, 1)
    await audio.command({ op: 'close', id: 1 })
  } finally { try { await audio.close() } finally { channel.port2.close() } }
})

test('port rejected candidate/direct loads and create preserve the old stream, joining candidate cleanup first', { timeout: 30000 }, async (t) => {
  const channel = new MessageChannel(), posted: AudioRequest['command'][] = [], closeGate = deferred<void>(),
    closeStarted = deferred<void>(), refilled = deferred<void>()
  let loads = 0, factories = 0, released = false
  channel.port2.onmessage = ({ data }: MessageEvent<AudioRequest>) => {
    posted.push(data.command)
    if (data.command.op === 'streamData') refilled.resolve()
    const reject = data.command.op === 'load' && (++loads === 2 || data.command.asset.sampleCount === 0)
    channel.port2.postMessage({ type: 'reply', serial: data.serial,
      ...(reject ? { error: 'consumer rejected replacement' } : { result: { events: [] } }) })
  }
  const audio = new PortAudioBackend(channel.port1, undefined, async () => ++factories === 1 ? decoder()
    : decoder(undefined, async () => { closeStarted.resolve(); await closeGate.promise }))
  try {
    await audio.command(opening(1))
    const first = posted.find((command) => command.op === 'load')
    assert.ok(first?.op === 'load' && first.asset.kind === 'stream')
    const replacement = audio.command(opening(1, source(), () => { released = true }))
    const rejected = assert.rejects(replacement, /consumer rejected replacement/)
    // The load reply and its cleanup span separate MessagePort turns.
    await observed(t.signal, closeStarted.promise, replacement)
    assert.equal(released, false)
    closeGate.resolve(); await rejected
    assert.equal(released, true)
    await audio.command({ op: 'create', id: 1, settings: defaultSoundSettings() })
    await assert.rejects(audio.command({ op: 'load', id: 1, settings: defaultSoundSettings(), asset: {
      kind: 'pcm', sampleRate: 1000, sampleCount: 0, channels: 1, bits: 16, data: [new Float32Array()], loops: emptyLoops(),
    } }), /consumer rejected replacement/)
    channel.port2.postMessage({ type: 'streamRead', request: request(1, first.asset.streamId) })
    await observed(t.signal, refilled.promise)
    const refill = posted.find((command) => command.op === 'streamData')
    assert.ok(refill?.op === 'streamData' && refill.request.streamId === first.asset.streamId && refill.data)
  } finally { closeGate.resolve(); try { await audio.close() } finally { channel.port2.close() } }
})

test('a later source opening waits for an installed load ACK and its failure leaves that stream able to refill', { timeout: 30000 }, async (t) => {
  const channel = new MessageChannel(), mixer = new AudioMixer(1000),
    installed = deferred<{ serial: number; result: AudioResult; streamId: number }>(),
    refilled = deferred<PcmReadRequest>(), positions: number[] = []
  let factories = 0, firstReleased = 0, secondReleased = 0
  channel.port2.onmessage = ({ data }: MessageEvent<AudioRequest>) => {
    const { serial, command } = data
    if (command.op === 'open' || command.op === 'focusMode') {
      channel.port2.postMessage({ type: 'reply', serial, error: 'Unexpected non-mixer command' }); return
    }
    try {
      const result = mixer.command(command)
      if (command.op === 'load' && command.asset.kind === 'stream') {
        // Reproduce the critical window: the consumer already replaced its
        // voice, but the Worker cannot yet commit because its ACK is withheld.
        installed.resolve({ serial, result, streamId: command.asset.streamId })
        return
      }
      if (command.op === 'streamData' && command.data) refilled.resolve(command.request)
      channel.port2.postMessage({ type: 'reply', serial, result })
    } catch (error) {
      channel.port2.postMessage({ type: 'reply', serial, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const audio = new PortAudioBackend(channel.port1, undefined, async () => {
    if (++factories === 2) throw new Error('Second source is corrupt')
    return decoder(async (position, frames) => { positions.push(position); return [new Float32Array(frames).fill(0.25)] })
  })
  try {
    const first = audio.command(opening(1, source(), () => { firstReleased++ }))
    const held = await observed(t.signal, installed.promise, first)
    assert.equal(mixer.inspectStreams().voices, 1)
    const second = audio.command(opening(1, source(), () => { secondReleased++ })),
      rejected = assert.rejects(second, /Second source is corrupt/)
    void rejected.catch(() => {})
    await turn()
    assert.equal(factories, 1, 'a new prepare must not retire the already installed, unacknowledged candidate')
    assert.equal(firstReleased, 0)
    channel.port2.postMessage({ type: 'reply', serial: held.serial, result: held.result })
    await first; await rejected
    assert.equal(factories, 2)
    assert.equal(firstReleased, 0)
    assert.equal(secondReleased, 1)
    await audio.command({ op: 'set', id: 1, property: 'position', value: 8192 })
    await audio.command({ op: 'play', id: 1 })
    mixer.render(new Float32Array(32), new Float32Array(32))
    const requests = mixer.takeStreamRequests()
    assert.ok(requests.length)
    assert.ok(requests.every((request) => request.streamId === held.streamId))
    for (const request of requests) channel.port2.postMessage({ type: 'streamRead', request })
    assert.equal((await observed(t.signal, refilled.promise)).streamId, held.streamId)
    const left = new Float32Array(32), right = new Float32Array(32)
    assert.deepEqual(mixer.render(left, right), [])
    assert.ok(left.every((sample) => sample === 0.25))
    assert.ok(positions.includes(8192))
  } finally { try { await audio.close() } finally { channel.port2.close() } }
  assert.equal(firstReleased, 1)
})

test('voice close bypasses a pending load ACK, cancels earlier waiters and lets a later open wait for that ACK', { timeout: 30000 }, async (t) => {
  const channel = new MessageChannel(), firstLoad = deferred<{ serial: number; streamId: number }>(),
    streamIds: number[] = [], released = [0, 0, 0], outcomes: Promise<unknown>[] = []
  let factories = 0
  channel.port2.onmessage = ({ data }: MessageEvent<AudioRequest>) => {
    const { serial, command } = data
    if (command.op === 'load' && command.asset.kind === 'stream') {
      streamIds.push(command.asset.streamId)
      if (streamIds.length === 1) { firstLoad.resolve({ serial, streamId: command.asset.streamId }); return }
    }
    channel.port2.postMessage({ type: 'reply', serial, result: { events: [] } })
  }
  const audio = new PortAudioBackend(channel.port1, undefined, async () => { factories++; return decoder() })
  try {
    const first = audio.command(opening(1, source(), () => { released[0]++ })),
      firstRejected = assert.rejects(first, /closed|superseded/)
    outcomes.push(firstRejected); void firstRejected.catch(() => {})
    const held = await observed(t.signal, firstLoad.promise, first)
    const earlier = audio.command(opening(1, source(), () => { released[1]++ })),
      earlierRejected = assert.rejects(earlier, /closed while awaiting publication/)
    outcomes.push(earlierRejected); void earlierRejected.catch(() => {})
    await observed(t.signal, audio.command({ op: 'close', id: 1 }))
    assert.equal(factories, 1)
    const later = audio.command(opening(1, source(), () => { released[2]++ }))
    outcomes.push(later); void later.catch(() => {})
    await turn()
    assert.equal(factories, 1, 'an open after close still waits for the old dispatched load to finish')
    channel.port2.postMessage({ type: 'reply', serial: held.serial, result: { events: [] } })
    await firstRejected; await earlierRejected; await later
    assert.equal(factories, 2, 'the request that arrived before close must never prepare a decoder')
    assert.equal(streamIds.length, 2)
    assert.notEqual(streamIds[1], held.streamId)
    assert.deepEqual(released, [1, 1, 0])
  } finally {
    try { await audio.close() }
    finally { channel.port2.close(); await Promise.allSettled(outcomes) }
  }
  assert.deepEqual(released, [1, 1, 1])
})

test('pool shutdown waits for a late factory and reports both decoder-close and lease-release failures', { timeout: 30000 }, async (t) => {
  const factoryGate = deferred<PcmSource>(), entered = deferred<void>(), order: string[] = []
  const pool = new PcmStreamPool(async () => { entered.resolve(); return factoryGate.promise })
  const pending = pool.prepare(opening(1, source(), () => { order.push('release'); throw new Error('lease release failed') }), () => {})
  const rejected = assert.rejects(pending, /opening and cleanup failed/)
  try {
    await observed(t.signal, entered.promise, pending)
    const closing = pool.close(), failed = assert.rejects(closing, (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      const nested = error.errors[0]
      assert.ok(nested instanceof AggregateError)
      assert.deepEqual(nested.errors.map((entry: Error) => entry.message), ['decoder close failed', 'lease release failed'])
      return true
    })
    await turn(); assert.deepEqual(order, [])
    factoryGate.resolve(decoder(undefined, async () => { order.push('decoder'); throw new Error('decoder close failed') }))
    await rejected; await failed
    assert.deepEqual(order, ['decoder', 'release'])
  } finally {
    factoryGate.resolve(decoder())
    // Both cleanup failures are the explicit subject of this test above.
    await Promise.allSettled([pool.close(), rejected])
  }
})
