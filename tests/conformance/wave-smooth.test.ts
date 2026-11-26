import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { integerCrossfade, fillWaveCrossfade } from '../../src/engine/media/wave-crossfade.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, type PcmAsset, type StreamingPcmAsset } from '../../src/engine/ports/audio.ts'
import { streamPageFrames } from '../../src/engine/media/stream-pcm.ts'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { parseSliBytes } from '../../src/formats/audio/sli.ts'
import { smoothBefore, smoothAfter, smoothShortAfter, smoothInside, smoothSamples, waveSmoothFiles } from '../helpers/wave-smooth.ts'

test('integer smooth crossfade uses exact signed Q32 term floors and original container wrapping', () => {
  for (const bits of [8, 16, 24, 32]) {
    const scale = 2 ** (bits - 1)
    for (const a of [-scale, -scale + 1, -1, 0, 1, scale - 1])
      for (const b of [-scale, -1, 0, scale - 1])
        for (const ratio of [0, 1, 0x55555555, 0x7fffffff, 0x80000000, 0xffffffff]) {
          const exact = (BigInt(b) * BigInt(ratio) >> 32n) + (BigInt(a) * (0x100000000n - BigInt(ratio)) >> 32n),
            expected = Number(BigInt.asIntN(bits, exact)) / scale
          assert.equal(integerCrossfade(a / scale, b / scale, ratio, bits, bits), expected, `${bits}:${a}:${b}:${ratio}`)
        }
  }
})

test('hosted stock C++ crossfade template independently reproduces the full authored PCM16 seam', { timeout: 30000 }, async () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  const run = promisify(execFile), directory = resolve('out/ci/wave-smooth-reference'),
    original = await readFile('third_party/phase-vocoder/original/WaveLoopManager.cpp'),
    digest = createHash('sha256').update(original).digest('hex'), source = original.toString('utf8').replace(/\r\n/g, '\n'),
    start = source.indexOf('template <typename T>\nstatic void TVPCrossFadeIntegerBlend'), end = source.indexOf('\n}\n', start) + 3
  assert.equal(digest, '9bf9d7339317927c82e8f21aa5cd06cce3e3d0fb15fbfc80aa8f0c0001e38a78')
  assert(start >= 0 && end > start)
  const originalFunction = source.slice(start, end), code = `#include <cstdint>\n#include <cstdio>\n#include <array>\nusing tjs_int=std::int32_t;using tjs_uint=std::uint32_t;using tjs_int64=std::int64_t;using tjs_uint64=std::uint64_t;\n${originalFunction.replaceAll('ui64', 'ULL')}\nint main(){std::array<std::int16_t,32>a,b,out;a.fill(16384);b.fill(-8192);TVPCrossFadeIntegerBlend<std::int16_t>(out.data(),a.data(),b.data(),0,50,8,1);TVPCrossFadeIntegerBlend<std::int16_t>(out.data()+8,a.data()+8,b.data()+8,50,100,24,1);for(int i=0;i<32;i++)std::printf("%s%d",i?",":"",int(out[i]));std::puts("");}\n`
  await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, 'reference.cpp'), code)
  const execute = async (name: string, command: string, args: string[]): Promise<string> => {
    try {
      const result = await run(command, args, { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
      await writeFile(resolve(directory, name + '.stdout'), result.stdout); await writeFile(resolve(directory, name + '.stderr'), result.stderr)
      return result.stdout
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string }
      await writeFile(resolve(directory, name + '.stdout'), result.stdout ?? '')
      await writeFile(resolve(directory, name + '.stderr'), result.stderr ?? result.message)
      throw error
    }
  }
  const compiler = await execute('compiler', 'c++', ['--version'])
  await execute('build', 'c++', ['-std=c++17', '-O0', resolve(directory, 'reference.cpp'), '-o', resolve(directory, 'reference')])
  const raw = await execute('run', resolve(directory, 'reference'), []), actual = raw.trim().split(',').map(Number), expected = [...smoothBefore, ...smoothAfter]
  await writeFile(resolve(directory, 'comparison.json'), JSON.stringify({ sourceSha256: digest, compiler, actual, expected,
    scope: 'Fixed source template; only Borland ui64 numeric suffix is spelled ULL. Host-compiled integer kernel, not the original Windows binary or hardware output.' }, null, 2))
  assert.deepEqual(actual, expected)
})

test('ordinary unfiltered Wave playback uses two ramps, target-link clipping and a seek inside the pre-ramp', () => {
  const files = waveSmoothFiles()
  for (const [name, start, expected] of [
    ['smooth.wav', 72, [...smoothBefore, ...smoothAfter]],
    ['smooth-short.wav', 72, [...smoothBefore, ...smoothShortAfter, -8192, -8192, -8192, -8192]],
    ['smooth.wav', 76, smoothInside],
    ['smooth.wav', 80, [-8192, -8192, -8192, -8192]],
  ] as const) {
    const asset = decodeWav(files[name]!)!, mixer = new AudioMixer(1000)
    asset.loops = parseSliBytes(files[`${name}.sli`]!)
    mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
    mixer.command({ op: 'set', id: 1, property: 'position', value: start }); mixer.command({ op: 'play', id: 1 })
    const left = new Float32Array(expected.length), right = new Float32Array(expected.length), events = mixer.render(left, right)
    assert.deepEqual([...left], smoothSamples(expected), `${name}:${start}`); assert.deepEqual(right, left)
    assert.equal(events.filter((event) => event.type === 'error').length, 0)
    mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0)
  }
})

