import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { waveMaskCases, waveMaskFiles } from '../helpers/wave-speaker-mask.ts'
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
  save('comparison.json', { complete: true, matched: results.length, results,
    scope: 'FFmpeg resolves declared speaker names from actual WAVE headers. Explicit pan coefficients compare the Web stereo policy; not a physical Windows driver equivalence claim.' })
} catch (error) {
  save('comparison.json', { complete: false, results, error: error instanceof Error ? error.message : String(error) })
  throw error
}
