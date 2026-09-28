import test from 'node:test'
import assert from 'node:assert/strict'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { WaveSegmentQueue } from '../../src/engine/media/audio-segments.ts'
import { FilteredWaveSource } from '../../src/engine/media/filtered-wave-source.ts'
import { newAudioFilterBudget, readFilterInput } from '../../src/engine/media/audio-filter-chain.ts'
import {
  defaultSoundSettings,
  type AudioEvent,
  type PcmAsset,
  type PhaseVocoderFilter,
} from '../../src/engine/ports/audio.ts'

const filter = (id = 1, parameters: Partial<PhaseVocoderFilter> = {}): PhaseVocoderFilter => ({
  type: 'phase-vocoder',
  id,
  window: 256,
  overlap: 4,
  pitch: 1,
  time: 1,
  ...parameters,
})
const pcm = (length = 48000, channels = 1, rate = 48000): PcmAsset => ({
  kind: 'pcm',
  channels,
  sampleRate: rate,
  sampleCount: length,
  bits: 16,
  data: Array.from({ length: channels }, (_, channel) =>
    Float32Array.from(
      { length },
      (_, i) => 0.1 * Math.sin((2 * Math.PI * (300 + channel * 200) * i) / rate),
    ),
  ),
  loops: { labels: [], links: [] },
})
function open(asset = pcm(), filters: PhaseVocoderFilter[] = [filter()], rate = asset.sampleRate) {
  const mixer = new AudioMixer(rate)
  mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings(), filters })
  mixer.command({ op: 'play', id: 1 })
  return mixer
}
function render(mixer: AudioMixer, frames: number) {
  const left = new Float32Array(frames),
    right = new Float32Array(frames)
  return { left, right, events: mixer.render(left, right) }
}
function finish(mixer: AudioMixer, maximum = 100000) {
  const left: number[] = [],
    right: number[] = [],
    events: AudioEvent[] = []
  while (mixer.snapshot(1).status === 'play' && left.length < maximum) {
    const output = render(mixer, 128)
    left.push(...output.left)
    right.push(...output.right)
    events.push(...output.events)
  }
  assert.equal(mixer.snapshot(1).status, 'stop', 'bounded stream reaches EOF')
  assert.deepEqual(
    events.filter((event) => event.type === 'error'),
    [],
  )
  assert.equal(events.filter((event) => event.type === 'ended').length, 1)
  return { left, right, events }
}
function frequency(samples: readonly number[] | Float32Array, rate: number) {
  let first = -1,
    last = -1,
    crossings = 0
  for (let i = 1025; i < Math.min(samples.length, 16000); i++)
    if (samples[i - 1]! <= 0 && samples[i]! > 0) {
      const at = i - samples[i]! / (samples[i]! - samples[i - 1]!)
      if (first < 0) first = at
      last = at
      crossings++
    }
  assert.ok(crossings > 20, 'the real filtered signal has a stable audible tone')
  return ((crossings - 1) * rate) / (last - first)
}

test('wave segment scaling uses cumulative ends, preserves discontinuities and retains boundary labels', () => {
  const queue = new WaveSegmentQueue(),
    first = new WaveSegmentQueue(),
    second = new WaveSegmentQueue()
  queue.appendSegment({ start: 100, length: 3, filteredLength: 3 })
  queue.appendSegment({ start: 20, length: 4, filteredLength: 4 })
  queue.appendLabel('boundary', 3)
  queue.appendLabel('end', 7)
  queue.scale(10)
  assert.equal(queue.positionAt(0), 100)
  assert.equal(queue.positionAt(3), 102)
  assert.equal(queue.positionAt(4), 20)
  assert.equal(queue.positionAt(9), 23)
  queue.take(4, first)
  const firstLabels: string[] = []
  first.emitThrough(4, true, (label) => firstLabels.push(label.name))
  assert.deepEqual(firstLabels, [])
  queue.take(6, second)
  const secondLabels: Array<[string, number]> = []
  second.emitThrough(6, true, (label) => secondLabels.push([label.name, label.offset]))
  assert.deepEqual(secondLabels, [['boundary', 0]])
  const finalLabels: string[] = []
  queue.emitThrough(0, true, (label) => finalLabels.push(label.name))
  assert.deepEqual(finalLabels, ['end'])

  // Fixed WaveSegmentQueue::Scale calculates double ratio = 2 / 49 first.
  // Its rounded ratio puts label 49 at 1 after truncation, while reassociating
  // the expression as (49 * 2) / 49 incorrectly leaves it at output offset 2.
  const rounded = new WaveSegmentQueue(),
    roundedLabels: Array<[string, number]> = []
  rounded.appendSegment({ start: 0, length: 49, filteredLength: 49 })
  rounded.appendLabel('ratio-first', 49)
  rounded.scale(2)
  assert.equal(rounded.length, 2)
  assert.equal(rounded.positionAt(2), 49, 'segment endpoint scaling remains independent')
  rounded.emitThrough(1, false, (label) => roundedLabels.push([label.name, label.offset]))
  assert.deepEqual(roundedLabels, [], 'the scaled label remains at its exact boundary')
  rounded.emitThrough(1, true, (label) => roundedLabels.push([label.name, label.offset]))
  assert.deepEqual(roundedLabels, [['ratio-first', 1]])
})