test('declared float PCM and old untagged assets preserve their distinct ramp arithmetic', () => {
  const destination = [new Float32Array(4)]
  fillWaveCrossfade(destination, 0, 10, 2, 2, 'f32', 32, (_, at) => at < 10 ? 0.5 : -0.25, () => {})
  assert.deepEqual([...destination[0]!], [0.5, 0.3125, 0.125, -0.0625])
  const legacy = [new Float32Array(32)]
  fillWaveCrossfade(legacy, 0, 100, 8, 24, undefined, 32, (_, at) => at < 100 ? 0.5 : -0.25, () => {})
  assert.equal(legacy[0]![8], 0.125)
  assert.equal(legacy[0]![9], 3584 / 32768)
  assert.notEqual(legacy[0]![9], smoothAfter[1]! / 32768, 'Undeclared legacy planes must not be guessed to be PCM16')
})

test('ordinary Smooth voices reserve crossfade and playback storage before replacing any active voice', () => {
  const asset: PcmAsset = { kind: 'pcm', sampleRate: 384000, sampleCount: 19200, channels: 8,
    bits: 16, pcmEncoding: 's16', data: Array.from({ length: 8 }, () => new Float32Array(19200)),
    loops: { links: [{ from: 12000, to: 10000, smooth: true, condition: 'no', variable: 0, reference: 0 }], labels: [] } },
    mixer = new AudioMixer(48000)
  // Each voice reserves 19,200 * 8 * 4 crossfade bytes plus 4 * 256 * 8 * 4
  // playback bytes. 103 fit the 64 MiB workspace cap; 104 exceed it while
  // the separate decoded-PCM budget is still below 128 MiB.
  try {
    for (let id = 1; id <= 103; id++) mixer.command({ op: 'load', id, asset, settings: defaultSoundSettings() })
    const before = mixer.snapshot(1)
    assert.throws(() => mixer.command({ op: 'load', id: 104, asset, settings: defaultSoundSettings() }),
      { message: 'Audio filter session budget exceeded' })
    assert.equal(mixer.inspect().voices, 103); assert.deepEqual(mixer.snapshot(1), before)
    mixer.command({ op: 'close', id: 103 })
    mixer.command({ op: 'load', id: 104, asset, settings: defaultSoundSettings() })
    assert.equal(mixer.inspect().voices, 103)
  } finally { mixer.command({ op: 'shutdown' }) }
  assert.equal(mixer.inspect().voices, 0)
})

test('ordinary Smooth streaming holds audible state for its missing target and retires late pages on reopen', () => {
  const mixer = new AudioMixer(1000),
    asset: StreamingPcmAsset = { kind: 'stream', streamId: 1, sampleRate: 1000, sampleCount: 32768,
      channels: 1, bits: 16, pcmEncoding: 's16',
      initial: [{ position: 8192, data: [new Float32Array(streamPageFrames).fill(0.5)] }],
      loops: { links: [{ from: 12000, to: 20000, smooth: true, condition: 'no', variable: 0, reference: 0 }],
        labels: [{ position: 11975, name: ':[0]++' }, { position: 20000, name: 'jump' }] } }
  try {
    mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
    mixer.command({ op: 'set', id: 1, property: 'position', value: 11975 }); mixer.command({ op: 'play', id: 1 })
    const before = mixer.snapshot(1), left = new Float32Array(8), right = new Float32Array(8)
    assert.deepEqual(mixer.render(left, right), [])
    assert.deepEqual([...left], Array(8).fill(0)); assert.deepEqual(right, left)
    assert.deepEqual(mixer.snapshot(1), before, 'Neither source position nor flag/label state advances before both sides exist')
    const requests = mixer.takeStreamRequests()
    assert.deepEqual(requests.map((request) => request.position), [16384])
    mixer.command({ op: 'close', id: 1 })
    mixer.command({ op: 'load', id: 1, asset: { ...asset, streamId: 2, loops: { links: [], labels: [] },
      initial: [{ position: 0, data: [new Float32Array(streamPageFrames).fill(0.25)] }] }, settings: defaultSoundSettings() })
    for (const request of requests)
      mixer.command({ op: 'streamData', request, data: [new Float32Array(request.frames).fill(-0.75)] })
    assert.equal(mixer.inspectStreams().pending, 0)
    mixer.command({ op: 'play', id: 1 })
    assert.deepEqual(mixer.render(left, right), [])
    assert.deepEqual([...left], Array(8).fill(0.25)); assert.deepEqual(right, left)
    assert.equal(mixer.snapshot(1).position, 8); assert.equal(mixer.snapshot(1).flags[0], 0)
  } finally { mixer.command({ op: 'shutdown' }) }
  assert.deepEqual(mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
})
