import test from 'node:test'
import assert from 'node:assert/strict'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { StreamPcm, streamPageFrames, streamPcmReservation } from '../../src/engine/media/stream-pcm.ts'
import { defaultSoundSettings, type AudioEvent, type PcmAsset, type StreamingPcmAsset } from '../../src/engine/ports/audio.ts'

function pcm(length = 32768, channels = 2): PcmAsset {
  return { kind: 'pcm', sampleRate: 48000, sampleCount: length, channels, bits: 32,
    loops: { links: [], labels: [] },
    data: Array.from({ length: channels }, (_, channel) => Float32Array.from({ length },
      (_, frame) => 0.125 + ((frame + channel) % 31) / 64)) }
}
function streamed(asset: PcmAsset, initial = true, streamId = 1): StreamingPcmAsset {
  return { kind: 'stream', streamId, sampleRate: asset.sampleRate, sampleCount: asset.sampleCount,
    channels: asset.channels, bits: asset.bits, loops: structuredClone(asset.loops),
    initial: initial ? [{ position: 0, data: asset.data.map((data) => data.slice(0, streamPageFrames)) }] : [] }
}
function supply(mixer: AudioMixer, source: PcmAsset) {
  const requests = mixer.takeStreamRequests()
  for (const request of requests)
    mixer.command({ op: 'streamData', request,
      data: source.data.map((channel) => channel.slice(request.position, request.position + request.frames)) })
  return requests
}
function render(mixer: AudioMixer, frames = 1) {
  const left = new Float32Array(frames), right = new Float32Array(frames), events = mixer.render(left, right)
  return { left, right, events }
}

test('stream PCM keeps pages and requests bounded and rejects stale generations without consuming live requests', () => {
  const source = pcm(40 * streamPageFrames), cache = new StreamPcm(7, streamed(source, false))
  assert.equal(cache.ready(0, 5 * streamPageFrames), false)
  const first = cache.takeRequests()
  assert.equal(first.length, 4)
  assert.equal(cache.takeRequests().length, 0)
  cache.accept({ ...first[0]!, streamId: 9 }, source.data.map((channel) => channel.slice(0, streamPageFrames)))
  assert.equal(cache.inspect().pending, 4)
  for (const request of first)
    cache.accept(request, source.data.map((channel) => channel.slice(request.position, request.position + request.frames)))
  assert.equal(cache.ready(0, 4 * streamPageFrames), true)
  assert.equal(cache.sample(0, 17.5), (source.data[0]![17]! + source.data[0]![18]!) / 2)
  for (let page = 4; page < 40; page++) {
    cache.ready(page * streamPageFrames, streamPageFrames)
    for (const request of cache.takeRequests())
      cache.accept(request, source.data.map((channel) => channel.slice(request.position, request.position + request.frames)))
    assert(cache.inspect().pages <= 16)
    assert(cache.inspect().bytes <= streamPcmReservation(2))
  }
  assert.equal(cache.ready(0, 1), false, 'Initial pages are genuinely evicted rather than retained in asset metadata')
  assert.equal(cache.asset.initial.length, 0)
})

test('a starving stream leaves its source position and boundary labels unchanged while another voice plays', () => {
  const source = pcm(), mixer = new AudioMixer(48000)
  source.loops.labels.push({ position: 0, name: 'first' })
  mixer.command({ op: 'load', id: 1, asset: streamed(source, false), settings: defaultSoundSettings() })
  mixer.command({ op: 'load', id: 2, asset: { ...pcm(1000, 1), data: [new Float32Array(1000).fill(0.25)] }, settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 })
  mixer.command({ op: 'play', id: 2 })
  const held = render(mixer, 128)
  assert(held.left.every((value) => value === 0.25))
  assert.equal(mixer.snapshot(1).position, 0)
  assert.equal(mixer.snapshot(1).status, 'play')
  assert.equal(mixer.snapshot(2).position, 128)
  assert.deepEqual(held.events, [])
  assert.equal(supply(mixer, source).length, 1)
  const resumed = render(mixer)
  assert.equal(resumed.left[0], source.data[0]![0]! + 0.25)
  assert.deepEqual(resumed.events.filter((event) => event.type === 'label').map((event) => event.label), ['first'])
  assert.equal(mixer.snapshot(1).position, 1)
})

