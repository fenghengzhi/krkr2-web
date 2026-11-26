import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

function pictureTimes(item, metadata, timeline, fps, windowsMedia) {
  const inferredTimestampIndices = []
  if (item.elementary) {
    // An elementary stream carries picture durations but no container PTS.
    // Keep ffprobe's generated PTS in the raw report. Use decoded durations
    // in stream ticks as the independent clock and compare every one with the
    // authored rate. Accumulating integers also preserves fractional rates.
    const stream = metadata.streams.find((stream) => stream.codec_type === 'video')
    const [num, den] = stream.time_base.split('/').map(Number)
    if (metadata.format.format_name !== 'mpegvideo' || !(num > 0 && den > 0))
      throw new Error(`Missing independent elementary time base: ${item.file}`)
    let ticks = 0
    const times = timeline.frames.map((frame, index) => {
      const duration = Number(frame.duration ?? frame.pkt_duration)
      if (!Number.isSafeInteger(duration) || duration <= 0 ||
          Math.abs(duration * num / den - 1 / fps) > 0.5 * num / den)
        throw new Error(`Unexpected elementary picture duration: ${item.file} frame ${index}, ${duration} ticks`)
      const time = ticks * num / den
      ticks += duration
      return time
    })
    return { times, inferredTimestampIndices,
      timeScope: 'Raw MPEG-1 picture order and independently decoded durations from zero; generated demuxer PTS are archived separately.' }
  }
  const rawTimes = timeline.frames.map((frame) => Number(frame.best_effort_timestamp_time ?? frame.pts_time)),
    known = rawTimes.map((time, index) => ({ time, index })).filter(({ time }) => Number.isFinite(time))
  if (!known.length) throw new Error(`No independent legacy frame timestamps: ${item.file}`)
  if (windowsMedia && known.length !== timeline.frames.length) throw new Error(`Missing Windows Media frame timestamp: ${item.file}`)
  const first = known[0], last = known.at(-1)
  const times = rawTimes.map((time, index) => {
    if (Number.isFinite(time)) {
      if (Math.abs((time - first.time) - (index - first.index) / fps) > 1 / 90000 + 0.000002)
        throw new Error(`Unexpected decoded frame cadence: ${item.file} frame ${index}, PTS ${time}, first ${first.time}`)
      return time
    }
    const reference = index < first.index ? first : index > last.index ? last : undefined
    if (!reference || Math.abs(index - reference.index) > 2)
      throw new Error(`Missing interior legacy frame timestamp: ${item.file} ${index}`)
    inferredTimestampIndices.push(index)
    return reference.time + (index - reference.index) / fps
  })
  return { times, inferredTimestampIndices,
    timeScope: 'Original container frame PTS minus common format start. At most two missing boundary PTS use the nearest observed PTS and authored rate.' }
}