test('wave segment partial dequeue truncates source lengths and supports repeated loop positions', () => {
  const queue = new WaveSegmentQueue(),
    part = new WaveSegmentQueue()
  queue.appendSegment({ start: 100, length: 7, filteredLength: 10 })
  queue.appendSegment({ start: 100, length: 7, filteredLength: 10 })
  queue.take(3, part)
  assert.equal(part.positionAt(3), 102)
  assert.equal(queue.positionAt(0), 102)
  assert.equal(queue.positionAt(7), 100)
  queue.take(7, part)
  assert.equal(part.positionAt(7), 107)
  assert.equal(queue.positionAt(0), 100)
})

for (const [time, pitch, playbackFrequency] of [
  [0.5, 1, 48000],
  [1.5, 1, 48000],
  [1, 1.5, 24000],
] as const)
  test(`real filter audio keeps time ${time}, pitch ${pitch} and playback frequency ${playbackFrequency} independent`, () => {
    const mixer = open(pcm(), [filter(1, { time, pitch })])
    mixer.command({ op: 'set', id: 1, property: 'frequency', value: playbackFrequency })
    const output = finish(mixer, 110000),
      ratio = (time * 48000) / playbackFrequency
    assert.ok(output.left.length >= 48000 * ratio - 2048)
    assert.ok(output.left.length <= 48000 * ratio + 256)
    assert.ok(
      Math.abs(frequency(output.left, 48000) - (300 * pitch * playbackFrequency) / 48000) < 8,
    )
    assert.equal(mixer.snapshot(1).bits, 32)
    assert.equal(mixer.snapshot(1).sampleCount, 48000)
  })

test('source expression flags can change during lookahead while labels and position wait for output', () => {
  const asset = pcm(10000)
  asset.loops.labels = [
    { position: 128, name: ':[0]++' },
    { position: 128, name: 'same' },
    { position: 256, name: 'later' },
  ]
  const mixer = open(asset, [filter(1, { window: 512 })])
  const first = render(mixer, 1)
  assert.equal(mixer.snapshot(1).flags[0], 1, 'decode already evaluated the expression')
  assert.equal(mixer.snapshot(1).position, 1, 'snapshot is not the pre-read cursor')
  assert.deepEqual(first.events, [], 'pre-read labels do not become audible callbacks')
  const before = render(mixer, 127)
  assert.deepEqual(before.events, [])
  const at = render(mixer, 1).events.filter((event) => event.type === 'label')
  assert.deepEqual(
    at.map((event) => [event.label, event.snapshot.position]),
    [
      [':[0]++', 128],
      ['same', 128],
    ],
  )
  assert.equal(mixer.snapshot(1).position, 129)
})

test('SLI conditions operate before the ordered filter chain without resetting phases at loops', () => {
  const asset = pcm(4096)
  asset.loops.labels = [
    { position: 48, name: ':[0]++' },
    { position: 64, name: 'mark' },
  ]
  asset.loops.links = [
    { from: 96, to: 32, smooth: true, condition: 'lt', variable: 0, reference: 3 },
  ]
  const mixer = open(asset, [filter(1, { window: 64 }), filter(2, { window: 128, pitch: 1.2 })])
  const output = finish(mixer, 10000)
  assert.equal(mixer.snapshot(1).flags[0], 3)
  assert.deepEqual(
    output.events.filter((event) => event.type === 'label').map((event) => event.label),
    [':[0]++', 'mark', ':[0]++', 'mark', ':[0]++', 'mark'],
  )
  assert.ok(output.left.some((sample) => Math.abs(sample) > 0.01))
})

