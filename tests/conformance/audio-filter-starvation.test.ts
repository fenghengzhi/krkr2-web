import test from 'node:test'
import assert from 'node:assert/strict'
import type { PcmAccess, PcmAsset, PhaseVocoderFilter, StreamingPcmAsset } from '../../src/engine/ports/audio.ts'
import { FilteredWaveSource } from '../../src/engine/media/filtered-wave-source.ts'
import { AudioFilterChain, newAudioFilterBudget, readFilterInput, type FilterInputRead } from '../../src/engine/media/audio-filter-chain.ts'
import { WaveSegmentQueue } from '../../src/engine/media/audio-segments.ts'

function track(frames = 2048): PcmAsset {
  return { kind: 'pcm', channels: 2, sampleRate: 1000, sampleCount: frames, bits: 32,
    data: [Float32Array.from({ length: frames }, (_, i) => ((i * 7) % 97 - 48) / 128),
      Float32Array.from({ length: frames }, (_, i) => ((i * 11) % 89 - 44) / 128)],
    loops: { links: [], labels: [] } }
}
function pages(asset: PcmAsset, pageFrames = 32, initial: number[] = []) {
  const resident = new Set(initial), pending = new Set<number>(), ranges: Array<[number, number]> = []
  const access: PcmAccess = {
    ready(position, frames) {
      ranges.push([position, frames])
      let ready = true
      for (let page = Math.floor(position / pageFrames); page <= Math.floor((position + frames - 1) / pageFrames); page++)
        if (!resident.has(page)) { pending.add(page); ready = false }
      return ready
    },
    sample(channel, position) {
      const index = Math.floor(position), fraction = position - index,
        next = Math.min(asset.sampleCount - 1, index + 1)
      assert(resident.has(Math.floor(index / pageFrames)), 'A sample cannot read an absent page')
      if (fraction) assert(resident.has(Math.floor(next / pageFrames)))
      return asset.data[channel]![index]! * (1 - fraction) + asset.data[channel]![next]! * fraction
    },
  }
  const streaming: StreamingPcmAsset = { kind: 'stream', streamId: 1, initial: [],
    channels: asset.channels, sampleRate: asset.sampleRate, sampleCount: asset.sampleCount,
    bits: asset.bits, loops: asset.loops }
  return { access, streaming, ranges, pending,
    supply() { assert(pending.size > 0, 'Starvation must request a missing page'); for (const page of pending) resident.add(page); pending.clear() } }
}
function source(asset: PcmAsset, position = 0, paging?: ReturnType<typeof pages>) {
  const flags = Array<number>(16).fill(0)
  let budget = newAudioFilterBudget(128)
  const decoder = new FilteredWaveSource(paging?.streaming ?? asset, position, flags, () => false,
    () => budget, paging?.access)
  return { decoder, flags, resetBudget() { budget = newAudioFilterBudget(128); return budget } }
}
function metadata(queue: WaveSegmentQueue) {
  const copy = new WaveSegmentQueue(), labels: Array<[string, number]> = []
  copy.append(queue)
  copy.emitThrough(Infinity, true, (label) => labels.push([label.name, label.offset]))
  return { length: queue.length, positions: Array.from({ length: queue.length + 1 }, (_, at) => queue.positionAt(at)), labels }
}
const buffers = (frames: number) => [new Float32Array(frames), new Float32Array(frames)]

test('missing target pages preserve the complete preceding unit and do not commit a jump or its labels twice', () => {
  const asset = track(128)
  asset.loops.links = [{ from: 8, to: 32, smooth: false, condition: 'no', variable: -1, reference: 0 }]
  asset.loops.labels = [{ position: 4, name: ':[0]++' }, { position: 32, name: ':[1]++' }, { position: 36, name: 'after-jump' }]
  const paging = pages(asset, 8, [0]), partial = source(asset, 0, paging), complete = source(asset),
    actual = buffers(16), expected = buffers(16), queue = new WaveSegmentQueue(), reference = new WaveSegmentQueue()
  assert.equal(complete.decoder.read(expected, 16, reference), 16)
  assert.equal(partial.decoder.read(actual, 16, queue), 8)
  assert.equal(partial.decoder.starved, true)
  assert.equal(partial.decoder.position, 8)
  assert.deepEqual(partial.flags.slice(0, 2), [1, 0])
  assert.equal(queue.length, 8)
  const held = metadata(queue)
  assert.equal(partial.decoder.read(actual.map((x) => x.subarray(8)), 8, queue), 0)
  assert.equal(partial.decoder.position, 8)
  assert.deepEqual(partial.flags.slice(0, 2), [1, 0])
  assert.deepEqual(metadata(queue), held)
  paging.supply()
  assert.equal(partial.decoder.read(actual.map((x) => x.subarray(8)), 8, queue), 8)
  assert.equal(partial.decoder.starved, false)
  assert.deepEqual(actual, expected)
  assert.deepEqual(partial.flags, complete.flags)
  assert.equal(partial.decoder.position, complete.decoder.position)
  assert.deepEqual(metadata(queue), metadata(reference))
})

