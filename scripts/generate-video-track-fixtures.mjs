import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

// A second, independently identifiable movie avoids treating repeated colors
// as proof of a particular source frame. No browser or product decoder authors
// these pixels: 72 raw RGB frames carry a seven-bit stripe and decimal digits.
const numberedRaw = Buffer.alloc(64 * 48 * 3 * 72), digitRows = [
  ['111', '101', '101', '101', '111'], ['010', '110', '010', '010', '111'],
  ['111', '001', '111', '100', '111'], ['111', '001', '111', '001', '111'],
  ['101', '101', '111', '001', '001'], ['111', '100', '111', '001', '111'],
  ['111', '100', '111', '101', '111'], ['111', '001', '010', '010', '010'],
  ['111', '101', '111', '101', '111'], ['111', '101', '111', '001', '111'],
]
for (let frame = 0; frame < 72; frame++) {
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    let rgb = [32, 64, 96]
    if (y >= 4 && y < 20 && x >= 4 && x < 60) {
      const bit = (frame >> Math.floor((x - 4) / 8)) & 1
      rgb = bit ? [240, 240, 240] : [16, 16, 16]
    }
    numberedRaw.set(rgb, (frame * 64 * 48 + y * 64 + x) * 3)
  }
  for (const [column, digit] of [Math.floor(frame / 10), frame % 10].entries())
    for (let row = 0; row < 5; row++) for (let bit = 0; bit < 3; bit++)
      if (digitRows[digit][row][bit] === '1')
        for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
          const x = 19 + column * 15 + bit * 3 + dx, y = 26 + row * 3 + dy
          numberedRaw.set([240, 200, 32], (frame * 64 * 48 + y * 64 + x) * 3)
        }
}
const numberedSource = resolve(directory, 'presentation-numbered.rgb'),
  numberedRegular = resolve(directory, 'numbered-multitrack.mp4'),
  numberedFragmented = resolve(directory, 'numbered-fragmented.mp4'),
  numberedSeparate = resolve(directory, 'numbered-separate-fragments.mp4'),
  numberedInterleaved = resolve(directory, 'numbered-interleaved.mp4'),
  numberedVariable = resolve(directory, 'numbered-variable.mp4')
writeFileSync(numberedSource, numberedRaw)
run(['-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '64x48', '-framerate', '12', '-i', numberedSource,
  '-i', regular, '-map', '0:v:0', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12',
  '-pix_fmt', 'yuv420p', '-g', '12', '-bf', '2', '-threads', '1', '-c:a', 'copy', '-t', '6',
  '-movflags', '+faststart', numberedRegular])
for (const [file, flags, extra] of [
  [numberedFragmented, '+empty_moov+default_base_moof+frag_keyframe', []],
  [numberedSeparate, '+empty_moov+default_base_moof+frag_keyframe+separate_moof', []],
  [numberedInterleaved, '+empty_moov+default_base_moof+frag_keyframe', ['-frag_interleave', '1']],
]) run(['-i', numberedRegular, '-map', '0', '-c', 'copy', '-movflags', flags, ...extra, file])

// Alternating one/two input ticks retain every distinct numbered image while
// making average-frame clock positions land inside actual sample intervals.
// The original eight references remain unchanged; this is a ninth fixture.
run(['-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '64x48', '-framerate', '12', '-i', numberedSource,
  '-vf', 'setpts=floor(N/2)*3+mod(N\\,2)', '-vsync', 'vfr', '-an',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p',
  '-g', '12', '-bf', '0', '-threads', '1', '-movflags', '+faststart', numberedVariable])