// Called only from the shared GitHub-hosted fixture generation step. Nothing
// in this file invokes the Web decoder or the candidate WASM transcoder.
function generateMovieFixtures(directory, windowsMedia) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error('Legacy movie fixtures require GitHub-hosted Actions')
  const prefix = windowsMedia ? 'windows-media' : 'legacy',
    width = 96, height = 64, fps = 25, frames = 100, rate = 48000,
    colors = [[220, 30, 30], [25, 210, 35], [30, 45, 220]],
    rgb = Buffer.alloc(width * height * 3 * frames), pcm = Buffer.alloc(rate * 4 * 2),
    commands = [], fixtures = [], sha = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    path = (name) => resolve(directory, name), common = ['-hide_banner', '-loglevel', 'error', '-y']
  // Broad colors identify the time interval; seven light/dark blocks encode
  // the individual frame. Interior samples tolerate codec/color conversion.
  for (let frame = 0; frame < frames; frame++) {
    const phase = frame < 40 ? 0 : frame < 70 ? 1 : 2
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let color = colors[phase]
      if (y >= 8 && y < 24 && x >= 8 + phase * 32 && x < 24 + phase * 32) color = [235, 235, 235]
      if (y >= 44 && y < 60 && x >= 6 && x < 90) {
        const bit = Math.floor((x - 6) / 12), light = (frame >> bit) & 1
        color = light ? [235, 235, 235] : [16, 16, 16]
      }
      rgb.set(color, (frame * width * height + y * width + x) * 3)
    }
  }
  for (let sample = 0; sample < rate * 4; sample++) {
    const time = sample / rate, frequency = time < .5 ? 0 : time < 1.6 ? 440 : time < 2.8 ? 660 : 880,
      value = frequency ? Math.round(Math.sin(2 * Math.PI * frequency * time) * 0.18 * 32767) : 0
    pcm.writeInt16LE(value, sample * 2)
  }
  writeFileSync(path(prefix + '-authored.rgb'), rgb)
  writeFileSync(path(prefix + '-authored.s16le'), pcm)
  const run = (binary, args, name) => {
    const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
    writeFileSync(path(name + '.stdout.log'), result.stdout ?? '')
    writeFileSync(path(name + '.stderr.log'), result.stderr ?? '')
    commands.push({ binary, args, stdout: name + '.stdout.log', stderr: name + '.stderr.log',
      status: result.status, signal: result.signal, error: result.error?.message })
    if (result.error || result.status !== 0) throw new Error(`Hosted legacy movie fixture command failed: ${name}`, { cause: result.error })
    return result.stdout
  }
  const videoInput = ['-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`],
    audioInput = ['-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', path(prefix + '-authored.s16le')],
    cases = windowsMedia ? [
      { file: 'legacy-wmv1.wmv', aliases: [], video: 'wmv1', audio: 'wmav1',
        options: ['-c:v', 'wmv1', '-q:v', '2', '-g', '12', '-bf', '0', '-pix_fmt', 'yuv420p',
          '-c:a', 'wmav1', '-b:a', '128k', '-f', 'asf'] },
      { file: 'legacy-wmv2.wmv', aliases: ['legacy-wmv2.asf', 'legacy-wmv2.wma'], video: 'wmv2', audio: 'wmav2', audioOffset: .3,
        options: ['-c:v', 'wmv2', '-q:v', '2', '-g', '12', '-bf', '0', '-pix_fmt', 'yuv420p',
          '-c:a', 'wmav2', '-b:a', '128k', '-f', 'asf'] },
    ] : [
      { file: 'legacy-program.mpg', aliases: ['legacy-program.mpeg'], video: 'mpeg1video', audio: 'mp2', audioOffset: .3,
        options: ['-c:v', 'mpeg1video', '-q:v', '2', '-g', '12', '-bf', '2', '-pix_fmt', 'yuv420p',
          '-c:a', 'mp2', '-b:a', '128k', '-muxpreload', '0', '-muxdelay', '0', '-f', 'mpeg'] },
      { file: 'legacy-mjpeg.avi', aliases: [], video: 'mjpeg', audio: 'pcm_s16le',
        options: ['-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj420p', '-c:a', 'pcm_s16le', '-f', 'avi'] },
      { file: 'legacy-elementary.m1v', aliases: ['legacy-elementary.mpv'], elementary: true, video: 'mpeg1video', audio: null,
        options: ['-c:v', 'mpeg1video', '-q:v', '2', '-g', '12', '-bf', '0', '-pix_fmt', 'yuv420p', '-an', '-f', 'mpeg1video'] },
      { file: 'legacy-ntsc.mpv', aliases: [], elementary: true, fps: [30000, 1001], video: 'mpeg1video', audio: null,
        options: ['-c:v', 'mpeg1video', '-q:v', '2', '-g', '12', '-bf', '2', '-pix_fmt', 'yuv420p', '-an', '-f', 'mpeg1video'] },
    ]
  let failure, cinepakAvailable = false
  try {
    const encoders = run('ffmpeg', ['-hide_banner', '-encoders'], prefix + '-encoders')
    cinepakAvailable = !windowsMedia && /^\s*V\S*\s+cinepak\s/m.test(encoders)
    if (cinepakAvailable) cases.push({ file: 'legacy-cinepak.avi', aliases: [], video: 'cinepak', audio: 'pcm_s16le',
      options: ['-c:v', 'cinepak', '-q:v', '3', '-pix_fmt', 'rgb24', '-c:a', 'pcm_s16le', '-f', 'avi'] })
    for (const item of cases) {
      const [rateNum, rateDen] = item.fps ?? [fps, 1], itemFps = rateNum / rateDen, inputRate = `${rateNum}/${rateDen}`
      run('ffmpeg', [...common, ...videoInput, '-framerate', inputRate, '-i', path(prefix + '-authored.rgb'), ...(item.audioOffset ? ['-itsoffset', String(item.audioOffset)] : []),
        ...(item.audio ? audioInput : []), '-map', '0:v:0',
        ...(item.audio ? ['-map', '1:a:0', '-ar:a', String(rate)] : []), ...item.options,
        '-r:v', inputRate, '-threads', '1', ...(item.elementary ? ['-frames:v', String(frames)] : ['-t', '4']), path(item.file)], item.file + '.encode')
      const probe = ['-v', 'error', '-analyzeduration', '10000000', '-probesize', '8388608']
      const metadata = JSON.parse(run('ffprobe', [...probe, '-show_streams', '-show_format', '-of', 'json', path(item.file)], item.file + '.probe')),
        videos = metadata.streams.filter((stream) => stream.codec_type === 'video'),
        audios = metadata.streams.filter((stream) => stream.codec_type === 'audio')
      if (videos.length !== 1 || videos[0].codec_name !== item.video || videos[0].width !== width ||
        videos[0].height !== height ||
        audios.length !== (item.audio ? 1 : 0) || (item.audio && (audios[0].codec_name !== item.audio || Number(audios[0].sample_rate) !== rate)))
        throw new Error(`Unexpected hosted legacy stream inventory: ${item.file} ${JSON.stringify(metadata.streams)}`)
      const timeline = JSON.parse(run('ffprobe', [...probe, '-fflags', '+genpts', '-select_streams', 'v:0', '-show_frames', '-of', 'json', path(item.file)], item.file + '.frames'))
      if (timeline.frames.length !== frames) throw new Error(`Unexpected hosted legacy frame count: ${item.file}`)
      const { times, inferredTimestampIndices, timeScope } = pictureTimes(item, metadata, timeline, itemFps, windowsMedia),
        commonStart = item.elementary ? 0 : Number(metadata.format.start_time ?? videos[0].start_time ?? 0),
        normalizedVideoTimes = times.map((time) => time - commonStart)
      if (!Number.isFinite(commonStart) || normalizedVideoTimes.some((time, index) => !Number.isFinite(time) ||
          (index && time < normalizedVideoTimes[index - 1]))) throw new Error(`Invalid independent legacy timestamps: ${item.file}`)
      if (item.file === 'legacy-ntsc.mpv' && !timeline.frames.some((frame) => frame.pict_type === 'B'))
        throw new Error('The fractional-rate elementary stream must retain reordered pictures')
      if (item.file === 'legacy-program.mpg' && (!timeline.frames.some((frame) => frame.pict_type === 'B') ||
          !(Number(audios[0].start_time) - Number(videos[0].start_time) > .2)))
        throw new Error('MPEG-PS must retain B frames and a genuinely later audio stream start')
      if (windowsMedia && item.audioOffset && !(Number(audios[0].start_time) - Number(videos[0].start_time) > .2))
        throw new Error('Windows Media must retain its independently delayed audio stream')
      run('ffmpeg', [...common, '-i', path(item.file), '-map', '0:v:0', '-vsync', '0', '-pix_fmt', 'rgba', '-f', 'rawvideo', path(item.file + '.rgba')], item.file + '.decode')
      const decoded = readFileSync(path(item.file + '.rgba'))
      if (decoded.length !== width * height * 4 * frames) throw new Error(`Incomplete independent legacy decode: ${item.file}`)
      const checkedFrames = item.elementary ? Array.from({ length: frames }, (_, i) => i) : [0, 25, 50, 80]
      const checks = checkedFrames.map((frame) => {
        const phase = frame < 40 ? 0 : frame < 70 ? 1 : 2, at = (frame * width * height + 32 * width + 48) * 4,
          color = [...decoded.subarray(at, at + 4)]
        if (color.some((value, channel) => Math.abs(value - (channel === 3 ? 255 : colors[phase][channel])) > 22))
          throw new Error(`Independent legacy decode lost authored color: ${item.file} frame ${frame}`)
        let code = 0
        for (let bit = 0; bit < 7; bit++) {
          const pixel = (frame * width * height + 52 * width + 12 + bit * 12) * 4,
            level = (decoded[pixel] + decoded[pixel + 1] + decoded[pixel + 2]) / 3
          if (level > 180) code |= 1 << bit
          else if (level > 70) throw new Error(`Independent legacy frame marker is ambiguous: ${item.file}`)
        }
        if (code !== frame) throw new Error(`Independent legacy frame marker changed: ${item.file} ${code}/${frame}`)
        return { frame, color, code, timestamp: timeline.frames[frame] }
      })
      const bytes = readFileSync(path(item.file))
      for (const alias of item.aliases) writeFileSync(path(alias), bytes)
      fixtures.push({ file: item.file, aliases: item.aliases, bytes: bytes.length, sha256: sha(bytes),
        videoCodec: item.video, audioCodec: item.audio, audioInputOffset: item.audioOffset ?? 0,
        fps: itemFps, authoredVideoDuration: frames / itemFps, commonStart, normalizedVideoTimes,
        inferredTimestampIndices, timeScope, metadata, timeline,
        independentRgba: { file: item.file + '.rgba', bytes: decoded.length, sha256: sha(decoded) }, checks })
    }
  } catch (error) { failure = error }
  const report = { schema: 1, commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
    generator: 'scripts/generate-legacy-video-fixtures.mjs',
    scope: 'Independent native FFmpeg authors and decodes legacy inputs. No candidate transcode output is used as an expected image.',
    complete: !failure, failure: failure ? String(failure) : undefined, width, height, fps, frames, duration: 4,
    ...(!windowsMedia && { cinepak: { encoderAvailable: cinepakAvailable, file: cinepakAvailable ? 'legacy-cinepak.avi' : null,
      scope: cinepakAvailable ? 'Additional native/WASM decode fixture; no extra browser matrix.' : 'Hosted FFmpeg does not expose a Cinepak encoder; not verified.' },
    }),
    authored: { rgb: { file: prefix + '-authored.rgb', bytes: rgb.length, sha256: sha(rgb) },
      pcm: { file: prefix + '-authored.s16le', bytes: pcm.length, sha256: sha(pcm), rate, channels: 1 },
      colors, colorIntervals: [[0, 1.6], [1.6, 2.8], [2.8, 4]], colorFrameIntervals: [[0, 40], [40, 70], [70, 100]],
      soundIntervals: [{ start: 0, end: .5, frequency: 0 }, { start: .5, end: 1.6, frequency: 440 },
        { start: 1.6, end: 2.8, frequency: 660 }, { start: 2.8, end: 4, frequency: 880 }],
      marker: { bits: 7, order: 'LSB first', x: 6, y: 44, width: 12, height: 16, dark: 16, light: 235 } },
    fixtures, commands }
  const manifest = windowsMedia ? 'windows-media-reference.json' : 'legacy-video-reference.json'
  writeFileSync(path(manifest), JSON.stringify(report, null, 2) + '\n')
  if (failure) throw failure
  return { manifest, fixtures: fixtures.length }
}

export const generateLegacyVideoFixtures = (directory) => generateMovieFixtures(directory, false)
/** Separate invocation/report: a failed MPEG fixture must not suppress WMV. */
export const generateWindowsMediaFixtures = (directory) => generateMovieFixtures(directory, true)