test('smooth preparation waits for both ranges before changing decoder position, labels or flags', () => {
  const asset = track(64)
  asset.loops.links = [{ from: 32, to: 8, smooth: true, condition: 'no', variable: -1, reference: 0 }]
  asset.loops.labels = [{ position: 10, name: 'target' }, { position: 28, name: ':[1]++' }]
  const paging = pages(asset, 8, [3, 4, 5, 6]), partial = source(asset, 24, paging), complete = source(asset, 24),
    actual = buffers(32), expected = buffers(32), queue = new WaveSegmentQueue(), reference = new WaveSegmentQueue()
  assert.equal(partial.decoder.read(actual, 16, queue), 0)
  assert.equal(partial.decoder.starved, true)
  assert.deepEqual(paging.ranges, [[24, 32], [0, 32]])
  assert.equal(partial.decoder.position, 24)
  assert.equal(queue.length, 0)
  assert.deepEqual(partial.flags, Array<number>(16).fill(0))
  paging.supply()
  for (const at of [0, 16]) {
    assert.equal(partial.decoder.read(actual.map((x) => x.subarray(at)), 16, queue), 16)
    assert.equal(complete.decoder.read(expected.map((x) => x.subarray(at)), 16, reference), 16)
  }
  assert.deepEqual(actual, expected)
  assert.deepEqual(partial.flags, complete.flags)
  assert.equal(partial.decoder.position, complete.decoder.position)
  assert.deepEqual(metadata(queue), metadata(reference))
})

test('a wrapped hop retains genuine EOF padding while its second fragment waits for pages', () => {
  const asset = track(64)
  asset.loops.labels = [{ position: 61, name: ':[0]=1' }]
  asset.loops.links = [{ from: 64, to: 0, smooth: false, condition: 'eq', variable: 0, reference: 1 }]
  const paging = pages(asset, 16, [3]), partial = source(asset, 60, paging), complete = source(asset, 60),
    actual = buffers(32), expected = buffers(32), queue = new WaveSegmentQueue(), reference = new WaveSegmentQueue(),
    pending: FilterInputRead = { offset: 0, decoded: 0 }
  for (const channel of actual) channel.fill(-1)
  assert.equal(readFilterInput(complete.decoder, expected, 32, 240, 256, reference), 20)
  assert.equal(readFilterInput(partial.decoder, actual, 32, 240, 256, queue, pending), 4)
  assert.equal(partial.decoder.starved, true)
  assert.deepEqual(pending, { offset: 16, decoded: 4 })
  assert.deepEqual(Array.from(actual[0]!.subarray(4, 16)), Array<number>(12).fill(0))
  assert.deepEqual(Array.from(actual[0]!.subarray(16)), Array<number>(16).fill(-1), 'Missing data is not EOF padding')
  assert.equal(partial.decoder.position, 64)
  paging.supply()
  assert.equal(readFilterInput(partial.decoder, actual, 32, 240, 256, queue, pending), 20)
  assert.equal(partial.decoder.starved, false)
  assert.deepEqual(actual, expected)
  assert.deepEqual(partial.flags, complete.flags)
  assert.equal(partial.decoder.position, complete.decoder.position)
  assert.deepEqual(metadata(queue), metadata(reference))
})

test('a wrapped hop resumes within its first fragment and preserves the second Decode boundary', () => {
  const asset = track(128)
  asset.loops.links = [{ from: 8, to: 64, smooth: false, condition: 'no', variable: -1, reference: 0 }]
  asset.loops.labels = [{ position: 4, name: ':[0]++' }, { position: 70, name: 'first-fragment' }, { position: 80, name: 'second-fragment' }]
  const paging = pages(asset, 8, [0]), partial = source(asset, 0, paging), complete = source(asset),
    actual = buffers(32), expected = buffers(32), queue = new WaveSegmentQueue(), reference = new WaveSegmentQueue(),
    pending: FilterInputRead = { offset: 0, decoded: 0 }
  for (const channel of actual) channel.fill(-1)
  assert.equal(readFilterInput(complete.decoder, expected, 32, 240, 256, reference), 32)
  assert.equal(readFilterInput(partial.decoder, actual, 32, 240, 256, queue, pending), 8)
  assert.deepEqual(pending, { offset: 8, decoded: 8 })
  assert.deepEqual(Array.from(actual[0]!.subarray(8)), Array<number>(24).fill(-1))
  let stalls = 0
  while (pending.offset < 32) {
    assert(++stalls <= 4)
    paging.supply()
    readFilterInput(partial.decoder, actual, 32, 240, 256, queue, pending)
  }
  assert.deepEqual(actual, expected)
  assert.deepEqual(partial.flags, complete.flags)
  assert.equal(partial.decoder.position, complete.decoder.position)
  assert.deepEqual(metadata(queue), metadata(reference))
})