test('seek discards old buffered samples and labels even while individually paused', () => {
  const asset = pcm(12000)
  asset.data[0]!.fill(0, 6000)
  asset.loops.labels = [
    { position: 200, name: 'old' },
    { position: 6500, name: 'new' },
  ]
  const mixer = open(asset, [filter(1, { time: 1.5 })])
  render(mixer, 1)
  mixer.command({ op: 'set', id: 1, property: 'paused', value: true })
  const epoch = mixer.snapshot(1).epoch
  mixer.command({ op: 'set', id: 1, property: 'position', value: 6000 })
  assert.ok(mixer.snapshot(1).epoch > epoch)
  assert.ok(render(mixer, 512).left.every((sample) => sample === 0))
  mixer.command({ op: 'set', id: 1, property: 'paused', value: false })
  const output = finish(mixer, 15000)
  assert.ok(
    output.left.every((sample) => sample === 0),
    'no pre-seek overlap or cached PCM survives',
  )
  assert.deepEqual(
    output.events.filter((event) => event.type === 'label').map((event) => event.label),
    ['new'],
  )
})

test('pause preserves filter phase and fade remains on the output wall clock', () => {
  const a = open(pcm()),
    b = open(pcm())
  assert.deepEqual(render(a, 512).left, render(b, 512).left)
  a.command({ op: 'set', id: 1, property: 'paused', value: true })
  assert.ok(render(a, 1024).left.every((sample) => sample === 0))
  a.command({ op: 'set', id: 1, property: 'paused', value: false })
  assert.deepEqual(render(a, 512).left, render(b, 512).left)
  a.command({ op: 'set', id: 1, property: 'paused', value: true })
  a.command({ op: 'fade', id: 1, target: 0, time: 120, delay: 0 })
  render(a, 5760)
  assert.equal(a.snapshot(1).volume, 0)
  a.command({ op: 'fade', id: 1, target: 100000, time: 120, delay: 0 })
  a.command({ op: 'pauseAll', paused: true })
  render(a, 5760)
  assert.equal(a.snapshot(1).volume, 0)
  a.command({ op: 'pauseAll', paused: false })
  render(a, 5760)
  assert.equal(a.snapshot(1).volume, 100000)
})

test('stop and replay reset phases; a new window takes effect only on that reset', () => {
  const asset = pcm(16000),
    changed = open(asset, [filter(1, { window: 64 })])
  render(changed, 512)
  changed.command({ op: 'filters', id: 1, filters: [filter(1, { window: 1024 })] })
  changed.command({ op: 'stop', id: 1 })
  changed.command({ op: 'play', id: 1 })
  const fresh = open(asset, [filter(1, { window: 1024 })])
  assert.deepEqual(render(changed, 2048).left, render(fresh, 2048).left)
  changed.command({ op: 'stop', id: 1 })
  changed.command({ op: 'filters', id: 1, filters: [filter(1, { window: 64 })] })
  changed.command({ op: 'play', id: 1 })
  const small = open(asset, [filter(1, { window: 64 })])
  assert.deepEqual(render(changed, 1024).left, render(small, 1024).left)
})

test('active window updates preserve current PCM and phase until reset', () => {
  const asset = pcm(20000),
    a = open(asset, [filter(1, { window: 256 })]),
    b = open(asset, [filter(1, { window: 256 })])
  render(a, 512)
  render(b, 512)
  a.command({ op: 'filters', id: 1, filters: [filter(1, { window: 4096 })] })
  assert.deepEqual(render(a, 4096).left, render(b, 4096).left)
})

test('dynamic pitch changes affect future decoded audio while retaining already buffered audio', () => {
  const mixer = open(pcm(48000))
  render(mixer, 2048)
  mixer.command({ op: 'filters', id: 1, filters: [filter(1, { pitch: 2 })] })
  const output = render(mixer, 16000)
  assert.deepEqual(
    output.events.filter((event) => event.type === 'error'),
    [],
  )
  assert.ok(Math.abs(frequency(output.left.subarray(2048), 48000) - 600) < 8)
})