const presentation = [regular, fragmented, separate, interleaved,
  numberedRegular, numberedFragmented, numberedSeparate, numberedInterleaved, numberedVariable].map((file) => {
  const name = file.split('/').at(-1), frameDirectory = resolve(directory, name + '.frames'),
    bytes = readFileSync(file), sha256 = createHash('sha256').update(bytes).digest('hex'),
    probeCommand = ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_format', '-show_frames', '-of', 'json', file],
    probe = JSON.parse(execFileSync('ffprobe', probeCommand, { encoding: 'utf8', timeout: 30000,
      maxBuffer: 8 * 1024 * 1024 }))
  if (!Array.isArray(probe.frames) || probe.frames.length !== 72 || probe.frames.some((frame) =>
    frame.media_type !== 'video' || frame.width !== 64 || frame.height !== 48 ||
    !Number.isFinite(Number(frame.best_effort_timestamp_time ?? frame.pts_time))))
    throw new Error(`Unexpected presentation frame inventory: ${file}`)
  mkdirSync(frameDirectory, { recursive: true })
  const decodeCommand = ['-i', file, '-map', '0:v:0', '-vsync', '0', '-pix_fmt', 'rgba',
    '-c:v', 'png', '-threads', '1', '-start_number', '0', resolve(frameDirectory, '%06d.png')]
  run(decodeCommand)
  if (readdirSync(frameDirectory).filter((name) => name.endsWith('.png')).length !== probe.frames.length)
    throw new Error(`Decoded PNG count differs from ffprobe frames: ${file}`)
  const frames = probe.frames.map((frame, index) => {
    const png = `${name}.frames/${String(index).padStart(6, '0')}.png`, image = readFileSync(resolve(directory, png))
    return { index, presentationTime: Number(frame.best_effort_timestamp_time ?? frame.pts_time),
      png, bytes: image.length, sha256: createHash('sha256').update(image).digest('hex'), frame }
  })
  return { file: name, bytes: bytes.length, sha256, width: 64, height: 48,
    numbered: name.startsWith('numbered-'), probeCommand,
    decodeCommand: ['ffmpeg', ...common, ...decodeCommand], streams: probe.streams, format: probe.format, frames }
})
writeFileSync(resolve(directory, 'presentation-reference.json'), JSON.stringify({
  schema: 1, commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  scope: 'Independent FFmpeg decoded source frames and ffprobe timestamps; browser mapping is observed separately.',
  numberedInput: { file: 'presentation-numbered.rgb', bytes: numberedRaw.length,
    sha256: createHash('sha256').update(numberedRaw).digest('hex'),
    width: 64, height: 48, frames: 72, framesPerSecond: 12, format: 'top-down packed rgb24',
    background: [32, 64, 96], stripe: { bounds: [4, 4, 56, 16], bitOrder: 'LSB first, eight pixels per bit',
      zero: [16, 16, 16], one: [240, 240, 240] },
    digits: { origin: [19, 26], spacing: 15, pixelScale: 3, color: [240, 200, 32], digitRows } },
  fixtures: presentation,
}, null, 2) + '\n')

// Independent video-stream selection sources. Append to the original fixture
// generation rather than changing its bytes, track ordering or reference set.
const videoRegular = resolve(directory, 'video-multitrack.mp4'),
  videoFragmented = resolve(directory, 'video-fragmented.mp4'),
  videoInterleaved = resolve(directory, 'video-interleaved.mp4'),
  videoSeparate = resolve(directory, 'video-separate.mp4'),
  videoReferences = [0, 1].map((index) => resolve(directory, `video-reference-${index}.mp4`)),
  videoPatterns = [
    { index: 0, width: 64, height: 48, fps: 12, frames: 72,
      filter: 'color=c=0xe02020:s=64x48:r=12:d=6,drawbox=x=4:y=4:w=16:h=12:color=white:t=fill' },
    { index: 1, width: 80, height: 60, fps: 10, frames: 60,
      filter: 'color=c=0x2040e0:s=80x60:r=10:d=6,drawbox=x=56:y=40:w=16:h=12:color=yellow:t=fill' },
  ]
run(['-f', 'lavfi', '-i', videoPatterns[0].filter,
  '-f', 'lavfi', '-i', videoPatterns[1].filter, '-i', regular,
  '-map', '0:v:0', '-map', '1:v:0', '-map', '2:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p',
  '-g:v:0', '12', '-g:v:1', '10', '-bf', '0', '-threads', '1',
  '-c:a', 'copy', '-t', '6', '-disposition:v:0', 'default', '-disposition:v:1', '0',
  '-movflags', '+faststart', videoRegular])
