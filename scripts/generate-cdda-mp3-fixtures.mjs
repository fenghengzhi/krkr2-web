import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Independent MP3 CD audio authoring requires a GitHub-hosted runner')

const directory = resolve('out/verification/cdda-mp3'), rate = 44100, sourceFrames = 120 * rate + 137,
  windows = [
    { name: 'opening', start: 0, frames: rate * 2 },
    { name: 'change40', start: rate * 39, frames: rate * 2 },
    { name: 'track2', start: rate * 59, frames: rate * 3 },
    { name: 'change80', start: rate * 79, frames: rate * 2 },
    { name: 'far100', start: rate * 100, frames: rate * 2 },
    { name: 'tail', start: sourceFrames - 8192, frames: 8192 },
  ], manifest = { schema: 1, complete: false, commit: process.env.GITHUB_SHA, rate, channels: 2, sourceFrames,
    source: { format: 'f32le', bytes: sourceFrames * 8, sha256: '',
      left: [{ start: 0, end: 40 * rate, hz: 440, amplitude: .25 },
        { start: 40 * rate, end: 80 * rate, hz: 660, amplitude: .25 },
        { start: 80 * rate, end: sourceFrames, hz: 880, amplitude: .25 }],
      right: { hz: 550, amplitude: .125 } },
    cue: { fileType: 'MP3', track1Sector: 0, track2Sector: 4500, track2Sample: rate * 60 },
    commands: [], variants: [], error: null,
    scope: 'Normal libmp3lame CBR/VBR music with encoder reservoir and Xing/Info gapless metadata. Full FFmpeg decoded lengths/SHA are retained; only named F32 windows are distributed.' }
mkdirSync(join(directory, 'logs'), { recursive: true })
const save = () => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'),
  hash = (data) => createHash('sha256').update(data).digest('hex'),
  hashFile = (file) => {
    const fd = openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024), result = createHash('sha256')
    try { let length; while ((length = readSync(fd, buffer)) > 0) result.update(buffer.subarray(0, length)) }
    finally { closeSync(fd) }
    return result.digest('hex')
  }, run = (program, args, timeout = 120000, stdoutFile) => {
    const name = String(manifest.commands.length).padStart(3, '0'), row = { program, args, timeout,
      stdout: stdoutFile ?? `logs/${name}.stdout`, stderr: `logs/${name}.stderr`, complete: false }
    manifest.commands.push(row); save()
    try {
      const result = spawnSync(program, args, { timeout, maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout = Buffer.from(result.stdout ?? ''), stderr = Buffer.from(result.stderr ?? '')
      writeFileSync(join(directory, row.stdout), stdout); writeFileSync(join(directory, row.stderr), stderr)
      Object.assign(row, { exitCode: result.status, signal: result.signal,
        stdoutBytes: stdout.length, stdoutSha256: hash(stdout), stderrBytes: stderr.length, stderrSha256: hash(stderr) })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`${program} failed (${result.status ?? result.signal}); ${row.stderr}`)
      row.complete = true
      return stdout
    } finally { save() }
  }

function tagInventory(bytes) {
  let at = 0
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    assert(bytes.length >= 10 && [...bytes.subarray(6, 10)].every((value) => value < 128))
    const size = ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9])
    at = 10 + size + ((bytes[5] & 16) ? 10 : 0)
  }
  const header = bytes.readUInt32BE(at)
  assert.equal(header >>> 21, 0x7ff)
  assert.equal((header >>> 19) & 3, 3, 'Expected ordinary MPEG-1 audio')
  assert.equal((header >>> 17) & 3, 1, 'Expected Layer III')
  assert.equal((header >>> 10) & 3, 0, 'Expected 44100 Hz')
  assert.notEqual((header >>> 6) & 3, 3, 'Expected stereo source')
  const tagAt = at + 4 + ((header & 0x10000) ? 0 : 2) + 32,
    kind = bytes.toString('ascii', tagAt, tagAt + 4), flags = bytes.readUInt32BE(tagAt + 4)
  assert(['Info', 'Xing'].includes(kind), 'Encoder did not retain Xing/Info')
  let cursor = tagAt + 8, mpegFrames
  if (flags & 1) { mpegFrames = bytes.readUInt32BE(cursor); cursor += 4 }
  if (flags & 2) cursor += 4
  if (flags & 4) cursor += 100
  if (flags & 8) cursor += 4
  assert(cursor + 36 <= bytes.length)
  const encoder = bytes.toString('ascii', cursor, cursor + 9),
    delay = (bytes[cursor + 21] << 4) | (bytes[cursor + 22] >>> 4),
    padding = ((bytes[cursor + 22] & 15) << 8) | bytes[cursor + 23]
  assert(mpegFrames > 0 && delay > 0 && padding > 0, 'Expected actual gapless delay and padding fields')
  return { firstFrameOffset: at, kind, tagOffset: tagAt, flags, mpegFrames, encoder, delay, padding,
    extensionHex: bytes.subarray(cursor, cursor + 36).toString('hex') }
}