test('filter chains process all source channels before stereo downmix', () => {
  const asset = pcm(12000, 6),
    mixer = open(asset, [filter(1, { pitch: 1.25 })])
  const whole = render(mixer, 10000)
  const isolated: Float32Array[] = []
  for (let channel = 0; channel < 6; channel++) {
    const one: PcmAsset = { ...asset, channels: 1, data: [asset.data[channel]!] }
    isolated.push(render(open(one, [filter(1, { pitch: 1.25 })]), 10000).left)
  }
  for (let i = 0; i < whole.left.length; i++) {
    const left = isolated[0]![i]! + (isolated[2]![i]! + isolated[4]![i]!) * 0.70710678
    const right = isolated[1]![i]! + (isolated[2]![i]! + isolated[5]![i]!) * 0.70710678
    assert.ok(Math.abs(whole.left[i]! - left) < 1e-6)
    assert.ok(Math.abs(whole.right[i]! - right) < 1e-6)
  }
})

test('invalid replacements and connected filter identities fail before changing the active voice', () => {
  const mixer = open(pcm(4096)),
    before = mixer.snapshot(1)
  assert.throws(() => mixer.command({ op: 'filters', id: 1, filters: [filter(2)] }), /order/)
  assert.throws(
    () =>
      mixer.command({
        op: 'load',
        id: 1,
        asset: pcm(4096),
        settings: defaultSoundSettings(),
        filters: [filter(2, { time: 0 })],
      }),
    /positive/,
  )
  assert.deepEqual(mixer.snapshot(1), before)
  assert.throws(
    () =>
      mixer.command({
        op: 'load',
        id: 2,
        asset: pcm(4096),
        settings: defaultSoundSettings(),
        filters: [filter(1)],
      }),
    /already connected/,
  )
  mixer.command({ op: 'close', id: 1 })
  mixer.command({
    op: 'load',
    id: 2,
    asset: pcm(4096),
    settings: defaultSoundSettings(),
    filters: [filter(1)],
  })
  assert.equal(mixer.snapshot(2).status, 'stop')
})

test('session stage reservations reject a seventeenth connected filter without allocating its DSP', () => {
  const mixer = new AudioMixer(48000),
    asset = pcm(64)
  for (let id = 1; id <= 16; id++)
    mixer.command({
      op: 'load',
      id,
      asset,
      settings: defaultSoundSettings(),
      filters: [filter(id, { window: 64 })],
    })
  assert.throws(
    () =>
      mixer.command({
        op: 'load',
        id: 17,
        asset,
        settings: defaultSoundSettings(),
        filters: [filter(17, { window: 64 })],
      }),
    /session budget/,
  )
  assert.equal(mixer.inspect().voices, 16)
  mixer.command({ op: 'close', id: 1 })
  mixer.command({
    op: 'load',
    id: 17,
    asset,
    settings: defaultSoundSettings(),
    filters: [filter(17, { window: 64 })],
  })
  assert.equal(mixer.inspect().voices, 16)
})

test('each render receives a fresh source budget during long looping playback', () => {
  const mixer = open(pcm(4096), [filter(1, { window: 64 })])
  mixer.command({ op: 'set', id: 1, property: 'looping', value: true })
  for (let i = 0; i < 2200; i++) {
    const output = render(mixer, 128)
    assert.deepEqual(
      output.events.filter((event) => event.type === 'error'),
      [],
    )
  }
  assert.equal(mixer.snapshot(1).status, 'play')
  assert.equal(mixer.frames, 281600)
})

test('a bounded processing-budget failure stops that voice and leaves ordinary audio alive', () => {
  const mixer = open(pcm(4096), [
    filter(1, { window: 64, overlap: 2, time: 0.0625 }),
    filter(2, { window: 64, overlap: 2, time: 0.0625 }),
  ])
  mixer.command({ op: 'set', id: 1, property: 'looping', value: true })
  const healthy = pcm(4096)
  healthy.data[0]!.fill(0.25)
  mixer.command({ op: 'load', id: 2, asset: healthy, settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 2 })
  const output = render(mixer, 128)
  assert.equal(output.events.filter((event) => event.type === 'error').length, 1)
  assert.match(output.events.find((event) => event.type === 'error')!.message, /budget/)
  assert.equal(mixer.snapshot(1).status, 'stop')
  assert.equal(mixer.snapshot(2).status, 'play')
  assert.ok(output.left.every((sample) => sample === 0.25))
})