for (const [file, flags, extra] of [
  [videoFragmented, '+empty_moov+default_base_moof+frag_keyframe', []],
  [videoInterleaved, '+empty_moov+default_base_moof+frag_keyframe', ['-frag_interleave', '1']],
  [videoSeparate, '+empty_moov+default_base_moof+frag_keyframe+separate_moof', []],
]) run(['-i', videoRegular, '-map', '0', '-c', 'copy', '-movflags', flags, ...extra, file])
for (const [index, file] of videoReferences.entries())
  run(['-i', videoRegular, '-map', `0:v:${index}`, '-map', '0:a', '-c', 'copy', '-movflags', '+faststart', file])
// Preserve the historical regular references above. New references are copied
// from each actual container, whose mux offsets can differ even for identical
// encoded frames. No candidate selector or timeline parser generates them.
const videoContainers = [videoRegular, videoFragmented, videoInterleaved, videoSeparate],
  containerReferences = videoContainers.flatMap((source) => [0, 1].map((index) => ({
    source, index, file: source.replace(/\.mp4$/, `-reference-${index}.mp4`),
  })))
for (const { source, index, file } of containerReferences)
  run(['-copyts', '-i', source, '-map', `0:v:${index}`, '-map', '0:a', '-c', 'copy',
    '-copytb', '1', '-avoid_negative_ts', 'disabled', '-movflags', '+faststart', file])
