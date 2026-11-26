import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { decodePortableAudio } from '../../src/backends/audio/decode.ts'
import { openPortablePcmSource } from '../../src/backends/audio/pcm-source.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { PortAudioBackend } from '../../src/backends/audio/port-backend.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, emptyLoops, type AudioCommand } from '../../src/engine/ports/audio.ts'
import type { AudioRequest } from '../../src/protocol/audio.ts'
import { AudioClock } from '../helpers/audio.ts'
import { samplerSmallChannels, waveSamplerFiles } from '../helpers/wave-sampler.ts'

test('stock Wave decoding ignores sampler records while standalone RIFF readers keep their explicit sampler capability', async () => {
  const files = waveSamplerFiles()
  for (const name of ['sampler-before.wav', 'sampler-after.wav', 'sampler-ignored.wav']) {
    const bytes = files[name]!, ranges: [number, number][] = [], source = { size: bytes.length,
      async read(at: number, length: number) { ranges.push([at, length]); return bytes.slice(at, at + length) } }
    if (name === 'sampler-ignored.wav') {
      assert.throws(() => decodeWav(bytes), /Truncated WAVE sample loop/)
      await assert.rejects(openPortablePcmSource(source), /Truncated WAVE sample loop/)
    } else {
      const generic = decodeWav(bytes)!, range = await openPortablePcmSource(source)
      assert(range)
      try {
        assert.deepEqual(generic.loops.links, [{ from: 40, to: 20, smooth: false,
          condition: 'no', variable: 0, reference: 0, whenLooping: true }])
        assert.deepEqual(range.info.loops, generic.loops)
        const direct = new AudioMixer(1000), left = new Float32Array(80), right = new Float32Array(80)
        direct.command({ op: 'load', id: 1, kind: 'wave', asset: generic, settings: { ...defaultSoundSettings(), looping: true } })
        direct.command({ op: 'play', id: 1 }); direct.render(left, right); direct.command({ op: 'shutdown' })
        assert.deepEqual([[...left], [...right]], samplerSmallChannels.map((plane) =>
          [...plane.slice(0, 40), ...plane.slice(20, 40), ...plane.slice(20, 40)]), 'An explicit embedding load keeps its supplied sampler loop')
      } finally { await range.close() }
    }
    ranges.length = 0
    const actual = await decodePortableAudio(bytes, 'wave'), range = await openPortablePcmSource(source, { waveSamplerLoops: false })
    assert(actual?.kind === 'pcm'); assert(range)
    try {
      assert.deepEqual(actual.loops, emptyLoops()); assert.deepEqual(range.info.loops, emptyLoops())
      assert.deepEqual(actual.data.map((plane) => [...plane]), samplerSmallChannels)
      assert.deepEqual((await range.read(0, 60)).map((plane) => [...plane]), samplerSmallChannels)
      const body = name === 'sampler-after.wav' ? 44 + 60 * 4 + 8 : 44
      assert(ranges.every(([at, length]) => at + length <= body || at >= body + 60), 'Sampler body is neither parsed nor allocated by the stock path')
    } finally { await range.close() }
  }
})

test('complete and streamed Wave playback loop the whole song, reach its tail when looping is disabled, and obey explicit SLI', { timeout: 30000 }, async () => {
  const files = waveSamplerFiles()
  for (const streamed of [false, true]) for (const name of ['sampler-before.wav', 'sampler-after.wav', 'sampler-ignored.wav']) {
    const clock = new AudioClock(), output: number[][] = [[], []], bytes = files[name]!,
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => { output[0]!.push(...l); output[1]!.push(...r) }, 1000)
    let releases = 0
    const opening = (sli: boolean): AudioCommand => ({ ...(streamed
      ? { op: 'openSource' as const, source: { size: bytes.length, async read(at: number, length: number) { return bytes.slice(at, at + length) } },
        bufferedBytes: 0, releaseSource: () => { releases++ } }
      : { op: 'open' as const, bytes }), id: 1, kind: 'wave', settings: { ...defaultSoundSettings(), looping: !sli },
      loops: sli ? { links: [{ from: 60, to: 40, smooth: false, condition: 'no', variable: 0, reference: 0 }], labels: [] } : emptyLoops() })
    try {
      await audio.command(opening(false)); await audio.command({ op: 'play', id: 1 }); clock.advance(80)
      assert.deepEqual(output, samplerSmallChannels.map((channel) => [...channel, ...channel.slice(0, 20)]))
      assert.equal(audio.mixer.snapshot(1).position, 20)
      output.forEach((channel) => { channel.length = 0 })
      await audio.command({ op: 'set', id: 1, property: 'looping', value: false }); clock.advance(60)
      assert.deepEqual(output, samplerSmallChannels.map((channel) => [...channel.slice(20), ...Array<number>(20).fill(0)]))
      assert.equal(audio.mixer.snapshot(1).status, 'stop'); assert.equal(audio.mixer.snapshot(1).position, 0)
      await audio.command({ op: 'close', id: 1 }); output.forEach((channel) => { channel.length = 0 })
      await audio.command(opening(true)); await audio.command({ op: 'play', id: 1 }); clock.advance(100)
      assert.deepEqual(output, samplerSmallChannels.map((channel) => [...channel, ...channel.slice(40), ...channel.slice(40)]))
      assert.equal(audio.mixer.snapshot(1).status, 'play'); assert.equal(audio.mixer.snapshot(1).looping, false)
    } finally { await audio.close() }
    assert.equal(releases, streamed ? 2 : 0); assert.equal(clock.tasks.size, 0)
    assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
  }
})

test('audio port open treats game SLI as authoritative even when an embedding decoder supplies RIFF sampler loops', { timeout: 30000 }, async () => {
  const channel = new MessageChannel(), mixer = new AudioMixer(1000), bytes = waveSamplerFiles()['sampler-before.wav']!,
    audio = new PortAudioBackend(channel.port1, async (input) => decodeWav(input),
      async (input) => openPortablePcmSource(input)), seen: string[] = []
  channel.port2.onmessage = ({ data }: MessageEvent<AudioRequest>) => {
    try {
      const { command, serial } = data
      if (command.op === 'open' || command.op === 'focusMode') throw new Error('Expected a real decoded PCM load')
      if (command.op === 'load') { seen.push(command.asset.kind); assert.deepEqual(command.asset.loops, emptyLoops()) }
      channel.port2.postMessage({ type: 'reply', serial, result: mixer.command(command) })
    } catch (error) { channel.port2.postMessage({ type: 'reply', serial: data.serial, error: String(error) }) }
  }
  try {
    for (const streamed of [false, true]) {
      await audio.command({ ...(streamed
        ? { op: 'openSource' as const, source: { size: bytes.length, async read(at: number, length: number) { return bytes.slice(at, at + length) } }, bufferedBytes: 0 }
        : { op: 'open' as const, bytes }), id: 1, kind: 'wave', loops: emptyLoops(), settings: { ...defaultSoundSettings(), looping: true } })
      await audio.command({ op: 'play', id: 1 })
      const left = new Float32Array(80), right = new Float32Array(80)
      mixer.render(left, right)
      assert.deepEqual([...left], [...samplerSmallChannels[0], ...samplerSmallChannels[0].slice(0, 20)])
      assert.deepEqual([...right], [...samplerSmallChannels[1], ...samplerSmallChannels[1].slice(0, 20)])
      await audio.command({ op: 'close', id: 1 })
    }
    assert.deepEqual(seen, ['pcm', 'stream'])
  } finally { await audio.close(); channel.port1.close(); channel.port2.close() }
  assert.equal(mixer.inspect().voices, 0)
})
