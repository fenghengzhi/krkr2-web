import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { waveMaskCases, waveMaskFiles } from '../helpers/wave-speaker-mask.ts'
import { quadFiles, quadRows } from '../helpers/wave-quad.ts'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const output = resolve('out/ci/wave-speaker-mask-reference'), results: unknown[] = [], commands: unknown[] = [],
  files = waveMaskFiles(), hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
mkdirSync(output, { recursive: true })
const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + '\n')
save('comparison.json', { complete: false, results })
try {
  for (const entry of waveMaskCases) {
    const bytes = files[`mask-${entry.name}.wav`] as Uint8Array, input = resolve(output, entry.name + '.wav')
    writeFileSync(input, bytes)
    const probeArgs = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input]
    commands.push({ executable: 'ffprobe', args: probeArgs }); save('commands.json', commands)
    const probe = JSON.parse(execFileSync('ffprobe', probeArgs, { encoding: 'utf8', timeout: 30000 }))
    save(entry.name + '.ffprobe.json', probe)
    assert.equal(probe.streams.length, 1); assert.equal(probe.streams[0].channels, entry.row.length)
    assert.equal(probe.streams[0].sample_rate, '8000'); assert.equal(probe.streams[0].codec_name, 'pcm_s16le')
    assert.equal(typeof probe.streams[0].channel_layout, 'string')
    const pan = `aformat=sample_fmts=flt,pan=stereo|FL=${entry.pan[0]}|FR=${entry.pan[1]}`,
      args = ['-nostdin', '-v', 'error', '-i', input, '-af', pan, '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1']
    commands.push({ executable: 'ffmpeg', args }); save('commands.json', commands)
    const reference = execFileSync('ffmpeg', args, { timeout: 30000, maxBuffer: 1024 * 1024 }),
      view = new DataView(reference.buffer, reference.byteOffset, reference.byteLength),
      asset = decodeWav(bytes, { nativeRiff: true })!, mixer = new AudioMixer(8000),
      left = new Float32Array(32000), right = new Float32Array(32000)
    writeFileSync(resolve(output, entry.name + '.f32le'), reference)
    assert.equal(reference.length, 32000 * 2 * 4); assert.equal(asset.speakerMask, entry.mask)
    mixer.command({ op: 'load', id: 1, asset, kind: 'wave', settings: defaultSoundSettings() }); mixer.command({ op: 'play', id: 1 })
    let maximumReferenceError = 0
    try {
      mixer.render(left, right)
      for (let frame = 0; frame < 32000; frame++) for (const channel of [0, 1]) {
        const amplitude = entry.stereo[channel]!, expected = amplitude === 0 ? 0 : Math.fround(frame % 8 < 4 ? amplitude : -amplitude),
          native = view.getFloat32((frame * 2 + channel) * 4, true), actual = channel ? right[frame]! : left[frame]!
        const error = Math.abs(native - expected)
        assert(Number.isFinite(native) && (expected === 0 ? native === 0 : error <= 2 ** -23),
          `${entry.name} FFmpeg channel ${channel}, frame ${frame}: ${native} vs ${expected}`)
        maximumReferenceError = Math.max(maximumReferenceError, error)
        assert.equal(actual, expected, `${entry.name} mixer channel ${channel}, frame ${frame}`)
      }
    } finally { mixer.command({ op: 'shutdown' }) }
    results.push({ name: entry.name, speakerMask: entry.mask, inputSha256: hash(bytes), referenceSha256: hash(reference),
      channelLayout: probe.streams[0].channel_layout, frames: 32000, channels: 2,
      maximumReferenceError, referenceAbsoluteTolerance: 2 ** -23, matched: true })
    save('comparison.json', { complete: false, results })
  }
  // Fixed WaveImpl.cpp duplicates mono/stereo to FL/FR/BL/BR. Independently
  // materialize all four planes with FFmpeg before applying the pre-existing
  // Web downmix policy. Preserve both raw outputs, not just a scalar summary.
  for (const channels of [1, 2]) {
    const name = `quad-expand-${channels === 1 ? 'mono' : 'stereo'}`, frames = 8208,
      bytes = quadFiles()[channels === 1 ? 'quad-mono.wav' : 'quad-stereo.wav'], input = resolve(output, name + '.wav'),
      expandedPath = resolve(output, name + '.quad.f32le'), rightSource = channels === 1 ? 'c0' : 'c1'
    writeFileSync(input, bytes)
    const probeArgs = ['-v', 'error', '-show_streams', '-of', 'json', input]
    commands.push({ executable: 'ffprobe', args: probeArgs }); save('commands.json', commands)
    const probe = JSON.parse(execFileSync('ffprobe', probeArgs, { encoding: 'utf8', timeout: 30000 }))
    save(name + '.ffprobe.json', probe)
    assert.equal(probe.streams.length, 1); assert.equal(probe.streams[0].channels, channels)
    assert.equal(probe.streams[0].sample_rate, '1000'); assert.equal(probe.streams[0].codec_name, 'pcm_s16le')
    const quadArgs = ['-nostdin', '-v', 'error', '-i', input, '-af',
      `aformat=sample_fmts=flt,pan=quad|FL=c0|FR=${rightSource}|BL=c0|BR=${rightSource}`,
      '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1']
    commands.push({ executable: 'ffmpeg', args: quadArgs }); save('commands.json', commands)
    const quad = execFileSync('ffmpeg', quadArgs, { timeout: 30000, maxBuffer: 1024 * 1024 }),
      quadView = new DataView(quad.buffer, quad.byteOffset, quad.byteLength)
    writeFileSync(expandedPath, quad); assert.equal(quad.length, frames * 4 * 4)
    for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 4; channel++)
      assert.equal(quadView.getFloat32((frame * 4 + channel) * 4, true),
        quadRows[frame % 8]![channels === 1 ? 0 : channel % 2], `${name} duplicated plane ${channel}:${frame}`)
    const stereoArgs = ['-nostdin', '-v', 'error', '-f', 'f32le', '-ar', '1000', '-ac', '4', '-channel_layout', 'quad',
      '-i', expandedPath, '-af', 'pan=stereo|FL=FL+0.70710678*BL|FR=FR+0.70710678*BR',
      '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1']
    commands.push({ executable: 'ffmpeg', args: stereoArgs }); save('commands.json', commands)
    const reference = execFileSync('ffmpeg', stereoArgs, { timeout: 30000, maxBuffer: 1024 * 1024 }),
      view = new DataView(reference.buffer, reference.byteOffset, reference.byteLength), mixer = new AudioMixer(1000),
      left = new Float32Array(frames), right = new Float32Array(frames), asset = decodeWav(bytes, { nativeRiff: true })!
    writeFileSync(resolve(output, name + '.stereo.f32le'), reference); assert.equal(reference.length, frames * 2 * 4)
    let maximumReferenceError = 0
    try {
      mixer.command({ op: 'load', id: 1, kind: 'wave', asset, settings: { ...defaultSoundSettings(), waveExpandQuad: true } })
      mixer.command({ op: 'play', id: 1 }); mixer.render(left, right)
      assert.equal(mixer.snapshot(1).channels, 4)
      for (let frame = 0; frame < frames; frame++) for (const channel of [0, 1]) {
        const value = quadRows[frame % 8]![channels === 1 ? 0 : channel]!,
          expected = value === 0 ? 0 : Math.fround(value + value * 0.70710678),
          independent = view.getFloat32((frame * 2 + channel) * 4, true), actual = channel ? right[frame]! : left[frame]!,
          error = Math.abs(independent - expected)
        assert(Number.isFinite(independent) && error <= 2 ** -23, `${name} stereo ${channel}:${frame}`)
        maximumReferenceError = Math.max(maximumReferenceError, error)
        assert.equal(actual, expected, `${name} exact Web output ${channel}:${frame}`)
      }
    } finally { mixer.command({ op: 'shutdown' }) }
    results.push({ name, frames, inputChannels: channels, outputChannels: 4, inputSha256: hash(bytes),
      quadSha256: hash(quad), referenceSha256: hash(reference), maximumReferenceError,
      referenceAbsoluteTolerance: 2 ** -23, matched: true })
    save('comparison.json', { complete: false, results })
  }
  save('comparison.json', { complete: true, matched: results.length, results,
    scope: 'FFmpeg resolves declared speaker names from actual WAVE headers; two further cases independently duplicate mono/stereo into four raw planes as in fixed WaveImpl. Explicit pan coefficients compare the Web stereo policy; not a physical Windows driver equivalence claim.' })
} catch (error) {
  save('comparison.json', { complete: false, results, error: error instanceof Error ? error.message : String(error) })
  throw error
}