for (const length of [1, 37, 625])
  test(`short filtered source of ${length} samples terminates without a synthetic EOF drain`, () => {
    const mixer = open(pcm(length), [filter(1, { window: 256 })])
    const output = finish(mixer, 2048)
    assert.ok(output.left.length <= length + 256)
  })

test('natural filtered EOF rewinds the decoder for replay without exposing pre-read position', () => {
  const asset = pcm(4096)
  asset.loops.labels = [{ position: 0, name: 'begin' }]
  const mixer = open(asset)
  const first = finish(mixer, 10000)
  assert.deepEqual(
    first.events.filter((event) => event.type === 'label').map((event) => event.label),
    ['begin'],
  )
  assert.equal(mixer.snapshot(1).position, 0, 'native natural EOF clears the public sample cursor')
  assert.equal(first.events.find((event) => event.type === 'ended')!.snapshot.position, 0)
  mixer.command({ op: 'play', id: 1 })
  const again = finish(mixer, 10000)
  assert.deepEqual(again.left, first.left)
  assert.deepEqual(
    again.events.filter((event) => event.type === 'label').map((event) => event.label),
    ['begin'],
  )
  mixer.command({ op: 'set', id: 1, property: 'position', value: 1024 })
  mixer.command({ op: 'play', id: 1 })
  assert.equal(
    mixer.snapshot(1).position,
    1024,
    'an explicit post-EOF seek cancels the rewind marker',
  )
  assert.deepEqual(
    render(mixer, 128).events.filter((event) => event.type === 'label'),
    [],
  )
})

test('two real vocoders preserve ordered spectral processing instead of multiplying parameters', () => {
  const asset = pcm(16000)
  for (let i = 0; i < asset.sampleCount; i++)
    asset.data[0]![i] =
      0.03 * Math.sin((2 * Math.PI * 300 * i) / 48000) +
      0.05 * Math.sin((2 * Math.PI * 16000 * i) / 48000)
  const up = filter(1, { window: 512, pitch: 2 }),
    down = filter(2, { window: 512, pitch: 0.5 })
  const firstUp = render(open(asset, [up, down]), 10000).left
  const firstDown = render(open(asset, [down, up]), 10000).left
  const amplitude = (samples: Float32Array) => {
    let re = 0,
      im = 0
    for (let i = 2048; i < 8192; i++) {
      re += samples[i]! * Math.cos((2 * Math.PI * 16000 * i) / 48000)
      im += samples[i]! * Math.sin((2 * Math.PI * 16000 * i) / 48000)
    }
    return (2 * Math.hypot(re, im)) / (8192 - 2048)
  }
  const retained = amplitude(firstDown),
    removed = amplitude(firstUp)
  assert.ok(retained > 0.01, `down/up retained high tone: ${retained}`)
  assert.ok(
    removed < retained * 0.25,
    `up/down removes bins past Nyquist: ${removed} vs ${retained}`,
  )
})

test('multiple filter stages scale labels and audible source position independently at each hop', () => {
  const asset = pcm(12000)
  asset.loops.labels = [{ position: 512, name: 'scaled' }]
  const mixer = open(asset, [filter(1, { time: 1.5 }), filter(2, { window: 128, time: 0.5 })])
  const first = render(mixer, 384)
  assert.deepEqual(
    first.events.filter((event) => event.type === 'label'),
    [],
  )
  assert.equal(mixer.snapshot(1).position, 512)
  const at = render(mixer, 1).events.filter((event) => event.type === 'label')
  assert.deepEqual(
    at.map((event) => [event.label, event.snapshot.position]),
    [['scaled', 512]],
  )
})

