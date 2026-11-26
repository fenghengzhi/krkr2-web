import test from 'node:test'
import assert from 'node:assert/strict'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, type AudioEvent, type PcmAsset, type StreamingPcmAsset } from '../../src/engine/ports/audio.ts'
import { streamPageFrames } from '../../src/engine/media/stream-pcm.ts'
import { FilteredWaveSource } from '../../src/engine/media/filtered-wave-source.ts'
import { newAudioFilterBudget } from '../../src/engine/media/audio-filter-chain.ts'
import { WaveSegmentQueue } from '../../src/engine/media/audio-segments.ts'

const asset = (frames: number, pipeline = false): PcmAsset => ({ kind: 'pcm', sampleRate: 1000,
  sampleCount: frames, channels: 2, bits: 16, pcmEncoding: 's16',
  data: [new Float32Array(frames).fill(0.25), new Float32Array(frames).fill(-0.5)],
  loops: { labels: [{ position: 0, name: 'head' }, { position: frames, name: 'tail' }],
    links: pipeline ? [{ from: frames, to: 0, smooth: true, condition: 'eq', variable: 0, reference: 1 }] : [] } })
const streamed = (source: PcmAsset): StreamingPcmAsset => ({ kind: 'stream', streamId: 1,
  sampleRate: source.sampleRate, sampleCount: source.sampleCount, channels: source.channels,
  bits: source.bits, pcmEncoding: source.pcmEncoding, loops: source.loops,
  initial: [{ position: 0, data: source.data.map((channel) => channel.slice(0, streamPageFrames)) }] })
function open(source: PcmAsset, stream = false, looping = false) {
  const mixer = new AudioMixer(1000)
  mixer.command({ op: 'load', id: 1, kind: 'wave', asset: stream ? streamed(source) : source,
    settings: { ...defaultSoundSettings(), looping } })
  mixer.command({ op: 'play', id: 1 })
  return mixer
}
function render(mixer: AudioMixer, frames: number, real = frames) {
  const left = new Float32Array(frames), right = new Float32Array(frames), events = mixer.render(left, right)
  assert.deepEqual([...left], [...Array(real).fill(0.25), ...Array(frames - real).fill(0)])
  assert.deepEqual([...right], [...Array(real).fill(-0.5), ...Array(frames - real).fill(0)])
  assert.deepEqual(events.filter((event) => event.type === 'error'), [])
  return events
}
const names = (events: AudioEvent[]) => events.map((event) => event.type === 'label' ? event.label : event.type)

test('ordinary and source-pipeline WAVE emit exactly one EOF label before natural stop, including aligned zero-frame Decode', () => {
  for (const frames of [24, 256]) for (const pipeline of [false, true]) for (const stream of [false, true]) {
    const mixer = open(asset(frames, pipeline), stream)
    assert.deepEqual(names(render(mixer, frames)), ['head'])
    assert.equal(mixer.snapshot(1).status, 'play')
    const ending = render(mixer, 1, 0)
    assert.deepEqual(names(ending), ['tail', 'ended'])
    assert.equal(ending[0]!.type === 'label' && ending[0]!.snapshot.position, frames)
    assert.equal(mixer.snapshot(1).status, 'stop')
    assert.deepEqual(names(render(mixer, 16, 0)), [])
  }
})

test('whole-file looping emits an EOF label per pass but an explicit link at the endpoint still bypasses it', () => {
  for (const pipeline of [false, true]) for (const explicit of [false, true]) {
    const source = asset(24, pipeline)
    if (explicit) source.loops.links.unshift({ from: 24, to: 0, smooth: false, condition: 'no', variable: -1, reference: 0 })
    const mixer = open(source, false, true), events = render(mixer, 73)
    assert.deepEqual(names(events), explicit ? ['head', 'head', 'head', 'head']
      : ['head', 'tail', 'head', 'tail', 'head', 'tail', 'head'])
    assert.equal(mixer.snapshot(1).status, 'play')
    mixer.command({ op: 'shutdown' })
  }
  // Fractional source advances cross the same endpoint without losing a
  // label, and the endpoint link wins before that label at a 3/2 source rate.
  for (const explicit of [false, true]) {
    const source = asset(25)
    if (explicit) source.loops.links.push({ from: 25, to: 0, smooth: false, condition: 'no', variable: -1, reference: 0 })
    const mixer = open(source, false, explicit)
    mixer.command({ op: 'set', id: 1, property: 'frequency', value: 1500 })
    assert.deepEqual(names(render(mixer, 16)), ['head'])
    assert.deepEqual(names(render(mixer, 1)), explicit ? ['head'] : ['tail', 'ended'])
  }
})

