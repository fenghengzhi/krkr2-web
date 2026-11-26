import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, type PcmAsset, type StreamingPcmAsset } from '../../src/engine/ports/audio.ts'
import { streamPageFrames } from '../../src/engine/media/stream-pcm.ts'
import { loopHalfRate, loopPhrase } from '../helpers/wave-loop-resampling.ts'

function asset(sli: boolean): PcmAsset {
  const left = sli ? [...loopPhrase, .875, .875] : [...loopPhrase]
  return { kind: 'pcm', sampleRate: 1000, sampleCount: left.length, channels: 2, bits: 32,
    data: [Float32Array.from(left), Float32Array.from(left, (sample) => -sample / 2)],
    loops: { labels: [], links: sli ? [{ from: 4, to: 0, smooth: false, condition: 'no', variable: 0, reference: 0 }] : [] } }
}
function render(mixer: AudioMixer, count: number) {
  const left = new Float32Array(count), right = new Float32Array(count), events = mixer.render(left, right)
  assert(!events.some((event) => event.type === 'error')); return { left, right, events }
}
const read = (source: PcmAsset, position: number, frames: number) => source.data.map((plane) => plane.slice(position, position + frames))
const stream = (source: PcmAsset): StreamingPcmAsset => ({ ...source, kind: 'stream', streamId: 1,
  initial: [{ position: 0, data: read(source, 0, streamPageFrames) }] })

test('whole-song and hard-SLI WAVE resampling joins logical source samples in buffered and streamed playback', () => {
  for (const sli of [false, true]) for (const streamed of [false, true]) for (const frequency of [1000, 1500]) {
    const source = asset(sli), mixer = new AudioMixer(2000)
    try {
      mixer.command({ op: 'load', id: 1, kind: 'wave', asset: streamed ? stream(source) : source,
        settings: { ...defaultSoundSettings(), looping: !sli } })
      mixer.command({ op: 'set', id: 1, property: 'frequency', value: frequency }); mixer.command({ op: 'play', id: 1 })
      const heard = render(mixer, 32), expected = Float32Array.from({ length: 32 }, (_, frame) => {
        const position = frame * frequency / 2000, index = Math.floor(position) % 4, fraction = position % 1
        return loopPhrase[index]! * (1 - fraction) + loopPhrase[(index + 1) % 4]! * fraction
      })
      assert.deepEqual(heard.left, expected); assert.deepEqual(heard.right, Float32Array.from(expected, (value) => value ? -value / 2 : 0))
      if (frequency === 1000) assert.deepEqual([...heard.left.subarray(0, 8)], loopHalfRate)
      assert.equal(mixer.snapshot(1).status, 'play')
      mixer.command({ op: 'set', id: 1, property: 'position', value: 4 - Number.EPSILON * 4 })
      assert.equal(render(mixer, 1).left[0], -.5, 'A device-rate rounding tail still interpolates toward the exact next source sample')
    } finally { mixer.command({ op: 'shutdown' }) }
  }
})

test('conditional-link previews do not publish target labels and respect live flag, pause and whole-loop changes', () => {
  const source = asset(true), mixer = new AudioMixer(2000)
  source.loops.links[0]!.condition = 'eq'; source.loops.links[0]!.reference = 1
  source.loops.labels = [{ position: 0, name: ':[1]++' }, { position: 0, name: 'phrase' }]
  try {
    mixer.command({ op: 'load', id: 1, asset: source, settings: defaultSoundSettings() })
    mixer.command({ op: 'set', id: 1, property: 'position', value: 3.5 })
    mixer.command({ op: 'set', id: 1, property: 'frequency', value: 500 }); mixer.command({ op: 'play', id: 1 })
    assert.equal(render(mixer, 1).left[0], .6875, 'An inactive link still uses the physical next sample')
    mixer.command({ op: 'flag', id: 1, index: 0, value: 1 })
    mixer.command({ op: 'set', id: 1, property: 'paused', value: true })
    const paused = mixer.snapshot(1); assert(render(mixer, 10).left.every((value) => value === 0)); assert.deepEqual(mixer.snapshot(1), paused)
    mixer.command({ op: 'set', id: 1, property: 'paused', value: false })
    const beforeJump = render(mixer, 1)
    assert.equal(beforeJump.left[0], -.25); assert.deepEqual(beforeJump.events, []); assert.equal(mixer.snapshot(1).flags[1], 0)
    const target = render(mixer, 1)
    assert.equal(target.left[0], -.5); assert.equal(mixer.snapshot(1).flags[1], 1)
    assert.deepEqual(target.events.map((event) => 'label' in event ? event.label : ''), [':[1]++', 'phrase'])
    mixer.command({ op: 'load', id: 1, asset: asset(false), settings: { ...defaultSoundSettings(), looping: true } })
    mixer.command({ op: 'set', id: 1, property: 'position', value: 3.5 }); mixer.command({ op: 'play', id: 1 })
    mixer.command({ op: 'set', id: 1, property: 'looping', value: false })
    assert.equal(render(mixer, 1).left[0], .5, 'Disabled whole-loop keeps the existing genuine EOF endpoint hold')
    assert.deepEqual(render(mixer, 1).events.map((event) => event.type), ['ended'])
    assert.equal(mixer.snapshot(1).position, 0)
  } finally { mixer.command({ op: 'shutdown' }) }
})

test('a fractional hard join reserves its distant interpolation sample before consuming any audio or labels', () => {
  const length = streamPageFrames * 5, left = new Float32Array(length).fill(.875)
  left[4095] = .75; left[12288] = -.25
  const source: PcmAsset = { kind: 'pcm', sampleRate: 1000, sampleCount: length, channels: 1, bits: 32,
    data: [left], loops: { links: [{ from: 4096, to: 12288, smooth: false, condition: 'no', variable: 0, reference: 0 }],
      labels: [{ position: 12288, name: ':[0]++' }, { position: 12288, name: 'target' }] } }, mixer = new AudioMixer(2000)
  try {
    mixer.command({ op: 'load', id: 1, asset: stream(source), settings: defaultSoundSettings() })
    mixer.command({ op: 'set', id: 1, property: 'position', value: 4095.5 })
    mixer.command({ op: 'set', id: 1, property: 'frequency', value: 500 }); mixer.command({ op: 'play', id: 1 })
    const requests = mixer.takeStreamRequests(), missing = requests.find((request) => request.position === 12288)
    assert(missing)
    for (const request of requests) if (request !== missing)
      mixer.command({ op: 'streamData', request, data: read(source, request.position, request.frames) })
    const before = mixer.snapshot(1), held = render(mixer, 4)
    assert(held.left.every((value) => value === 0)); assert.deepEqual(held.events, []); assert.deepEqual(mixer.snapshot(1), before)
    mixer.command({ op: 'streamData', request: missing, data: read(source, missing.position, missing.frames) })
    const first = render(mixer, 1); assert.equal(first.left[0], .25); assert.deepEqual(first.events, [])
    assert.equal(mixer.snapshot(1).flags[0], 0)
    assert.equal(render(mixer, 1).left[0], 0)
    const crossed = render(mixer, 1); assert.equal(crossed.left[0], -.25)
    assert.equal(mixer.snapshot(1).flags[0], 1)
    assert.deepEqual(crossed.events.map((event) => 'label' in event ? event.label : ''), [':[0]++', 'target'])
  } finally { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspectStreams().bytes, 0) }
})