test('streamed source samples, smooth loops and flag labels match full PCM across page misses', () => {
  const source = pcm(32768), regular = new AudioMixer(48000), stream = new AudioMixer(48000)
  source.loops.links.push({ from: 24576, to: 12288, smooth: true, condition: 'no', variable: 0, reference: 0 })
  source.loops.labels.push({ position: 12288, name: 'target' }, { position: 16384, name: ':[0]++' })
  for (const [mixer, asset] of [[regular, source], [stream, streamed(source)]] as const) {
    mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
    mixer.command({ op: 'set', id: 1, property: 'position', value: 24000 })
    mixer.command({ op: 'play', id: 1 })
  }
  const referenceEvents: AudioEvent[] = [], streamEvents: AudioEvent[] = []
  for (let frame = 0; frame < 7000; frame++) {
    let actual = render(stream)
    for (let attempts = 0; actual.left[0] === 0 && stream.inspectStreams().pending && attempts < 8; attempts++) {
      assert.deepEqual(actual.events, [], 'A missing page cannot emit a boundary label')
      supply(stream, source)
      actual = render(stream)
    }
    const expected = render(regular)
    assert.deepEqual(actual.left, expected.left, `left source sample ${frame}`)
    assert.deepEqual(actual.right, expected.right, `right source sample ${frame}`)
    referenceEvents.push(...expected.events)
    streamEvents.push(...actual.events)
    supply(stream, source)
    assert(stream.inspectStreams().bytes <= streamPcmReservation(2))
  }
  assert.deepEqual(streamEvents, referenceEvents)
  assert.deepEqual(stream.snapshot(1), regular.snapshot(1))
})

test('a high-rate far jump waits before mixing or committing source and target labels', () => {
  const source = pcm(), regular = new AudioMixer(48000), stream = new AudioMixer(48000)
  source.loops.links.push({ from: 4094, to: 12288, smooth: false, condition: 'no', variable: 0, reference: 0 })
  source.loops.labels.push({ position: 4093, name: ':[1]++' },
    { position: 12288, name: 'target' }, { position: 12288, name: ':[0]++' })
  for (const [mixer, asset] of [[regular, source], [stream, streamed(source)]] as const) {
    mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
    mixer.command({ op: 'set', id: 1, property: 'position', value: 4093 })
    mixer.command({ op: 'set', id: 1, property: 'frequency', value: 192000 })
    mixer.command({ op: 'play', id: 1 })
  }
  const before = stream.snapshot(1)
  for (let retry = 0; retry < 2; retry++) {
    const held = render(stream, 128)
    assert(held.left.every((value) => value === 0))
    assert(held.right.every((value) => value === 0))
    assert.deepEqual(held.events, [], 'Neither current labels nor the far target may commit early')
    assert.deepEqual(stream.snapshot(1), before)
    assert.equal(stream.inspectStreams().pending, 1)
  }
  assert.deepEqual(supply(stream, source).map((request) => request.position), [12288])
  const resumed = render(stream), expected = render(regular)
  assert.deepEqual(resumed, expected)
  assert.equal(resumed.left[0], source.data[0]![4093])
  assert.deepEqual(resumed.events.filter((event) => event.type === 'label').map((event) => event.label),
    [':[1]++', 'target', ':[0]++'])
  assert.equal(stream.snapshot(1).position, 12291)
  assert.deepEqual(stream.snapshot(1).flags.slice(0, 2), [1, 1])
  assert.deepEqual(stream.snapshot(1), regular.snapshot(1))
  const following = render(stream)
  assert.deepEqual(following, render(regular))
  assert.deepEqual(following.events, [], 'Preflight and retry must not repeat either flag or label')
})