test('source-control work is bounded independently of FFT and decoded-frame budgets', () => {
  const asset = pcm(8192)
  asset.loops.links = Array.from({ length: 1024 }, (_, index) => ({
    from: 1,
    to: 0,
    smooth: false,
    condition: index === 1023 ? ('no' as const) : ('eq' as const),
    variable: 0,
    reference: 1,
  }))
  asset.loops.labels = [{ position: 0, name: ':[0]=0' }]
  const mixer = open(asset, [filter(1, { window: 1024 })])
  const output = render(mixer, 128)
  assert.equal(mixer.snapshot(1).status, 'stop')
  const errors = output.events.filter((event) => event.type === 'error')
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /source-control budget/)
})

test('dense pre-read labels stop at the explicit metadata bound before growing without limit', () => {
  const asset = pcm(4096)
  asset.loops.labels = Array.from({ length: 4097 }, (_, index) => ({
    position: 0,
    name: `same-${index}`,
  }))
  const mixer = open(asset)
  const output = render(mixer, 128)
  const errors = output.events.filter((event) => event.type === 'error')
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /label budget/)
  assert.equal(mixer.snapshot(1).status, 'stop')
})

test('filtered source freezes a Decode request before a label makes an earlier link eligible', () => {
  const asset = pcm(128),
    flags = Array<number>(16).fill(0),
    budget = newAudioFilterBudget(128)
  asset.data[0] = Float32Array.from({ length: 128 }, (_, frame) => frame / 128)
  asset.loops.labels = [{ position: 4, name: ':[0]++' }]
  asset.loops.links = [
    { from: 8, to: 32, smooth: false, condition: 'eq', variable: 0, reference: 1 },
  ]
  const source = new FilteredWaveSource(
      asset,
      0,
      flags,
      () => false,
      () => budget,
    ),
    data = [new Float32Array(16)],
    segments = new WaveSegmentQueue()
  assert.equal(source.read(data, 16, segments), 16)
  assert.deepEqual(
    Array.from(data[0]!),
    Array.from({ length: 16 }, (_, frame) => frame / 128),
  )
  assert.equal(flags[0], 1)
  assert.equal(source.position, 16)
  assert.equal(segments.positionAt(8), 8, 'the committed source span did not jump to sample 32')
  const labels: Array<[string, number]> = []
  segments.emitThrough(16, false, (label) => labels.push([label.name, label.offset]))
  assert.deepEqual(labels, [[':[0]++', 4]])
  segments.clear()
  assert.equal(source.read(data, 16, segments), 16)
  assert.deepEqual(
    Array.from(data[0]!),
    Array.from({ length: 16 }, (_, frame) => (16 + frame) / 128),
  )
  assert.equal(segments.positionAt(0), 16, 'the next request never searches links behind its start')
  assert.equal(segments.positionAt(16), 32)

  const mixer = open(asset, [filter(1, { window: 64, overlap: 4 })])
  const first = render(mixer, 8)
  assert.equal(mixer.snapshot(1).position, 8)
  assert.deepEqual(
    first.events
      .filter((event) => event.type === 'label')
      .map((event) => [event.label, event.snapshot.position]),
    [[':[0]++', 4]],
  )
})

test('filtered source takes new flag values at the next unit without changing the preceding PCM', () => {
  const asset = pcm(128),
    flags = Array<number>(16).fill(0),
    budget = newAudioFilterBudget(128)
  asset.data[0] = Float32Array.from({ length: 128 }, (_, frame) => frame / 128)
  asset.loops.labels = [{ position: 4, name: ':[0]++' }]
  asset.loops.links = [
    { from: 8, to: 32, smooth: false, condition: 'eq', variable: 0, reference: 1 },
  ]
  const source = new FilteredWaveSource(
      asset,
      0,
      flags,
      () => false,
      () => budget,
    ),
    data = [new Float32Array(8)],
    segments = new WaveSegmentQueue()
  assert.equal(source.read(data, 8, segments), 8)
  assert.deepEqual(
    Array.from(data[0]!),
    Array.from({ length: 8 }, (_, frame) => frame / 128),
  )
  assert.equal(source.position, 8)
  segments.clear()
  assert.equal(source.read(data, 8, segments), 8)
  assert.deepEqual(
    Array.from(data[0]!),
    Array.from({ length: 8 }, (_, frame) => (32 + frame) / 128),
  )
  assert.equal(segments.positionAt(0), 32)
  assert.equal(segments.positionAt(8), 40)
})

