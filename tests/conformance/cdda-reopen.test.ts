import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, emptyLoops, type PcmAsset } from '../../src/engine/ports/audio.ts'

const pcm = (value: number): PcmAsset => ({ kind: 'pcm', sampleRate: 1000, sampleCount: 1000,
  channels: 2, bits: 16, loops: emptyLoops(),
  data: [new Float32Array(1000).fill(value), new Float32Array(1000).fill(-value / 2)] })
const render = (mixer: AudioMixer, count: number) => {
  const left = new Float32Array(count), right = new Float32Array(count), events = mixer.render(left, right)
  return { left: [...left], right: [...right], events }
}

test('CDDA replacements retain the exact fade clock while decoder-free status and eventual close stay distinct', () => {
  for (const status of ['stop', 'unload'] as const) {
    const mixer = new AudioMixer(1000), settings = defaultSoundSettings()
    mixer.command({ op: 'load', id: 1, kind: 'cdda', asset: pcm(.5), settings })
    mixer.command({ op: 'play', id: 1 })
    mixer.command({ op: 'fade', id: 1, target: 0, time: 120, delay: 0 })
    const first = render(mixer, 60)
    assert.deepEqual(first.left, [...Array(59).fill(.5), .25])
    assert.deepEqual(first.right, [...Array(59).fill(-.25), -.125])
    assert.deepEqual(first.events, [])
    mixer.command({ op: 'stop', id: 1 })
    const retained = mixer.command({ op: 'unload', id: 1, status }).snapshot!
    assert.equal(retained.status, status); assert.equal(retained.volume, 50000)
    assert.equal(retained.sampleCount, 0); assert.equal(retained.fading, true)
    assert.deepEqual(render(mixer, 30), { left: Array(30).fill(0), right: Array(30).fill(0), events: [] })
    // The captured open settings are deliberately stale; the live control
    // voice supplies volume and the already elapsed 90 ms fade clock.
    mixer.command({ op: 'load', id: 1, kind: 'cdda', asset: pcm(.25), settings })
    mixer.command({ op: 'play', id: 1 })
    const second = render(mixer, 30)
    assert.deepEqual(second.left, [...Array(29).fill(.125), 0])
    assert.deepEqual(second.right, [...Array(29).fill(-.0625), 0])
    assert.deepEqual(second.events.map((event) => event.type), ['fade'])
    assert.equal(mixer.snapshot(1).volume, 0); assert.equal(mixer.snapshot(1).fading, false)
    assert.deepEqual(render(mixer, 60).events, [])
    mixer.command({ op: 'fade', id: 1, target: 100000, time: 120, delay: 0 })
    mixer.command({ op: 'unload', id: 1, status })
    const completedWithoutMedia = render(mixer, 120)
    assert.deepEqual(completedWithoutMedia.left, Array(120).fill(0))
    assert.equal(completedWithoutMedia.events.length, 1)
    const event = completedWithoutMedia.events[0]!
    assert(event.type === 'fade'); assert.equal(event.snapshot.status, status)
    assert.equal(event.snapshot.volume, 100000)
    mixer.command({ op: 'close', id: 1 })
    assert.deepEqual(mixer.inspect(), { voices: 0, fadingVoices: 0, liveMidiNotes: 0, clockWork: false })
  }
})
