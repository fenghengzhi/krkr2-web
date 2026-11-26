import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

function pictureTimes(item, metadata, timeline, fps, requireAllTimestamps) {
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
  if (requireAllTimestamps && known.length !== timeline.frames.length) throw new Error(`Missing container frame timestamp: ${item.file}`)
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

const width = 96, height = 64, fps = 25, frames = 100, rate = 48000,
  colors = [[220, 30, 30], [25, 210, 35], [30, 45, 220]],
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function requireHosted() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error('Legacy movie fixtures require GitHub-hosted Actions')
}

function sourceMovie(bilingual = false) {
  const rgb = Buffer.alloc(width * height * 3 * frames), pcm = Buffer.alloc(rate * 4 * 2)
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
  const alternate = bilingual ? Buffer.alloc(pcm.length) : undefined
  for (let sample = 0; sample < rate * 4; sample++) {
    const time = sample / rate, frequency = time < .5 ? 0 : bilingual || time < 1.6 ? 440 : time < 2.8 ? 660 : 880,
      value = frequency ? Math.round(Math.sin(2 * Math.PI * frequency * time) * 0.18 * 32767) : 0
    pcm.writeInt16LE(value, sample * 2)
    if (alternate && time >= .5) alternate.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 880 * time) * .18 * 32767), sample * 2)
  }
  return { rgb, pcm, alternate }
}

/** Windows Media Foundation accepts top-down NV12 and interleaved PCM.
 * The authored color rectangles and bit markers align to 2x2 chroma cells. */
export function writeWindowsMovieInputs(directory) {
  requireHosted()
  const { rgb, pcm } = sourceMovie(), area = width * height, stride = area * 3 / 2,
    nv12 = Buffer.alloc(stride * frames), stereo = Buffer.alloc(pcm.length * 2)
  for (let frame = 0; frame < frames; frame++) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (frame * area + y * width + x) * 3, r = rgb[at], g = rgb[at + 1], b = rgb[at + 2],
        base = frame * stride
      nv12[base + y * width + x] = 16 + ((66 * r + 129 * g + 25 * b + 128) >> 8)
      if (!(x % 2 || y % 2)) {
        const uv = base + area + y / 2 * width + x
        nv12[uv] = 128 + ((-38 * r - 74 * g + 112 * b + 128) >> 8)
        nv12[uv + 1] = 128 + ((112 * r - 94 * g - 18 * b + 128) >> 8)
      }
    }
  }
  for (let at = 0; at < pcm.length; at += 2) {
    const value = pcm.readInt16LE(at)
    stereo.writeInt16LE(value, at * 2); stereo.writeInt16LE(value, at * 2 + 2)
  }
  writeFileSync(resolve(directory, 'source.nv12'), nv12)
  writeFileSync(resolve(directory, 'source.pcm'), stereo)
  writeFileSync(resolve(directory, 'wmv9-inputs.json'), JSON.stringify({
    commit: process.env.GITHUB_SHA, frames, fps, width, height, rate, channels: 2,
    rgbSha256: sha(rgb), monoSha256: sha(pcm), nv12Sha256: sha(nv12), stereoSha256: sha(stereo),
  }, null, 2) + '\n')
}