let temporary
save()
try {
  temporary = mkdtempSync(join(process.env.RUNNER_TEMP, 'krkr-cdda-mp3-'))
  manifest.ffmpeg = run('ffmpeg', ['-version']).toString()
  manifest.ffprobe = run('ffprobe', ['-version']).toString()
  const source = join(temporary, 'source.f32'), fd = openSync(source, 'wx'), sourceHash = createHash('sha256')
  try {
    for (let from = 0; from < sourceFrames; from += 8192) {
      const count = Math.min(8192, sourceFrames - from), buffer = Buffer.alloc(count * 8)
      for (let i = 0; i < count; i++) {
        const frame = from + i, frequency = frame < rate * 40 ? 440 : frame < rate * 80 ? 660 : 880,
          angle = frame * 2 * Math.PI / rate
        buffer.writeFloatLE(.25 * Math.sin(frequency * angle), i * 8)
        buffer.writeFloatLE(.125 * Math.sin(550 * angle), i * 8 + 4)
      }
      let at = 0
      while (at < buffer.length) {
        const written = writeSync(fd, buffer, at, buffer.length - at)
        assert(written > 0, 'Source PCM write did not advance'); at += written
      }
      sourceHash.update(buffer)
    }
  } finally { closeSync(fd) }
  manifest.source.sha256 = sourceHash.digest('hex')
  assert.equal(statSync(source).size, sourceFrames * 8)
  for (const name of ['cbr', 'vbr']) {
    const file = name + '.mp3', path = join(directory, file), pcmPath = join(temporary, name + '.f32')
    run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'f32le', '-ar', String(rate), '-ac', '2', '-i', source,
      '-map', '0:a:0', '-c:a', 'libmp3lame', ...(name === 'cbr' ? ['-b:a', '128k'] : ['-q:a', '2']),
      '-write_xing', '1', path])
    const bytes = readFileSync(path), row = { name, file, bytes: bytes.length, sha256: hash(bytes), complete: false, windows: [] }
    manifest.variants.push(row); save()
    row.tag = tagInventory(bytes)
    const probeFile = name + '.probe.json', probeBytes = run('ffprobe',
      ['-v', 'error', '-select_streams', 'a', '-show_streams', '-show_format', '-show_packets', '-of', 'json', path], 120000, probeFile),
      probe = JSON.parse(probeBytes.toString()), streams = probe.streams, packets = probe.packets
    assert.equal(streams.length, 1); assert.equal(streams[0].codec_name, 'mp3')
    assert.equal(Number(streams[0].sample_rate), rate); assert.equal(streams[0].channels, 2)
    assert(packets.length > 4000)
    const firstPacket = packets[0], lastPacket = packets.at(-1),
      firstSide = firstPacket.side_data_list?.find((row) => row.side_data_type === 'Skip Samples'),
      lastSide = lastPacket.side_data_list?.find((row) => row.side_data_type === 'Skip Samples')
    assert(Number(firstSide?.skip_samples) > 0, 'Missing first-packet decoder skip')
    assert(Number(lastSide?.discard_padding) > 0, 'Missing last-packet gapless padding')
    run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', path, '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'f32le', pcmPath])
    const pcmBytes = statSync(pcmPath).size, frames = pcmBytes / 8
    assert.equal(frames, sourceFrames, 'Independent gapless decode must preserve every original frame without post-trimming')
    Object.assign(row, { frames, decodedFrames: frames,
      fullPcmBytes: pcmBytes, fullPcmSha256: hashFile(pcmPath), firstPacket, lastPacket,
      probe: { file: probeFile, bytes: probeBytes.length, sha256: hash(probeBytes), streams, format: probe.format, packetCount: packets.length } })
    save()
    const decoded = openSync(pcmPath, 'r')
    try {
      for (const window of windows) {
        const buffer = Buffer.alloc(window.frames * 8)
        let at = 0
        while (at < buffer.length) {
          const length = readSync(decoded, buffer, at, buffer.length - at, window.start * 8 + at)
          assert(length > 0, 'Truncated independent decoded window'); at += length
        }
        for (let at = 0; at < buffer.length; at += 4) assert(Number.isFinite(buffer.readFloatLE(at)))
        const file = name + '-' + window.name + '.f32'
        writeFileSync(join(directory, file), buffer)
        row.windows.push({ ...window, file, bytes: buffer.length, sha256: hash(buffer) })
      }
    } finally { closeSync(decoded) }
    row.complete = true; save()
  }
  manifest.complete = true
} catch (error) {
  manifest.error = { name: error.name, message: error.message, stack: error.stack }
  throw error
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true })
  save()
}