test('filtered source preserves requested EOF metadata and truncates fractional sample seeks', () => {
  const asset = pcm(53, 1, 44100),
    flags = Array<number>(16).fill(0),
    budget = newAudioFilterBudget(128),
    source = new FilteredWaveSource(
      asset,
      44.1,
      flags,
      () => false,
      () => budget,
    ),
    data = [new Float32Array(16)],
    segments = new WaveSegmentQueue()
  assert.equal(source.position, 44)
  assert.equal(source.read(data, 16, segments), 9)
  assert.deepEqual(data[0]!.subarray(0, 9), asset.data[0]!.subarray(44, 53))
  assert.equal(source.position, 53)
  assert.equal(
    segments.length,
    16,
    'native queues the request unit before the decoder returns a short read',
  )
  assert.equal(segments.positionAt(0), 44)
  assert.equal(segments.positionAt(16), 60)
  const mixer = open(asset, [filter(1, { window: 64 })])
  mixer.command({ op: 'set', id: 1, property: 'position', value: 44.1 })
  const output = finish(mixer, 512)
  assert.deepEqual(
    output.events.filter((event) => event.type === 'error'),
    [],
  )
  assert.equal(mixer.snapshot(1).position, 0)
})

test('filtered source preserves a two-part smooth crossfade across read and flag changes', () => {
  const asset = pcm(64, 1, 1000),
    flags = Array<number>(16).fill(0),
    budget = newAudioFilterBudget(128)
  asset.data[0] = Float32Array.from({ length: 64 }, (_, frame) => frame / 128)
  asset.loops.links = [
    { from: 32, to: 8, smooth: true, condition: 'eq', variable: 0, reference: 0 },
  ]
  const source = new FilteredWaveSource(
      asset,
      24,
      flags,
      () => false,
      () => budget,
    ),
    data = [new Float32Array(16)],
    segments = new WaveSegmentQueue()
  assert.equal(source.read(data, 16, segments), 16)
  for (let frame = 0; frame < 16; frame++) {
    const blend = frame < 8 ? (frame / 8) * 0.5 : 0.5 + ((frame - 8) / 24) * 0.5
    const expected = Math.fround(((24 + frame) / 128) * (1 - blend) + (frame / 128) * blend)
    assert.equal(data[0]![frame], expected)
  }
  assert.equal(segments.positionAt(0), 24)
  assert.equal(segments.positionAt(8), 8)
  assert.equal(source.position, 16)
  flags[0] = 1
  segments.clear()
  assert.equal(source.read(data, 16, segments), 16)
  for (let frame = 0; frame < 16; frame++) {
    const progress = 16 + frame,
      blend = 0.5 + ((progress - 8) / 24) * 0.5
    assert.equal(
      data[0]![frame],
      Math.fround(((24 + progress) / 128) * (1 - blend) + (progress / 128) * blend),
    )
  }
  assert.equal(source.position, 32)
  assert.equal(segments.positionAt(0), 16)
  assert.equal(segments.positionAt(16), 32)
})

test('cancelling a smooth link before its jump preserves the already advanced decoder cursor', () => {
  const asset = pcm(64, 1, 1000),
    flags = Array<number>(16).fill(0),
    budget = newAudioFilterBudget(128)
  asset.data[0] = Float32Array.from({ length: 64 }, (_, frame) => frame / 128)
  asset.loops.links = [
    { from: 32, to: 8, smooth: true, condition: 'eq', variable: 0, reference: 0 },
  ]
  const source = new FilteredWaveSource(
      asset,
      24,
      flags,
      () => false,
      () => budget,
    ),
    data = [new Float32Array(28)],
    segments = new WaveSegmentQueue()
  assert.equal(source.read(data, 4, segments), 4)
  assert.equal(source.position, 28)
  flags[0] = 1
  segments.clear()
  assert.equal(source.read(data, 28, segments), 28)
  assert.equal(source.position, 56, 'the disabled link never changed logical source position')
  segments.clear()
  assert.equal(source.read(data, 1, segments), 1)
  assert.equal(data[0]![0], 32 / 128, 'PCM resumes after the target-side crossfade read')
  assert.equal(
    segments.positionAt(0),
    56,
    'logical segment position remains independent of decoder pre-read',
  )
  assert.equal(source.position, 57)
})