test('pause, manual stop and seek do not flush future endpoint labels; a later real replay does', () => {
  for (const pipeline of [false, true]) {
    const mixer = open(asset(24, pipeline))
    assert.deepEqual(names(render(mixer, 20)), ['head'])
    mixer.command({ op: 'set', id: 1, property: 'paused', value: true })
    assert.deepEqual(names(render(mixer, 20, 0)), [])
    assert.equal(mixer.snapshot(1).position, 20)
    mixer.command({ op: 'stop', id: 1 })
    assert.deepEqual(names(render(mixer, 20, 0)), [])
    mixer.command({ op: 'set', id: 1, property: 'paused', value: false })
    mixer.command({ op: 'play', id: 1 })
    assert.deepEqual(names(render(mixer, 10)), ['head'])
    mixer.command({ op: 'set', id: 1, property: 'position', value: 20 })
    assert.deepEqual(names(render(mixer, 4)), [])
    assert.deepEqual(names(render(mixer, 1, 0)), ['tail', 'ended'])
  }
})

test('a missing final stream page cannot publish the endpoint, and short Decode retries cannot duplicate its metadata', () => {
  for (const pipeline of [false, true]) {
    const source = asset(8200, pipeline), mixer = open(source, true)
    mixer.command({ op: 'set', id: 1, property: 'position', value: 8198 })
    assert.deepEqual(names(render(mixer, 32, 0)), [])
    assert.equal(mixer.snapshot(1).position, 8198)
    const requests = mixer.takeStreamRequests()
    assert.deepEqual(requests.map((request) => request.position), pipeline ? [8192] : [4096, 8192])
    for (const request of requests) {
      mixer.command({ op: 'streamData', request, data: source.data.map((channel) => channel.slice(request.position, request.position + request.frames)) })
      if (request.position !== 8192) {
        assert.deepEqual(names(render(mixer, 32, 0)), [])
        assert.equal(mixer.snapshot(1).position, 8198, 'An earlier lookahead reply cannot publish the missing endpoint')
      }
    }
    assert.deepEqual(names(render(mixer, 2)), [])
    assert.deepEqual(names(render(mixer, 1, 0)), ['tail', 'ended'])
  }
  const source = asset(24, true), budget = newAudioFilterBudget(128), reader = new FilteredWaveSource(source, 0,
    Array<number>(16).fill(0), () => false, () => budget), queue = new WaveSegmentQueue(), output = [new Float32Array(256), new Float32Array(256)]
  assert.equal(reader.read(output, 256, queue), 24)
  const labels: string[] = []; queue.emitThrough(24, true, (label) => labels.push(label.name))
  assert.deepEqual(labels, ['head', 'tail'])
  const retry = new WaveSegmentQueue()
  assert.equal(reader.read(output, 256, retry), 0)
  const repeated: string[] = []; retry.emitThrough(0, true, (label) => repeated.push(label.name))
  assert.deepEqual(repeated, [])
  let ready = true
  const flags = Array<number>(16).fill(0), controlledBudget = newAudioFilterBudget(128),
    controlled = new FilteredWaveSource(source, 0, flags, () => false,
    () => controlledBudget, { ready: () => ready, sample: (channel, position) => source.data[channel]![position]! }),
    first = new WaveSegmentQueue()
  assert.equal(controlled.read(output, 256, first), 24)
  // A newly enabled endpoint link tries to rewind, but its target is missing.
  // Retrying the old endpoint after disabling that link must not queue tail twice.
  flags[0] = 1; ready = false
  assert.equal(controlled.read(output, 256, new WaveSegmentQueue()), 0)
  assert.equal(controlled.starved, true); assert.equal(controlled.position, 24)
  flags[0] = 0; ready = true
  const resumed = new WaveSegmentQueue(), resumedLabels: string[] = []
  assert.equal(controlled.read(output, 256, resumed), 0)
  resumed.emitThrough(0, true, (label) => resumedLabels.push(label.name))
  assert.deepEqual(resumedLabels, [])
})