function filter(id: number, time = 1, pitch = 1): PhaseVocoderFilter {
  return { type: 'phase-vocoder', id, window: 64, overlap: 4, time, pitch }
}
function play(asset: PcmAsset, filters: PhaseVocoderFilter[], step: number, missing: boolean) {
  const paging = missing ? pages(asset) : undefined, input = source(asset, 0, paging),
    chain = new AudioFilterChain(asset.channels, filters, input.decoder), audio: number[][] = [],
    labels: Array<[string, number]> = [], positions: number[] = [], emit = (name: string, at: number) => { labels.push([name, at]) }
  let stalls = 0, ended = false
  for (let guard = 0; guard < 20000; guard++) {
    chain.setBudget(input.resetBudget())
    const before = chain.sourcePosition(), labelCount = labels.length
    if (!chain.canAdvance(step)) {
      assert.equal(chain.starved, true)
      assert.equal(chain.sourcePosition(), before)
      assert.equal(labels.length, labelCount)
      assert(paging)
      const flags = [...input.flags], decoderPosition = input.decoder.position
      assert.equal(chain.canAdvance(step), false, 'Retry without pages remains pending')
      assert.deepEqual(input.flags, flags, 'A failed retry cannot re-execute a partial input label')
      assert.equal(input.decoder.position, decoderPosition)
      paging.supply()
      stalls++
      continue
    }
    assert.equal(chain.starved, false)
    const reads = paging?.ranges.length
    if (!chain.prepare(emit)) {
      assert.equal(chain.starved, false, 'Real EOF is not starvation')
      ended = true
      break
    }
    audio.push(Array.from({ length: asset.channels }, (_, channel) => chain.sample(channel)))
    chain.advance(step, emit)
    assert.equal(paging?.ranges.length, reads, 'Successful preflight covers sample interpolation and the complete advance')
    positions.push(chain.sourcePosition())
  }
  assert(ended, 'The finite source must terminate within its explicit bound')
  if (missing) assert(stalls > 2, 'The comparison must actually suspend and resume multiple pages')
  return { audio, labels, positions, flags: input.flags, decoderPosition: input.decoder.position, sourcePosition: chain.sourcePosition() }
}

for (const [name, filters, step] of [
  ['plain fractional block interpolation', [], 0.75],
  ['plain maximum three-block source advance', [], 384],
  ['one DSP stage with a fractional playback step', [filter(1, 0.75, 1.25)], 1.125],
  ['two DSP stages retaining partial upstream hops', [filter(1, 1.5, 0.8), filter(2, 0.75, 1.2)], 0.75],
] as const) {
  test(`streamed filters resume exact PCM, labels, flags and positions: ${name}`, () => {
    const asset = track()
    asset.loops.links = [
      { from: 10, to: 80, smooth: false, condition: 'no', variable: -1, reference: 0 },
      { from: 370, to: 620, smooth: true, condition: 'no', variable: -1, reference: 0 },
      { from: 1000, to: 1200, smooth: false, condition: 'eq', variable: 0, reference: 1 },
    ]
    asset.loops.labels = [
      { position: 0, name: 'start' }, { position: 5, name: ':[0]++' }, { position: 9, name: 'before-jump' },
      { position: 80, name: 'jump-target' }, { position: 87, name: ':[1]++' },
      { position: 348, name: 'fade-start' }, { position: 621, name: 'fade-target' },
      { position: 1201, name: 'conditional-target' }, { position: 2047, name: 'last' },
    ]
    const whole = play(asset, [...filters], step, false), resumed = play(asset, [...filters], step, true)
    assert.deepEqual(resumed, whole)
    assert(whole.audio.length > 0)
    assert(whole.labels.length > 0)
    assert.deepEqual(whole.flags.slice(0, 2), [1, 1])
  })
}

test('prepare distinguishes a missing initial page from real EOF without publishing labels', () => {
  const asset = track(16)
  asset.loops.labels = [{ position: 0, name: 'start' }]
  const paging = pages(asset), input = source(asset, 0, paging), chain = new AudioFilterChain(2, [], input.decoder), labels: string[] = []
  chain.setBudget(input.resetBudget())
  assert.equal(chain.prepare((name) => labels.push(name)), false)
  assert.equal(chain.starved, true)
  assert.equal(chain.sourcePosition(), 0)
  assert.deepEqual([...labels], [])
  paging.supply()
  assert.equal(chain.canAdvance(16), true)
  assert.equal(chain.prepare((name) => labels.push(name)), true)
  chain.advance(16, (name) => labels.push(name))
  assert.equal(chain.canAdvance(1), true)
  assert.equal(chain.prepare((name) => labels.push(name)), false)
  assert.equal(chain.starved, false)
  assert.deepEqual(labels, ['start'])
})
