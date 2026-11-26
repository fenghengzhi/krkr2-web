import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, type AudioAsset, type AudioEvent, type PcmAsset, type StreamingPcmAsset } from '../../src/engine/ports/audio.ts'

const samples = [.125, .25, .375, .5]
function source(streaming: boolean, pipeline = false): PcmAsset | StreamingPcmAsset {
  const loops = { labels: [{ position: 0, name: 'head' }, { position: 4, name: 'tail' }],
    links: pipeline ? [{ from: 4, to: 0, smooth: true, condition: 'eq' as const, variable: 0, reference: 1 }] : [] },
    info = { sampleRate: 1000, sampleCount: 4, channels: 1, bits: 16, pcmEncoding: 's16' as const, loops },
    data = [Float32Array.from(samples)]
  return streaming ? { ...info, kind: 'stream', streamId: 1, initial: [{ position: 0, data }] }
    : { ...info, kind: 'pcm', data }
}
function render(mixer: AudioMixer, frames: number) {
  const left = new Float32Array(frames), right = new Float32Array(frames), events = mixer.render(left, right)
  assert.deepEqual(right, left)
  return { samples: [...left], events }
}
const names = (events: AudioEvent[]) => events.map((event) => event.type === 'label' ? event.label : event.type)
function open(asset: AudioAsset, kind: 'wave' | 'cdda' = 'wave') {
  const mixer = new AudioMixer(1000)
  mixer.command({ op: 'load', id: 1, asset, kind, settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 })
  return mixer
}

test('ordinary and filtered Wave completion publishes zero before stop, preserves the fade and replays or seeks without repeating tail labels', () => {
  for (const streaming of [false, true]) for (const pipeline of [false, true]) {
    const mixer = open(source(streaming, pipeline))
    try {
      mixer.command({ op: 'fade', id: 1, target: 0, time: 120, delay: 0 })
      const first = render(mixer, 6)
      assert.deepEqual(first.samples, [...samples, 0, 0]); assert.deepEqual(names(first.events), ['head', 'tail', 'ended'])
      const ended = first.events.find((event) => event.type === 'ended')!
      assert(ended.type === 'ended'); assert.equal(ended.snapshot.position, 0); assert.equal(ended.snapshot.fading, true)
      assert.equal(mixer.snapshot(1).position, 0); assert.equal(mixer.snapshot(1).status, 'stop')
      assert.deepEqual(render(mixer, 3), { samples: [0, 0, 0], events: [] })
      mixer.command({ op: 'play', id: 1 })
      const replay = render(mixer, 2)
      assert.deepEqual(replay.samples, samples.slice(0, 2)); assert.deepEqual(names(replay.events), ['head'])
      mixer.command({ op: 'stop', id: 1 })
      assert.deepEqual(render(mixer, 2), { samples: [0, 0], events: [] }, 'Manual stop does not deliver a future tail')
      mixer.command({ op: 'set', id: 1, property: 'position', value: 2 })
      mixer.command({ op: 'play', id: 1 })
      const seek = render(mixer, 3)
      assert.deepEqual(seek.samples, [...samples.slice(2), 0]); assert.deepEqual(names(seek.events), ['tail', 'ended'])
      assert.equal(mixer.snapshot(1).position, 0)
      mixer.command({ op: 'set', id: 1, property: 'position', value: 1 })
      assert.equal(mixer.snapshot(1).position, 1, 'An explicit seek after completion cancels the replay marker')
      mixer.command({ op: 'play', id: 1 }); assert.deepEqual(render(mixer, 1).samples, [.25])
    } finally { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0) }
  }
})

test('an EOF SLI jump and whole-song loop win before Wave completion; disabling them reaches zero once, without changing CDDA completion', () => {
  for (const streaming of [false, true]) {
    const asset = source(streaming)
    asset.loops.links.push({ from: 4, to: 2, smooth: false, condition: 'eq', variable: 0, reference: 0 })
    const mixer = open(asset)
    try {
      const linked = render(mixer, 8)
      assert.deepEqual(linked.samples, [...samples, .375, .5, .375, .5]); assert.deepEqual(names(linked.events), ['head'])
      assert.equal(mixer.snapshot(1).status, 'play')
      mixer.command({ op: 'flag', id: 1, index: 0, value: 1 })
      const done = render(mixer, 1)
      assert.deepEqual(done.samples, [0]); assert.deepEqual(names(done.events), ['tail', 'ended'])
      assert.equal(mixer.snapshot(1).position, 0)
      mixer.command({ op: 'set', id: 1, property: 'looping', value: true }); mixer.command({ op: 'play', id: 1 })
      const loop = render(mixer, 6)
      assert.deepEqual(loop.samples, [...samples, .125, .25]); assert.deepEqual(names(loop.events), ['head', 'tail', 'head'])
      mixer.command({ op: 'set', id: 1, property: 'looping', value: false })
      const finish = render(mixer, 3)
      assert.deepEqual(finish.samples, [.375, .5, 0]); assert.deepEqual(names(finish.events), ['tail', 'ended'])
      assert.equal(mixer.snapshot(1).position, 0)
    } finally { mixer.command({ op: 'shutdown' }) }
  }
  const cdda = open(source(false), 'cdda')
  try { render(cdda, 6); assert.equal(cdda.snapshot(1).position, 4) }
  finally { cdda.command({ op: 'shutdown' }) }
})
