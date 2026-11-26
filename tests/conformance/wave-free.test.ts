import test from 'node:test'
import assert from 'node:assert/strict'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, type PcmAsset } from '../../src/engine/ports/audio.ts'

const asset = (): PcmAsset => ({ kind: 'pcm', sampleRate: 1000, sampleCount: 16000, channels: 1, bits: 16,
  data: [new Float32Array(16000).fill(0.25)], loops: { links: [], labels: [{ name: 'first', position: 10 }] } })
const render = (mixer: AudioMixer, count: number) => {
  const left = new Float32Array(count), right = new Float32Array(count), events = mixer.render(left, right)
  assert.deepEqual(right, left); return { samples: [...left], events }
}

test('releasing Wave rendering buffers keeps the loaded PCM, loop flags and fading clock, including Stop callback replay', () => {
  const mixer = new AudioMixer(1000)
  mixer.command({ op: 'load', id: 1, kind: 'wave', asset: asset(), settings: defaultSoundSettings() })
  mixer.command({ op: 'flag', id: 1, index: 0, value: 7 })
  mixer.command({ op: 'play', id: 1 }); mixer.command({ op: 'fade', id: 1, target: 0, time: 120, delay: 0 })
  assert.deepEqual(render(mixer, 20).samples, Array(20).fill(0.25))
  mixer.command({ op: 'stop', id: 1 }); mixer.command({ op: 'releaseWaveBuffer', id: 1 })
  const freed = mixer.snapshot(1)
  assert.equal(freed.status, 'stop'); assert.equal(freed.sampleCount, 16000)
  assert.equal(freed.flags[0], 7); assert.equal(freed.fading, true)
  assert.deepEqual(render(mixer, 60).samples, Array(60).fill(0))
  assert.equal(mixer.snapshot(1).volume, 50000)
  mixer.command({ op: 'play', id: 1 })
  const resumed = render(mixer, 40)
  assert.deepEqual(resumed.samples, [...Array(39).fill(Math.fround(0.25 * 10 ** (-1505 / 2000))), 0])
  assert.equal(resumed.events.filter((event) => event.type === 'fade').length, 1)
  mixer.command({ op: 'set', id: 1, property: 'volume', value: 100000 })
  mixer.command({ op: 'set', id: 1, property: 'paused', value: true })
  mixer.command({ op: 'stop', id: 1 })
  mixer.command({ op: 'play', id: 1 }) // the synchronous Stop callback
  assert.deepEqual(mixer.command({ op: 'releaseWaveBuffer', id: 1 }).events, [])
  assert.equal(mixer.snapshot(1).status, 'play', 'Destroy does not itself deliver a second status change')
  assert.equal(mixer.hasClockWork, true, 'Paused replay still admits the deferred stopped-state observation')
  const retired = render(mixer, 20)
  assert.deepEqual(retired.samples, Array(20).fill(0))
  assert.equal(retired.events.filter((event) => event.type === 'ended').length, 1)
  mixer.command({ op: 'set', id: 1, property: 'position', value: 123 })
  assert.equal(mixer.snapshot(1).position, 0, 'A destroyed secondary buffer has no device cursor')
  mixer.command({ op: 'set', id: 1, property: 'paused', value: false })
  mixer.command({ op: 'play', id: 1 })
  assert.deepEqual(render(mixer, 20).samples, Array(20).fill(0.25))
  assert.equal(mixer.snapshot(1).position, 143, 'The retained decoder nevertheless honors the next play position')
})

test('released streaming Wave pages stay absent until replay and an old outstanding read cannot populate the new cache', () => {
  const mixer = new AudioMixer(1000), pcm = asset()
  mixer.command({ op: 'load', id: 1, kind: 'wave', settings: defaultSoundSettings(), asset: {
    kind: 'stream', streamId: 1, sampleRate: 1000, sampleCount: 16000, channels: 1, bits: 16,
    loops: pcm.loops, initial: [{ position: 0, data: [pcm.data[0]!.slice(0, 4096)] }],
  } })
  mixer.command({ op: 'play', id: 1 }); const old = mixer.takeStreamRequests()
  assert.equal(old.length, 2)
  mixer.command({ op: 'stop', id: 1 }); mixer.command({ op: 'releaseWaveBuffer', id: 1 })
  assert.equal(mixer.inspectStreams().bytes, 0); assert.equal(mixer.inspectStreams().pending, 2)
  mixer.command({ op: 'play', id: 1 }); const current = mixer.takeStreamRequests()
  assert.equal(current.length, 1, 'Old in-flight reads still consume their decoder permits')
  for (const request of old) mixer.command({ op: 'streamData', request, data: [new Float32Array(request.frames).fill(0.75)] })
  assert.equal(mixer.inspectStreams().bytes, 0); assert.equal(mixer.inspectStreams().pending, 1)
  for (const request of current) mixer.command({ op: 'streamData', request,
    data: [pcm.data[0]!.slice(request.position, request.position + request.frames)] })
  const played = render(mixer, 20)
  assert.deepEqual(played.samples, Array(20).fill(0.25))
  assert.deepEqual(played.events.flatMap((event) => event.type === 'label' ? [event.label] : []), ['first'])
  const refilled = mixer.takeStreamRequests()
  assert.equal(refilled.length, 2)
  assert(refilled.every((request) => request.serial > current[0]!.serial))
})
