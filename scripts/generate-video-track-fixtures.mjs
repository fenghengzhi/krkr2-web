import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// This is executable verification setup, and must never run on a developer's
// computer or a self-hosted runner. All tests receive these exact shared files.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Video track fixtures require GitHub-hosted Actions')

const directory = resolve('out/verification/video-tracks')
mkdirSync(directory, { recursive: true })
const original = resolve('tests/fixtures/video/colors.mp4'),
  regular = resolve(directory, 'multitrack.mp4'), fragmented = resolve(directory, 'fragmented.mp4'),
  separate = resolve(directory, 'separate-fragments.mp4'),
  interleaved = resolve(directory, 'interleaved.mp4'),
  common = ['-hide_banner', '-loglevel', 'error', '-y'], commands = []
const run = (args) => {
  commands.push(args)
  execFileSync('ffmpeg', [...common, ...args], { stdio: 'inherit', timeout: 120000 })
}
run(['-stream_loop', '3', '-i', original,
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=6',
  '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-c:v', 'copy', '-c:a', 'aac',
  '-b:a', '96k', '-ac', '2', '-t', '6', '-metadata:s:a:0', 'language=jpn',
  '-metadata:s:a:1', 'language=eng', '-disposition:a:0', 'default', '-disposition:a:1', '0',
  '-movflags', '+faststart', regular])
run(['-i', regular, '-map', '0', '-c', 'copy', '-movflags', '+empty_moov+default_base_moof+frag_keyframe', fragmented])
run(['-i', regular, '-map', '0', '-c', 'copy', '-movflags', '+empty_moov+default_base_moof+frag_keyframe+separate_moof', separate])
run(['-i', regular, '-map', '0', '-c', 'copy', '-movflags', '+empty_moov+default_base_moof+frag_keyframe',
  '-frag_interleave', '1', interleaved])
const files = [regular, fragmented, separate, interleaved].map((file) => {
  const bytes = readFileSync(file), metadata = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], { encoding: 'utf8', timeout: 30000 }))
  const video = metadata.streams.filter((stream) => stream.codec_type === 'video'),
    audio = metadata.streams.filter((stream) => stream.codec_type === 'audio')
  if (video.length !== 1 || audio.length !== 2 ||
      video[0].width !== 64 || video[0].height !== 48 ||
      audio.some((stream) => stream.codec_name !== 'aac' || stream.sample_rate !== '48000' || stream.channels !== 2))
    throw new Error(`Unexpected generated video tracks: ${file}`)
  const sha256 = createHash('sha256').update(bytes).digest('hex'),
    packetCommand = ['-v', 'error', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', file],
    packetOutput = JSON.parse(execFileSync('ffprobe', packetCommand, { encoding: 'utf8', timeout: 30000,
      maxBuffer: 8 * 1024 * 1024 }))
  if (!Array.isArray(packetOutput.packets) || !packetOutput.packets.length)
    throw new Error(`No independent packet inventory: ${file}`)
  writeFileSync(file + '.packets.json', JSON.stringify({ schema: 1, file: file.split('/').at(-1), sha256,
    command: packetCommand, streams: metadata.streams, packets: packetOutput.packets }, null, 2) + '\n')
  return { file: file.split('/').at(-1), bytes: bytes.length,
    sha256, metadata, packetCount: packetOutput.packets.length }
})
const provenance = {
  commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  runner: process.env.RUNNER_ENVIRONMENT,
  generator: 'scripts/generate-video-track-fixtures.mjs',
  license: 'Project-owned synthetic frames and sine waves; no external media content.',
  original: { file: 'tests/fixtures/video/colors.mp4', sha256: createHash('sha256').update(readFileSync(original)).digest('hex') },
  audio: [{ index: 0, frequency: 440, language: 'jpn' }, { index: 1, frequency: 880, language: 'eng' }],
  ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }), commands, files,
}
writeFileSync(resolve(directory, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n')
console.log(JSON.stringify(files.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })), null, 2))