test('stream advance preflight keeps genuine EOF and its final boundary events identical to full PCM', () => {
  const source = pcm(4096, 1), regular = new AudioMixer(48000), stream = new AudioMixer(48000)
  source.loops.labels.push({ position: 4094, name: 'last-sample' }, { position: 4095, name: ':[0]++' })
  for (const [mixer, asset] of [[regular, source], [stream, streamed(source)]] as const) {
    mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
    mixer.command({ op: 'set', id: 1, property: 'position', value: 4094 })
    mixer.command({ op: 'set', id: 1, property: 'frequency', value: 192000 })
    mixer.command({ op: 'play', id: 1 })
  }
  const actual = render(stream)
  assert.deepEqual(actual, render(regular))
  assert.equal(actual.left[0], source.data[0]![4094])
  assert.deepEqual(actual.events.map((event) => event.type), ['label', 'label', 'ended'])
  assert.equal(stream.snapshot(1).position, 4096)
  assert.equal(stream.snapshot(1).status, 'stop')
  assert.equal(stream.snapshot(1).flags[0], 1)
  assert.deepEqual(stream.snapshot(1), regular.snapshot(1))
  assert.equal(stream.inspectStreams().pending, 0)
  assert.deepEqual(render(stream).events, [])
})

test('one streaming output step exceeding sixteen distinct jump pages fails before any label or sample commits', () => {
  const source = pcm(18 * streamPageFrames, 1), mixer = new AudioMixer(1000)
  for (let page = 0; page < 17; page++) {
    source.loops.links.push({ from: page * streamPageFrames + 1, to: (page + 1) * streamPageFrames,
      smooth: false, condition: 'no', variable: 0, reference: 0 })
    source.loops.labels.push({ position: page * streamPageFrames, name: ':[0]++' })
  }
  mixer.command({ op: 'load', id: 1, asset: streamed(source), settings: defaultSoundSettings() })
  mixer.command({ op: 'set', id: 1, property: 'frequency', value: 384000 })
  mixer.command({ op: 'play', id: 1 })
  const failed = render(mixer, 128)
  assert(failed.left.every((sample) => sample === 0))
  assert(failed.right.every((sample) => sample === 0))
  assert.deepEqual(failed.events, [{ type: 'error',
    message: 'PCM stream output-step page budget exceeds 16 distinct pages' }])
  assert.equal(mixer.snapshot(1).status, 'stop')
  assert.equal(mixer.snapshot(1).position, 0)
  assert.equal(mixer.snapshot(1).flags[0], 0)
  // The first missing page and four-request cap cannot hide the later 17th
  // distinct page from the same preflight, even before any reply is supplied.
  assert.equal(mixer.inspectStreams().pending, 4)
  assert.deepEqual(supply(mixer, source).map((request) => request.position),
    [4096, 8192, 12288, 16384])
  const late = render(mixer, 128)
  assert(late.left.every((sample) => sample === 0))
  assert(late.right.every((sample) => sample === 0))
  assert.deepEqual(late.events, [], 'Late replies cannot repeat the error or publish simulated labels')
  assert.equal(mixer.snapshot(1).status, 'stop')
  assert.equal(mixer.snapshot(1).position, 0)
  assert.equal(mixer.snapshot(1).flags[0], 0)
  assert.equal(mixer.inspectStreams().pending, 0)
  assert(mixer.inspectStreams().bytes <= streamPcmReservation(1))
})

