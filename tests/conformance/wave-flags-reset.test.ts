import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, type PcmAsset, type StreamingPcmAsset } from '../../src/engine/ports/audio.ts'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { parseSliBytes } from '../../src/formats/audio/sli.ts'
import { waveResetFiles } from '../helpers/wave-flags-reset.ts'

function asset(): PcmAsset {
  const files = waveResetFiles(), value = decodeWav(files['routes.wav']!)
  assert(value); value.loops = parseSliBytes(files['routes.wav.sli']!); return value
}
function render(mixer: AudioMixer, frames: number) {
  const left = new Float32Array(frames), right = new Float32Array(frames), events = mixer.render(left, right)
  return { left: [...left], right: [...right], labels: events.flatMap((event) => event.type === 'label' ? [event.label] : []) }
}
test('one Wave reset selects the legitimate next SLI phrase in buffered and streamed PCM, never the intermediate wrong branch', () => {
  for (const stream of [false, true]) {
    const pcm = asset(), source: PcmAsset | StreamingPcmAsset = stream
      ? { ...pcm, kind: 'stream', streamId: 1, initial: [{ position: 0, data: pcm.data }] } : pcm,
      mixer = new AudioMixer(1000)
    mixer.command({ op: 'load', id: 1, asset: source, settings: defaultSoundSettings() })
    mixer.command({ op: 'create', id: 2, settings: defaultSoundSettings() })
    mixer.command({ op: 'flag', id: 2, index: 0, value: 73 })
    for (const index of [0, 15]) mixer.command({ op: 'flag', id: 1, index, value: 1 })
    mixer.command({ op: 'play', id: 1 })
    assert.deepEqual(render(mixer, 20).left, Array(20).fill(.25))
    const reset = mixer.command({ op: 'resetFlags', id: 1 }).snapshot!
    assert.deepEqual(reset.flags, Array(16).fill(0)); assert.equal(reset.position, 20); assert.equal(reset.status, 'play')
    const next = render(mixer, 60)
    assert.deepEqual(next.left, [...Array(20).fill(.25), ...Array(40).fill(.5)])
    assert.deepEqual(next.right, [...Array(20).fill(-.25), ...Array(40).fill(-.5)])
    assert.deepEqual(next.labels, ['next']); assert.equal(mixer.snapshot(2).flags[0], 73)
    // A deliberately partial clear is a different, audible third phrase.
    // This negative control makes the old sixteen-message path distinguishable.
    mixer.command({ op: 'stop', id: 1 })
    mixer.command({ op: 'flag', id: 1, index: 15, value: 1 })
    mixer.command({ op: 'play', id: 1 })
    const partial = render(mixer, 60)
    assert.deepEqual(partial.left, [...Array(40).fill(.25), ...Array(20).fill(-.75)])
    assert.deepEqual(partial.labels, ['wrong'])
  }
})

test('Wave reset leaves paused media position, fade clock and other owners unchanged', () => {
  const mixer = new AudioMixer(1000)
  mixer.command({ op: 'load', id: 1, asset: asset(), settings: defaultSoundSettings() })
  mixer.command({ op: 'set', id: 1, property: 'position', value: 17 })
  mixer.command({ op: 'play', id: 1 }); mixer.command({ op: 'set', id: 1, property: 'paused', value: true })
  mixer.command({ op: 'fade', id: 1, target: 0, time: 120, delay: 0 })
  for (let index = 0; index < 16; index++) mixer.command({ op: 'flag', id: 1, index, value: index + 1 })
  const before = mixer.snapshot(1), after = mixer.command({ op: 'resetFlags', id: 1 }).snapshot!
  assert.deepEqual(after, { ...before, flags: Array(16).fill(0) })
  assert.deepEqual(render(mixer, 60).left, Array(60).fill(0))
  assert.equal(mixer.snapshot(1).position, 17); assert.equal(mixer.snapshot(1).volume, 50000)
  mixer.command({ op: 'set', id: 1, property: 'paused', value: false })
  assert.equal(mixer.snapshot(1).status, 'play')
})
