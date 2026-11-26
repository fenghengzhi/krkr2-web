import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, type PcmAsset, type StreamingPcmAsset } from '../../src/engine/ports/audio.ts'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { parseSliBytes } from '../../src/formats/audio/sli.ts'
import { conditionalFiles } from '../helpers/wave-conditional-unit.ts'

function source() {
  const files = conditionalFiles(), asset = decodeWav(files['conditional.wav'])!
  asset.loops = parseSliBytes(files['conditional.wav.sli']); return asset
}
const render = (mixer: AudioMixer, frames: number) => {
  const left = new Float32Array(frames), right = new Float32Array(frames), events = mixer.render(left, right)
  assert(!events.some((event) => event.type === 'error')); return { left, right, events }
}
const read = (asset: PcmAsset, at: number, frames: number) => asset.data.map((plane) => plane.slice(at, at + frames))
const stream = (asset: PcmAsset): StreamingPcmAsset => ({ ...asset, kind: 'stream', streamId: 1,
  initial: [{ position: 0, data: read(asset, 0, 4096) }] })

test('a flag label cannot retroactively enable a conditional link inside the fixed native Decode unit', () => {
  for (const streamed of [false, true]) {
    const asset = source(), mixer = new AudioMixer(8000)
    try {
      mixer.command({ op: 'load', id: 1, kind: 'wave', asset: streamed ? stream(asset) : asset, settings: defaultSoundSettings() })
      mixer.command({ op: 'play', id: 1 })
      const heard = render(mixer, 2000),
        expected = [...Array(400).fill(.125), ...Array(400).fill(.25), ...Array(400).fill(.125),
          ...Array(400).fill(.5), ...Array(400).fill(.125)]
      assert.deepEqual([...heard.left], expected)
      assert.deepEqual([...heard.right], expected.map((sample) => -sample / 2))
      assert.deepEqual(heard.events.flatMap((event) => event.type === 'label' && event.label !== ':[0]=1' ? [event.label] : []), ['middle', 'next'])
      assert.equal(mixer.snapshot(1).flags[0], 1); assert.equal(mixer.snapshot(1).position, 400)
      mixer.command({ op: 'set', id: 1, property: 'paused', value: true })
      const before = mixer.snapshot(1); assert(render(mixer, 160).left.every((sample) => sample === 0)); assert.deepEqual(mixer.snapshot(1), before)
      mixer.command({ op: 'flag', id: 1, index: 0, value: 0 })
      mixer.command({ op: 'set', id: 1, property: 'position', value: 0 })
      mixer.command({ op: 'set', id: 1, property: 'paused', value: false })
      assert.deepEqual([...render(mixer, 1000).left], expected.slice(0, 1000))
      mixer.command({ op: 'set', id: 1, property: 'position', value: 0 })
      assert.deepEqual([...render(mixer, 1000).left], [...Array(400).fill(.125), ...Array(400).fill(.5), ...Array(200).fill(.125)])
      mixer.command({ op: 'stop', id: 1 }); mixer.command({ op: 'play', id: 1 })
      assert.deepEqual([...render(mixer, 800).left], [...Array(400).fill(.125), ...Array(400).fill(.5)])
    } finally { mixer.command({ op: 'shutdown' }) }
  }
})

test('condition changes preserve already decoded music; a missing far phrase retains its partial unit and publishes no unheard labels', () => {
  const asset = source(), mixer = new AudioMixer(8000)
  asset.loops.links[0]!.to = 12288
  asset.loops.links[2]!.from = 12688
  asset.loops.labels[2]!.position = 12288
  try {
    mixer.command({ op: 'load', id: 1, kind: 'wave', asset: stream(asset), settings: defaultSoundSettings() })
    mixer.command({ op: 'play', id: 1 })
    // One native unit is already committed, including its middle phrase.
    const first = render(mixer, 20); assert(first.left.every((sample) => sample === .125))
    mixer.command({ op: 'flag', id: 1, index: 0, value: 0 })
    const rest = render(mixer, 980)
    assert.deepEqual([...rest.left], [...Array(380).fill(.125), ...Array(400).fill(.25), ...Array(200).fill(.125)])
    assert.equal(mixer.snapshot(1).flags[0], 0, 'A script assignment does not rerun a queued flag label')
    mixer.command({ op: 'flag', id: 1, index: 0, value: 1 })
    const held = render(mixer, 1000)
    assert.deepEqual([...held.left], [...Array(200).fill(.125), ...Array(800).fill(0)])
    assert.deepEqual(held.events, []); assert.equal(mixer.snapshot(1).position, 400)
    const requests = mixer.takeStreamRequests()
    assert(requests.some((request) => request.position === 12288))
    mixer.command({ op: 'flag', id: 1, index: 0, value: 0 })
    for (const request of requests) mixer.command({ op: 'streamData', request, data: read(asset, request.position, request.frames) })
    const resumed = render(mixer, 800)
    assert.deepEqual([...resumed.left], [...Array(400).fill(.5), ...Array(400).fill(.125)])
    assert.equal(resumed.events.filter((event) => event.type === 'label' && event.label === 'next').length, 1)
    assert(mixer.inspectStreams().pending <= 4)
  } finally { mixer.command({ op: 'shutdown' }) }
  for (const seek of [false, true]) {
    const pcm = source(), delayed = new AudioMixer(8000)
    try {
      delayed.command({ op: 'load', id: 1, kind: 'wave', asset: { ...stream(pcm), initial: [] }, settings: defaultSoundSettings() })
      delayed.command({ op: 'play', id: 1 })
      assert(render(delayed, 1).left.every((sample) => sample === 0))
      delayed.command({ op: 'flag', id: 1, index: 0, value: 1 })
      if (seek) delayed.command({ op: 'set', id: 1, property: 'position', value: 0 })
      for (const request of delayed.takeStreamRequests()) delayed.command({ op: 'streamData', request,
        data: read(pcm, request.position, request.frames) })
      assert.deepEqual([...render(delayed, 1000).left], [...Array(400).fill(.125),
        ...Array(400).fill(seek ? .5 : .25), ...Array(200).fill(.125)],
      seek ? 'Seek starts a new Decode decision' : 'A data wait keeps the already selected 800 boundary')
    } finally { delayed.command({ op: 'shutdown' }) }
  }
})

test('conditional music reserves a source-rate-bounded playback queue independent of long recording length', () => {
  const mixer = new AudioMixer(48000), asset: StreamingPcmAsset = { kind: 'stream', streamId: 1,
    sampleRate: 384000, sampleCount: 1_000_000_000, channels: 8, bits: 16, initial: [],
    loops: { links: [{ from: 100000, to: 0, condition: 'eq', variable: 0, reference: 1, smooth: false }],
      labels: [{ position: 1, name: ':[0]=1' }] } }
  try {
    for (let id = 1; id <= 10; id++) mixer.command({ op: 'load', id, kind: 'wave', asset, settings: defaultSoundSettings() })
    // 4 * 48000 * 8 * 4 bytes per voice: ten fit 64 MiB, eleven do not.
    assert.throws(() => mixer.command({ op: 'load', id: 11, kind: 'wave', asset, settings: defaultSoundSettings() }),
      /Audio filter session budget exceeded/)
    assert.equal(mixer.inspect().voices, 10); assert.equal(mixer.inspectStreams().bytes, 0)
    mixer.command({ op: 'close', id: 1 })
    mixer.command({ op: 'load', id: 11, kind: 'wave', asset, settings: defaultSoundSettings() })
    assert.equal(mixer.inspect().voices, 10)
  } finally { mixer.command({ op: 'shutdown' }) }
})