const packetReports = new Map(), videoSelectionFiles = [
  ...videoContainers.map((file) => ({ file, patterns: videoPatterns })),
  ...videoReferences.map((file, index) => ({ file, patterns: [videoPatterns[index]] })),
  ...containerReferences.map(({ file, index }) => ({ file, patterns: [videoPatterns[index]] })),
].map(({ file, patterns }) => {
  const bytes = readFileSync(file), sha256 = createHash('sha256').update(bytes).digest('hex'),
    probeCommand = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    metadata = JSON.parse(execFileSync('ffprobe', probeCommand, { encoding: 'utf8', timeout: 30000 })),
    videos = metadata.streams.filter((stream) => stream.codec_type === 'video'),
    audios = metadata.streams.filter((stream) => stream.codec_type === 'audio')
  if (videos.length !== patterns.length || audios.length !== 2 ||
      videos.some((stream, index) => stream.codec_name !== 'h264' || stream.width !== patterns[index].width ||
        stream.height !== patterns[index].height || stream.r_frame_rate !== patterns[index].fps + '/1') ||
      audios.some((stream) => stream.codec_name !== 'aac' || stream.channels !== 2 || stream.sample_rate !== '48000'))
    throw new Error(`Unexpected generated video selection inventory: ${file}`)
  const packetCommand = ['-v', 'error', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', file],
    packetOutput = JSON.parse(execFileSync('ffprobe', packetCommand, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }))
  if (!Array.isArray(packetOutput.packets) || !packetOutput.packets.length)
    throw new Error(`No independent video selection packet inventory: ${file}`)
  for (const [index, stream] of videos.entries())
    if (packetOutput.packets.filter((packet) => packet.stream_index === stream.index).length !== patterns[index].frames)
      throw new Error(`Unexpected encoded video frame count: ${file}, track ${index}`)
  writeFileSync(file + '.packets.json', JSON.stringify({ schema: 1, file: file.split('/').at(-1), sha256,
    command: packetCommand, streams: metadata.streams, packets: packetOutput.packets }, null, 2) + '\n')
  packetReports.set(file, { streams: metadata.streams, packets: packetOutput.packets })
  return { file: file.split('/').at(-1), bytes: bytes.length, sha256, probeCommand, metadata,
    packetCount: packetOutput.packets.length }
})
const sameTimestamp = (left, leftBase, right, rightBase) => {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return false
  const [ln, ld] = leftBase.split('/').map(BigInt), [rn, rd] = rightBase.split('/').map(BigInt)
  return ld > 0n && rd > 0n && BigInt(left) * ln * rd === BigInt(right) * rn * ld
}
const referenceBindings = containerReferences.map(({ source, index, file }) => {
  const original = packetReports.get(source), reference = packetReports.get(file),
    originalTrack = original.streams.filter((stream) => stream.codec_type === 'video')[index],
    referenceTrack = reference.streams.find((stream) => stream.codec_type === 'video'),
    expected = original.packets.filter((packet) => packet.stream_index === originalTrack.index),
    actual = reference.packets.filter((packet) => packet.stream_index === referenceTrack.index)
  if (actual.length !== expected.length) throw new Error(`Video reference packet count changed: ${file}`)
  for (const [frame, packet] of expected.entries()) {
    const copy = actual[frame]
    if (packet.size !== copy.size || packet.data_hash !== copy.data_hash ||
        !sameTimestamp(packet.pts, originalTrack.time_base, copy.pts, referenceTrack.time_base) ||
        !sameTimestamp(packet.dts, originalTrack.time_base, copy.dts, referenceTrack.time_base))
      throw new Error(`Video reference bytes or timestamps changed: ${file}, packet ${frame}`)
  }
  return { source: source.split('/').at(-1), index, reference: file.split('/').at(-1),
    packets: actual.length, originalTimeBase: originalTrack.time_base,
    referenceTimeBase: referenceTrack.time_base, exactEncodedBytesAndPtsDts: true }
})
// Independently record the decoder's SPS/VUI fields. This is hosted evidence,
// not a second implementation of our bit parser or a hardcoded FPS fallback.
const codecTiming = [...videoContainers.flatMap((file) => [0, 1].map((index) => ({ file, index, fps: videoPatterns[index].fps }))),
  { file: numberedVariable, index: 0, fps: 12 }].map(({ file, index, fps }) => {
  const args = ['-hide_banner', '-loglevel', 'info', '-i', file, '-map', `0:v:${index}`,
    '-c:v', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-']
  commands.push(args)
  const observed = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }),
    log = file.split('/').at(-1) + `.track-${index}.headers.log`
  writeFileSync(resolve(directory, log), observed.stderr ?? '')
  if (observed.error || observed.status !== 0)
    throw new Error(`Independent AVC header observation failed: ${log}`, { cause: observed.error })
  const fields = (field) => [...observed.stderr.matchAll(new RegExp(`\\b${field}\\s+[01]+\\s*=\\s*(\\d+)`, 'g'))].map((match) => Number(match[1])),
    units = fields('num_units_in_tick'), scales = fields('time_scale'), progressive = fields('frame_mbs_only_flag')
  if (!units.length || units.length !== scales.length || !progressive.length || progressive.some((value) => value !== 1) ||
      units.some((value, at) => value <= 0 || scales[at] !== 2 * value * fps))
    throw new Error(`Unexpected independent AVC nominal timing: ${log}`)
  return { file: file.split('/').at(-1), index, log, units, scales, progressive,
    fixed: fields('fixed_frame_rate_flag') }
})
const videoSelectionFrames = videoReferences.map((file, index) => {
  const png = `video-reference-${index}.png`, decodeCommand = ['-i', file, '-map', '0:v:0',
    '-frames:v', '1', '-pix_fmt', 'rgba', '-c:v', 'png', '-threads', '1', resolve(directory, png)]
  run(decodeCommand)
  const bytes = readFileSync(resolve(directory, png))
  return { index, source: file.split('/').at(-1), png, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), decodeCommand: ['ffmpeg', ...common, ...decodeCommand] }
})
writeFileSync(resolve(directory, 'video-selection-reference.json'), JSON.stringify({
  schema: 1, commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  scope: 'Two actual H.264 videos and two AAC audios; reference movies are stream copies, PNGs are independent FFmpeg decodes.',
  patterns: videoPatterns, files: videoSelectionFiles, frames: videoSelectionFrames,
  referenceBindings, codecTiming,
}, null, 2) + '\n')
const provenance = {
  commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  runner: process.env.RUNNER_ENVIRONMENT,
  generator: 'scripts/generate-video-track-fixtures.mjs',
  license: 'Project-owned synthetic frames and sine waves; no external media content.',
  original: { file: 'tests/fixtures/video/colors.mp4', sha256: createHash('sha256').update(readFileSync(original)).digest('hex') },
  audio: [{ index: 0, frequency: 440, language: 'jpn' }, { index: 1, frequency: 880, language: 'eng' }],
  ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }), commands, files,
  presentation: { manifest: 'presentation-reference.json', fixtures: presentation.length,
    frames: presentation.reduce((sum, fixture) => sum + fixture.frames.length, 0) },
  videoSelection: { manifest: 'video-selection-reference.json', fixtures: videoSelectionFiles.length,
    references: videoSelectionFrames.length },
}
writeFileSync(resolve(directory, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n')
console.log(JSON.stringify(files.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })), null, 2))