// System FFmpeg encodes the local groups and independently decodes all groups.
// The two Windows Media 9 originals arrive byte-for-byte from the Windows job.
function generateMovieFixtures(directory, prefix) {
  requireHosted()
  const bilingual = prefix === 'dvd-audio', windowsMaster = prefix === 'wmv9' || prefix === 'vc1',
    { rgb, pcm, alternate } = sourceMovie(bilingual), commands = [], fixtures = [],
    path = (name) => resolve(directory, name), common = ['-hide_banner', '-loglevel', 'error', '-y']
  writeFileSync(path(prefix + '-authored.rgb'), rgb)
  writeFileSync(path(prefix + '-authored.s16le'), pcm)
  if (alternate) writeFileSync(path(prefix + '-alternate.s16le'), alternate)
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
    fixturesByGroup = {
      'large-dib': [
        { file: 'legacy-large-dib.avi', aliases: [], video: 'rawvideo', audio: 'pcm_s16le', container: 'avi',
          scale: 9, options: ['-vf', 'scale=iw*9:ih*9:flags=neighbor', '-c:v', 'rawvideo',
            '-pix_fmt', 'bgr24', '-c:a', 'pcm_s16le', '-f', 'avi'] },
      ],
      'dvd-audio': [
        { file: 'legacy-bilingual.mpg', aliases: [], video: 'mpeg2video', audio: 'ac3', secondAudio: 'pcm_dvd',
          container: 'mpeg', bFrames: true, options: ['-c:v', 'mpeg2video', '-q:v', '2', '-g', '12', '-bf', '2',
            '-pix_fmt', 'yuv420p', '-c:a:0', 'ac3', '-b:a:0', '192k', '-ac:a:0', '2',
            '-c:a:1', 'pcm_s16be', '-ac:a:1', '2', '-muxpreload', '0', '-muxdelay', '0', '-f', 'vob'] },
      ],
      'avi-adpcm': [
        { file: 'legacy-msvideo1.avi', aliases: [], video: 'msvideo1', videoTag: 'MSVC', audio: 'adpcm_ima_wav', container: 'avi',
          options: ['-c:v', 'msvideo1', '-vtag', 'MSVC', '-pix_fmt', 'rgb555le',
            '-c:a', 'adpcm_ima_wav', '-f', 'avi'] },
        { file: 'legacy-div3.avi', aliases: [], video: 'msmpeg4v3', videoTag: 'DIV3', audio: 'adpcm_ms', container: 'avi',
          options: ['-c:v', 'msmpeg4', '-vtag', 'DIV3', '-q:v', '2', '-g', '12', '-bf', '0', '-pix_fmt', 'yuv420p',
            '-c:a', 'adpcm_ms', '-f', 'avi'] },
      ],
      'mpeg2-xvid': [
        { file: 'legacy-mpeg2.mpg', aliases: [], video: 'mpeg2video', audio: 'mp2', container: 'mpeg', audioOffset: .3, bFrames: true,
          options: ['-c:v', 'mpeg2video', '-q:v', '2', '-g', '12', '-bf', '2', '-pix_fmt', 'yuv420p',
            '-c:a', 'mp2', '-b:a', '128k', '-muxpreload', '0', '-muxdelay', '0', '-f', 'vob'] },
        { file: 'legacy-xvid.avi', aliases: [], video: 'mpeg4', videoTag: 'XVID', audio: 'mp3', container: 'avi',
          options: ['-c:v', 'mpeg4', '-vtag', 'XVID', '-q:v', '2', '-g', '12', '-bf', '0', '-pix_fmt', 'yuv420p',
            '-c:a', 'copy', '-f', 'avi'] },
      ],
      quicktime: [
        { file: 'legacy-animation.mov', aliases: [], video: 'qtrle', videoTag: 'rle ', audio: 'pcm_s16be',
          options: ['-c:v', 'qtrle', '-pix_fmt', 'rgb24', '-c:a', 'pcm_s16be', '-f', 'mov'] },
        { file: 'legacy-part2.mp4', aliases: [], video: 'mpeg4', videoTag: 'mp4v', audio: 'aac',
          options: ['-c:v', 'mpeg4', '-q:v', '2', '-bf', '2', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
            '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4'], bFrames: true },
      ],
      wmv9: [{ file: 'legacy-wmv9.wmv', aliases: [], video: 'wmv3', videoTag: 'WMV3', audio: 'wmav2', container: 'asf' }],
      vc1: [{ file: 'legacy-vc1.wmv', aliases: [], video: 'vc1', videoTag: 'WVC1', audio: 'wmapro', container: 'asf' }],
      'windows-media': [
        { file: 'legacy-wmv1.wmv', aliases: [], video: 'wmv1', audio: 'wmav1',
          options: ['-c:v', 'wmv1', '-q:v', '2', '-g', '12', '-bf', '0', '-pix_fmt', 'yuv420p',
            '-c:a', 'wmav1', '-b:a', '128k', '-f', 'asf'] },
        { file: 'legacy-wmv2.wmv', aliases: ['legacy-wmv2.asf', 'legacy-wmv2.wma'], video: 'wmv2', audio: 'wmav2', audioOffset: .3,
          options: ['-c:v', 'wmv2', '-q:v', '2', '-g', '12', '-bf', '0', '-pix_fmt', 'yuv420p',
            '-c:a', 'wmav2', '-b:a', '128k', '-f', 'asf'] },
      ],
      legacy: [
        { file: 'legacy-program.mpg', aliases: ['legacy-program.mpeg'], video: 'mpeg1video', audio: 'mp2', audioOffset: .3, bFrames: true,
          options: ['-c:v', 'mpeg1video', '-q:v', '2', '-g', '12', '-bf', '2', '-pix_fmt', 'yuv420p',
            '-c:a', 'mp2', '-b:a', '128k', '-muxpreload', '0', '-muxdelay', '0', '-f', 'mpeg'] },
        { file: 'legacy-mjpeg.avi', aliases: [], video: 'mjpeg', audio: 'pcm_s16le',
          options: ['-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj420p', '-c:a', 'pcm_s16le', '-f', 'avi'] },
        { file: 'legacy-elementary.m1v', aliases: ['legacy-elementary.mpv'], elementary: true, video: 'mpeg1video', audio: null,
          options: ['-c:v', 'mpeg1video', '-q:v', '2', '-g', '12', '-bf', '0', '-pix_fmt', 'yuv420p', '-an', '-f', 'mpeg1video'] },
        { file: 'legacy-ntsc.mpv', aliases: [], elementary: true, fps: [30000, 1001], video: 'mpeg1video', audio: null,
          options: ['-c:v', 'mpeg1video', '-q:v', '2', '-g', '12', '-bf', '2', '-pix_fmt', 'yuv420p', '-an', '-f', 'mpeg1video'] },
      ],
    }
  const cases = fixturesByGroup[prefix]
  const completeReadback = windowsMaster || prefix === 'quicktime'
  let failure, authorInputs, cinepakAvailable = false
  try {
    if (windowsMaster) {
      authorInputs = JSON.parse(readFileSync(path(prefix + '-source.json'), 'utf8'))
      if (authorInputs.commit !== process.env.GITHUB_SHA || authorInputs.rgbSha256 !== sha(rgb) || authorInputs.monoSha256 !== sha(pcm))
        throw new Error('Windows author inputs differ from this run’s original picture and sound')
    }
    if (prefix === 'legacy')
      cinepakAvailable = /^\s*V\S*\s+cinepak\s/m.test(run('ffmpeg', ['-hide_banner', '-encoders'], prefix + '-encoders'))
    else if (!windowsMaster) run('ffmpeg', ['-hide_banner', '-encoders'], prefix + '-encoders')
    else run('ffmpeg', ['-version'], prefix + '-decoder-version')
    if (cinepakAvailable) cases.push({ file: 'legacy-cinepak.avi', aliases: [], video: 'cinepak', audio: 'pcm_s16le',
      options: ['-c:v', 'cinepak', '-q:v', '3', '-pix_fmt', 'rgb24', '-c:a', 'pcm_s16le', '-f', 'avi'] })
    for (const item of cases) {
      // Mux a previously encoded CBR MP3 so encoder priming cannot move the
      // first AVI video timestamp or insert a duplicate placeholder frame.
      let soundInput = item.audio ? audioInput : []
      if (item.audio === 'mp3') {
        const track = path(prefix + '-track.mp3')
        run('ffmpeg', [...common, ...audioInput, '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '128k',
          '-write_xing', '0', '-f', 'mp3', track], item.file + '.encode-audio')
        soundInput = ['-f', 'mp3', '-i', track]
      }
      const [rateNum, rateDen] = item.fps ?? [fps, 1], itemFps = rateNum / rateDen, inputRate = `${rateNum}/${rateDen}`
      if (!windowsMaster) run('ffmpeg', [...common, ...videoInput, '-framerate', inputRate, '-i', path(prefix + '-authored.rgb'), ...(item.audioOffset ? ['-itsoffset', String(item.audioOffset)] : []),
        ...soundInput, ...(item.secondAudio ? ['-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', path(prefix + '-alternate.s16le')] : []),
        '-map', '0:v:0',
        ...(item.audio ? ['-map', '1:a:0'] : []), ...(item.secondAudio ? ['-map', '2:a:0'] : []), ...item.options,
        '-r:v', inputRate, '-threads', '1', ...(item.elementary ? ['-frames:v', String(frames)] : ['-t', '4']), path(item.file)], item.file + '.encode')
      if (windowsMaster) {
        const recordedHash = readFileSync(path(prefix + '-original.sha256'), 'utf8').trim().split(/\s+/)[0]
        if (recordedHash !== sha(readFileSync(path(item.file)))) throw new Error('Original Windows media bytes differ: ' + item.file)
      }
      const probe = ['-v', 'error', '-analyzeduration', '10000000', '-probesize', '8388608']
      const metadata = JSON.parse(run('ffprobe', [...probe, '-show_streams', '-show_format', '-of', 'json', path(item.file)], item.file + '.probe')),
        videos = metadata.streams.filter((stream) => stream.codec_type === 'video'),
        audios = metadata.streams.filter((stream) => stream.codec_type === 'audio')
      const audioCodecs = [item.audio, item.secondAudio].filter(Boolean)
      const scale = item.scale ?? 1
      if (videos.length !== 1 || videos[0].codec_name !== item.video || videos[0].width !== width * scale ||
        videos[0].height !== height * scale || (item.container && metadata.format.format_name !== item.container) ||
        (item.videoTag && videos[0].codec_tag_string !== item.videoTag) ||
        audios.length !== audioCodecs.length || !audioCodecs.every((name) => audios.some((a) => a.codec_name === name)) ||
        audios.some((a) => Number(a.sample_rate) !== rate || ((bilingual || windowsMaster) && a.channels !== 2)))
        throw new Error(`Unexpected hosted legacy stream inventory: ${item.file} ${JSON.stringify(metadata.streams)}`)
      const timeline = JSON.parse(run('ffprobe', [...probe, '-fflags', '+genpts', '-select_streams', 'v:0', '-show_frames', '-of', 'json', path(item.file)], item.file + '.frames'))
      if (timeline.frames.length !== frames) throw new Error(`Unexpected hosted legacy frame count: ${item.file}`)
      if (item.scale && !(videos[0].pix_fmt === 'bgr24' && Number(timeline.frames[96].pkt_pos) > 128 * 1024 ** 2))
        throw new Error('Expected the final scene in the RGB AVI beyond the buffered input limit')
      const { times, inferredTimestampIndices, timeScope } = pictureTimes(item, metadata, timeline, itemFps, completeReadback || prefix === 'windows-media' || item.container === 'avi'),
        commonStart = item.elementary ? 0 : Number(metadata.format.start_time ?? videos[0].start_time ?? 0),
        normalizedVideoTimes = times.map((time) => time - commonStart)
      if (!Number.isFinite(commonStart) || normalizedVideoTimes.some((time, index) => !Number.isFinite(time) ||
          (index && time < normalizedVideoTimes[index - 1]))) throw new Error(`Invalid independent legacy timestamps: ${item.file}`)
      if ((item.bFrames || item.file === 'legacy-ntsc.mpv') && !timeline.frames.some((frame) => frame.pict_type === 'B'))
        throw new Error(`Reordered MPEG input must retain B frames: ${item.file}`)
      if (item.audioOffset && !(Number(audios[0].start_time) - Number(videos[0].start_time) > .2))
        throw new Error(`Independent input must retain its delayed audio stream: ${item.file}`)
      run('ffmpeg', [...common, '-i', path(item.file), '-map', '0:v:0',
        ...(item.scale ? ['-vf', `scale=${width}:${height}:flags=neighbor`] : []),
        '-threads:v', '1', '-vsync', '0', '-pix_fmt', 'rgba', '-f', 'rawvideo', path(item.file + '.rgba')], item.file + '.decode')
      const decoded = readFileSync(path(item.file + '.rgba'))
      if (decoded.length !== width * height * 4 * frames) throw new Error(`Incomplete independent legacy decode: ${item.file}`)
      const checkedFrames = item.elementary || completeReadback || prefix === 'mpeg2-xvid' || prefix === 'avi-adpcm' || bilingual || item.scale
        ? Array.from({ length: frames }, (_, i) => i) : [0, 25, 50, 80]
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
      const decodedTracks = []
      if (completeReadback || prefix === 'mpeg2-xvid' || prefix === 'avi-adpcm' || bilingual || item.scale) for (const [index, audio] of audios.entries()) {
        const file = item.file + (bilingual ? '.audio-' + index : '') + '.s16le',
          name = item.file + '.decode-audio' + (bilingual ? '-' + index : ''),
          tone = bilingual ? audio.codec_name === 'ac3' ? 440 : 880 : undefined
        run('ffmpeg', [...common, '-i', path(item.file), '-map', '0:a:' + index, '-ac', '1', '-ar', String(rate),
          '-f', 's16le', path(file)], name)
        const samples = readFileSync(path(file)), toneChecks = []
        for (const [start, frequency] of [[.17, 0], [.9, tone ?? 440], [2.05, tone ?? 660], [3.25, tone ?? 880]]) {
          let peak = 0, cycles = 0, previous = 0
          const first = Math.round(start * rate), count = Math.round(.2 * rate)
          for (let i = first; i < first + count; i++) {
            const sample = samples.readInt16LE(i * 2) / 32768
            peak = Math.max(peak, Math.abs(sample))
            if (sample > 0 && previous <= 0) cycles++
            previous = sample
          }
          const measured = cycles * rate / count
          if (frequency ? peak < .06 || Math.abs(measured - frequency) > 10 : peak > .005)
            throw new Error(`Independent audio decode lost the authored tone: ${item.file} at ${start}s`)
          toneChecks.push({ start, peak, expectedHz: frequency, measuredHz: measured })
        }
        decodedTracks.push({ file, bytes: samples.length, sha256: sha(samples), rate, checks: toneChecks,
          ...(bilingual && { index, codec: audio.codec_name, tone, streamId: audio.id }) })
      }
      const bytes = readFileSync(path(item.file))
      for (const alias of item.aliases) writeFileSync(path(alias), bytes)
      fixtures.push({ file: item.file, aliases: item.aliases, bytes: bytes.length, sha256: sha(bytes),
        videoCodec: item.video, videoTag: videos[0].codec_tag_string, audioCodec: audios[0]?.codec_name ?? null, decodedAudio: decodedTracks[0],
        ...(bilingual && { audioTracks: decodedTracks }), audioInputOffset: item.audioOffset ?? 0,
        fps: itemFps, authoredVideoDuration: frames / itemFps, commonStart, normalizedVideoTimes,
        inferredTimestampIndices, timeScope, metadata, timeline,
        independentRgba: { file: item.file + '.rgba', bytes: decoded.length, sha256: sha(decoded) }, checks })
    }
  } catch (error) { failure = error }
  const report = { schema: 1, commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
    generator: 'scripts/generate-legacy-video-fixtures.mjs',
    scope: windowsMaster ? 'Windows Media Foundation encodes the original ASF; Linux FFmpeg independently reads the original picture markers, timestamps and audio.' :
      'Independent native FFmpeg authors and decodes legacy inputs. No candidate transcode output is used as an expected image.',
    ...(windowsMaster && { authorInputs }),
    complete: !failure, failure: failure ? String(failure) : undefined, width, height, fps, frames, duration: 4,
    ...(prefix === 'legacy' && { cinepak: { encoderAvailable: cinepakAvailable, file: cinepakAvailable ? 'legacy-cinepak.avi' : null,
      scope: cinepakAvailable ? 'Additional native/WASM decode fixture; no extra browser matrix.' : 'Hosted FFmpeg does not expose a Cinepak encoder; not verified.' },
    }),
    authored: { rgb: { file: prefix + '-authored.rgb', bytes: rgb.length, sha256: sha(rgb) },
      pcm: { file: prefix + '-authored.s16le', bytes: pcm.length, sha256: sha(pcm), rate, channels: 1 },
      colors, colorIntervals: [[0, 1.6], [1.6, 2.8], [2.8, 4]], colorFrameIntervals: [[0, 40], [40, 70], [70, 100]],
      ...(bilingual ? { alternatePcm: { file: prefix + '-alternate.s16le', bytes: alternate.length, sha256: sha(alternate) },
        audioPrograms: [{ codec: 'ac3', toneHz: 440 }, { codec: 'pcm_dvd', toneHz: 880 }], initialSilenceSeconds: .5 } :
      { soundIntervals: [{ start: 0, end: .5, frequency: 0 }, { start: .5, end: 1.6, frequency: 440 },
        { start: 1.6, end: 2.8, frequency: 660 }, { start: 2.8, end: 4, frequency: 880 }] }),
      marker: { bits: 7, order: 'LSB first', x: 6, y: 44, width: 12, height: 16, dark: 16, light: 235 } },
    fixtures, commands }
  const manifest = (prefix === 'legacy' ? 'legacy-video' : prefix) + '-reference.json'
  writeFileSync(path(manifest), JSON.stringify(report, null, 2) + '\n')
  if (failure) throw failure
  return { manifest, fixtures: fixtures.length }
}

export const generateLegacyVideoFixtures = (directory) => generateMovieFixtures(directory, 'legacy')
/** Separate invocation/report: a failed MPEG fixture must not suppress WMV. */
export const generateWindowsMediaFixtures = (directory) => generateMovieFixtures(directory, 'windows-media')
export const generateMpeg2XvidFixtures = (directory) => generateMovieFixtures(directory, 'mpeg2-xvid')
export const generateAviAdpcmFixtures = (directory) => generateMovieFixtures(directory, 'avi-adpcm')
export const generateDvdAudioFixtures = (directory) => generateMovieFixtures(directory, 'dvd-audio')
export const generateLargeDibFixture = (directory) => generateMovieFixtures(directory, 'large-dib')
export const checkWindows9Fixture = (directory) => generateMovieFixtures(directory, 'wmv9')
export const checkVc1Fixture = (directory) => generateMovieFixtures(directory, 'vc1')
export const generateQuickTimeFixtures = (directory) => generateMovieFixtures(directory, 'quicktime')