test('sixteen distinct jump pages fit one output step across bounded refill batches', () => {
  const source = pcm(16 * streamPageFrames, 1), regular = new AudioMixer(1000), stream = new AudioMixer(1000)
  for (let page = 0; page < 16; page++) {
    if (page < 15) source.loops.links.push({ from: page * streamPageFrames + 1, to: (page + 1) * streamPageFrames,
      smooth: false, condition: 'no', variable: 0, reference: 0 })
    source.loops.labels.push({ position: page * streamPageFrames, name: ':[0]++' })
  }
  for (const [mixer, asset] of [[regular, source], [stream, streamed(source)]] as const) {
    mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
    mixer.command({ op: 'set', id: 1, property: 'frequency', value: 16000 })
    mixer.command({ op: 'play', id: 1 })
  }
  const before = stream.snapshot(1), batches: number[] = []
  for (let retry = 0; retry < 4; retry++) {
    const held = render(stream)
    assert.equal(held.left[0], 0)
    assert.deepEqual(held.events, [])
    assert.deepEqual(stream.snapshot(1), before)
    batches.push(supply(stream, source).length)
  }
  assert.deepEqual(batches, [4, 4, 4, 3])
  const resumed = render(stream)
  assert.deepEqual(resumed, render(regular))
  assert.equal(resumed.left[0], source.data[0]![0])
  assert.equal(resumed.events.length, 16)
  assert.equal(stream.snapshot(1).flags[0], 16)
  assert.equal(stream.snapshot(1).position, 15 * streamPageFrames + 1)
  assert.deepEqual(stream.snapshot(1), regular.snapshot(1))
  assert.equal(stream.inspectStreams().pending, 0)
  assert.equal(stream.inspectStreams().bytes, streamPcmReservation(1))
})

test('stream close and replacement ignore late PCM and preserve the replacement voice', () => {
  const source = pcm(), mixer = new AudioMixer(48000)
  mixer.command({ op: 'load', id: 1, asset: streamed(source, false, 1), settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 })
  render(mixer)
  const old = mixer.takeStreamRequests()[0]!
  mixer.command({ op: 'close', id: 1 })
  mixer.command({ op: 'load', id: 1, asset: streamed(source, true, 2), settings: defaultSoundSettings() })
  mixer.command({ op: 'streamData', request: old, data: source.data.map(() => new Float32Array(streamPageFrames).fill(-0.5)) })
  mixer.command({ op: 'play', id: 1 })
  assert.equal(render(mixer).left[0], source.data[0]![0])
  mixer.command({ op: 'shutdown' })
  mixer.command({ op: 'streamData', request: old, error: 'late retired decoder failure' })
  assert.deepEqual(mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
})

test('stream working sets share the existing 128MiB PCM budget before a voice is replaced', () => {
  const source = pcm(1, 8), mixer = new AudioMixer(48000)
  // Metadata represents arbitrarily long audio without allocating that PCM.
  const asset = { ...streamed(source, false), sampleCount: 48000 * 60 * 60 }
  for (let id = 1; id <= 64; id++)
    mixer.command({ op: 'load', id, asset: { ...asset, streamId: id }, settings: defaultSoundSettings() })
  assert.equal(mixer.inspectStreams().reservedBytes, 128 * 1024 * 1024)
  assert.throws(() => mixer.command({ op: 'load', id: 65, asset: { ...asset, streamId: 65 }, settings: defaultSoundSettings() }), /128 MiB/)
  assert.equal(mixer.inspect().voices, 64)
  mixer.command({ op: 'close', id: 1 })
  mixer.command({ op: 'load', id: 65, asset: { ...asset, streamId: 65 }, settings: defaultSoundSettings() })
  assert.equal(mixer.inspectStreams().bytes, 0)
})

test('stream decode failure is reported once rather than looping or declaring natural EOF', () => {
  const source = pcm(), mixer = new AudioMixer(48000)
  mixer.command({ op: 'load', id: 1, asset: streamed(source, false), settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 })
  render(mixer)
  const request = mixer.takeStreamRequests()[0]!
  mixer.command({ op: 'streamData', request, error: 'range read failed' })
  const failed = render(mixer, 128)
  assert.deepEqual(failed.events, [{ type: 'error', message: 'range read failed' }])
  assert.equal(mixer.snapshot(1).status, 'stop')
  assert.deepEqual(render(mixer, 128).events, [])
})
