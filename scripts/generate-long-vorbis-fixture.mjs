import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Verification material only. Product decoding never runs an external encoder.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Long Vorbis fixture generation requires GitHub-hosted Actions')
const directory = resolve('out/verification/long-vorbis'), commands = [], rate = 48000, seconds = 96
mkdirSync(directory, { recursive: true })
const run = (program, args) => {
  commands.push({ program, args })
  writeFileSync(resolve(directory, 'commands.json'), JSON.stringify(commands, null, 2) + '\n')
  return execFileSync(program, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
}
try {
  // Each 32-second phrase has a different fundamental. Unequal, opposite
  // stereo planes catch channel swaps/downmixes as well as a stale seek page.
  const input = 'aevalsrc=0.35*sin(2*PI*(440+220*floor(t/32))*t)|-0.21*sin(2*PI*(440+220*floor(t/32))*t):s=48000:d=96',
    file = resolve(directory, 'long-bgm.ogg')
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', input,
    '-c:a', 'libvorbis', '-q:a', '5', '-page_duration', '200000', file])
  const bytes = readFileSync(file), metadata = JSON.parse(run('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString())
  if (metadata.streams.length !== 1 || metadata.streams[0].codec_name !== 'vorbis' ||
      metadata.streams[0].sample_rate !== String(rate) || metadata.streams[0].channels !== 2 ||
      Number(metadata.streams[0].duration_ts) !== rate * seconds)
    throw new Error('Unexpected long Vorbis stream inventory')
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-f', 'f32le',
    '-c:a', 'pcm_f32le', resolve(directory, 'independent.f32')])
  const independent = readFileSync(resolve(directory, 'independent.f32'))
  if (independent.length !== rate * seconds * 2 * 4) throw new Error('Independent Vorbis PCM length differs')
  const hash = (data) => createHash('sha256').update(data).digest('hex')
  writeFileSync(resolve(directory, 'reference.json'), JSON.stringify({ schema: 1, file: 'long-bgm.ogg',
    bytes: bytes.length, sha256: hash(bytes), rate, seconds, samples: rate * seconds,
    independent: { file: 'independent.f32', bytes: independent.length, sha256: hash(independent),
      scope: 'Independent FFmpeg decoded duration and audible phrase reference; exact random-access PCM uses the same production codec in uninterrupted sequential mode.' },
    phrases: [440, 660, 880], phraseSeconds: 32, metadata, commands,
    ffmpeg: run('ffmpeg', ['-version']).toString(), complete: true }, null, 2) + '\n')
} catch (error) {
  writeFileSync(resolve(directory, 'failure.txt'), String(error?.stack ?? error) + '\n')
  throw error
}