test('a wrapped native input-ring hop preserves two distinct conditional-link Decode requests', () => {
  const asset = pcm(128),
    flags = Array<number>(16).fill(0),
    budget = newAudioFilterBudget(128)
  asset.data[0] = Float32Array.from({ length: 128 }, (_, frame) => frame / 128)
  asset.loops.labels = [
    { position: 4, name: ':[0]++' },
    { position: 65, name: 'second-fragment' },
  ]
  asset.loops.links = [
    { from: 16, to: 64, smooth: false, condition: 'eq', variable: 0, reference: 1 },
  ]
  const source = new FilteredWaveSource(
      asset,
      0,
      flags,
      () => false,
      () => budget,
    ),
    data = [new Float32Array(32)],
    segments = new WaveSegmentQueue()
  // N64's original 4N ring at 240 splits an enlarged Hi32 into 16 + 16.
  assert.equal(readFilterInput(source, data, 32, 240, 256, segments), 32)
  assert.deepEqual(Array.from(data[0]!), [
    ...Array.from({ length: 16 }, (_, frame) => frame / 128),
    ...Array.from({ length: 16 }, (_, frame) => (64 + frame) / 128),
  ])
  assert.equal(segments.positionAt(0), 0)
  assert.equal(segments.positionAt(16), 64)
  assert.equal(segments.positionAt(32), 80)
  assert.equal(source.position, 80)
  const labels: Array<[string, number]> = []
  segments.emitThrough(32, false, (label) => labels.push([label.name, label.offset]))
  assert.deepEqual(
    labels,
    [
      [':[0]++', 4],
      ['second-fragment', 17],
    ],
    'the second Decode appends labels after the first fragment rather than restarting at zero',
  )
})

test('dynamic overlap preserves native input-ring request boundaries in the real mixer chain', () => {
  const asset = pcm(4096)
  asset.loops.labels = [{ position: 500, name: ':[0]++' }]
  asset.loops.links = [
    { from: 512, to: 600, smooth: false, condition: 'eq', variable: 0, reference: 1 },
  ]
  const mixer = open(asset, [filter(1, { window: 64, overlap: 4 })])
  render(mixer, 256)
  assert.equal(mixer.snapshot(1).position, 256)
  mixer.command({ op: 'filters', id: 1, filters: [filter(1, { window: 64, overlap: 2 })] })
  const before = render(mixer, 256)
  assert.deepEqual(
    before.events
      .filter((event) => event.type === 'label')
      .map((event) => [event.label, event.snapshot.position]),
    [[':[0]++', 500]],
  )
  assert.equal(mixer.snapshot(1).position, 512)
  const after = render(mixer, 1)
  assert.deepEqual(
    after.events.filter((event) => event.type === 'error'),
    [],
  )
  assert.equal(
    mixer.snapshot(1).position,
    601,
    'the split second Decode request takes the newly eligible link',
  )
})

test('wrapped short fills preserve fragment padding before an EOF label enables the second read', () => {
  const asset = pcm(64),
    flags = Array<number>(16).fill(0),
    budget = newAudioFilterBudget(128)
  asset.data[0] = Float32Array.from({ length: 64 }, (_, frame) => (frame + 1) / 128)
  asset.loops.labels = [{ position: 61, name: ':[0]=1' }]
  asset.loops.links = [
    { from: 64, to: 0, smooth: false, condition: 'eq', variable: 0, reference: 1 },
  ]
  const source = new FilteredWaveSource(
      asset,
      60,
      flags,
      () => false,
      () => budget,
    ),
    data = [new Float32Array(32)],
    segments = new WaveSegmentQueue()
  data[0]!.fill(-1)
  assert.equal(readFilterInput(source, data, 32, 240, 256, segments), 20)
  assert.deepEqual(Array.from(data[0]!), [
    ...Array.from({ length: 4 }, (_, frame) => (61 + frame) / 128),
    ...Array<number>(12).fill(0),
    ...Array.from({ length: 16 }, (_, frame) => (frame + 1) / 128),
  ])
  assert.equal(source.position, 16)
  assert.equal(segments.positionAt(0), 60)
  assert.equal(segments.positionAt(16), 0)
  assert.equal(segments.positionAt(32), 16)
})
