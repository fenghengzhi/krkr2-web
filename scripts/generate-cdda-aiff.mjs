import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('CD audio fixture generation requires GitHub-hosted Actions')
const directory = resolve('out/verification/cdda-aiff'), rate = 44100, frames = rate * 3
mkdirSync(directory, { recursive: true })
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const file = (name) => resolve(directory, name)
const manifest = { complete: false, rate, frames, channels: 2, commit: process.env.GITHUB_SHA,
  ffmpeg: '', rawSha256: '', commands: [], variants: [] }
const run = (tool, args) => {
  manifest.commands.push([tool, ...args])
  return execFileSync(tool, args, { cwd: directory, timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
}
try {
  manifest.ffmpeg = run('ffmpeg', ['-version']).toString()
  const raw = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const first = i < 2 * rate, angle = i * 2 * Math.PI / rate
    raw.writeInt16LE(Math.round(12000 * Math.sin(angle * (first ? 330 : 660))), i * 4)
    raw.writeInt16LE(Math.round(7000 * Math.sin(angle * (first ? 550 : 990))), i * 4 + 2)
  }
  writeFileSync(file('source.s16le'), raw)
  manifest.rawSha256 = hash(raw)
  for (const [codec, name] of [['pcm_s24be', 'disc.aiff'], ['pcm_s16le', 'disc-le.aifc'],
    ['pcm_f32be', 'disc-f32.aifc'], ['pcm_f64be', 'disc-f64.aifc']]) {
    run('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', String(rate), '-ac', '2', '-i', 'source.s16le',
      '-c:a', codec, '-f', 'aiff', name])
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', name]).toString())
    if (probe.streams.length !== 1 || probe.streams[0].codec_name !== codec ||
        probe.streams[0].channels !== 2 || Number(probe.streams[0].sample_rate) !== rate)
      throw new Error('Unexpected AIFF fixture format for ' + name)
    const decoded = run('ffmpeg', ['-v', 'error', '-i', name, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'])
    if (!decoded.equals(raw)) throw new Error('AIFF reference round trip differs: ' + name)
    const bytes = readFileSync(file(name))
    manifest.variants.push({ name, codec, bytes: bytes.length, sha256: hash(bytes), decodedSha256: hash(decoded), probe })
  }
  manifest.complete = true
} finally { writeFileSync(file('reference.json'), JSON.stringify(manifest, null, 2) + '\n') }
