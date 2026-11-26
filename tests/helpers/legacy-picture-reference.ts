import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { legacyFrameCode } from './legacy-video-game.ts'

interface DisplayFrame {
  pts_time?: string
  best_effort_timestamp_time?: string
  width?: number
  height?: number
}

/** Hosted system decoders observe the produced MP4 independently of the WASM
 * converter and the Web MP4 reader. Do not generate timestamps, change the
 * frame rate, or scale the picture: all 100 authored frames must survive. */
export function inspectLegacyPictures(moviePath: string, sourceTimes: readonly number[], observation: Record<string, unknown>) {
  const width = 96, height = 64, expectedFrames = 100, frameBytes = width * height * 4,
    probe = ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
      '-show_entries', 'frame=pts_time,best_effort_timestamp_time,width,height', '-of', 'json', moviePath],
    decode = ['-v', 'error', '-i', moviePath, '-map', '0:v:0', '-threads:v', '1', '-vsync', '0', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
    report = {
      commands: [['ffprobe', ...probe], ['ffmpeg', ...decode]],
      width, height, expectedFrames, expectedTimes: Array.from(sourceTimes),
      toleranceSeconds: .0001, probedFrames: [] as DisplayFrame[], decodedFrames: 0,
      bytes: 0, sha256: '', matched: false, failures: [] as string[],
      frames: [] as { index: number; expectedCode: number; code?: number; expectedTime?: number;
        time?: number; timestampSource?: string; deltaSeconds?: number; sha256: string; center: number[]; errors: string[] }[],
    }
  observation.picture = report
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const run = (program: string, args: string[], suffix: string, maxBuffer: number, timeout: number): Buffer => {
    try {
      return execFileSync(program, args, { maxBuffer, timeout, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const result = error as { stdout?: Buffer; stderr?: Buffer; status?: number | null; signal?: string | null }
      if (result.stdout) writeFileSync(moviePath + suffix + '.partial', result.stdout)
      if (result.stderr) writeFileSync(moviePath + suffix + '.stderr.log', result.stderr)
      report.failures.push(`${program} failed: ${String(error)}; status=${result.status}; signal=${result.signal}`)
      throw error
    }
  }
  try {
    assert.equal(sourceTimes.length, expectedFrames)
    assert(sourceTimes.every(Number.isFinite))
    const metadata = run('ffprobe', probe, '.picture-probe', 2 * 1024 ** 2, 30000)
    writeFileSync(moviePath + '.picture-probe.json', metadata)
    const parsed = JSON.parse(metadata.toString('utf8')) as { frames?: DisplayFrame[] }
    assert(Array.isArray(parsed.frames), 'Independent ffprobe must report display frames')
    report.probedFrames = parsed.frames
    const rgba = run('ffmpeg', decode, '.picture-decode', 8 * 1024 ** 2, 60000)
    report.bytes = rgba.length; report.sha256 = hash(rgba); report.decodedFrames = rgba.length / frameBytes
    if (report.probedFrames.length !== expectedFrames)
      report.failures.push(`Display timestamps: ${report.probedFrames.length} / ${expectedFrames}`)
    if (rgba.length !== expectedFrames * frameBytes)
      report.failures.push(`Decoded RGBA bytes: ${rgba.length} / ${expectedFrames * frameBytes}`)
    let savedFailureFrame = false
    for (let index = 0; index < Math.floor(rgba.length / frameBytes); index++) {
      const pixels = rgba.subarray(index * frameBytes, (index + 1) * frameBytes), timestamp = report.probedFrames[index],
        errors: string[] = [], center = (32 * width + 48) * 4,
        row: typeof report.frames[number] = { index, expectedCode: index, expectedTime: sourceTimes[index],
          sha256: hash(pixels), center: Array.from(pixels.subarray(center, center + 4)), errors }
      report.frames.push(row)
      try { row.code = legacyFrameCode(pixels) } catch (error) { errors.push(String(error)) }
      if (row.code !== index) errors.push(`Picture marker: ${row.code} / source frame ${index}`)
      if (!timestamp || timestamp.width !== width || timestamp.height !== height)
        errors.push(`Display frame dimensions: ${timestamp?.width}x${timestamp?.height} / ${width}x${height}`)
      if (timestamp) {
        row.timestampSource = timestamp.pts_time !== undefined ? 'pts_time' : 'best_effort_timestamp_time'
        const value = timestamp.pts_time ?? timestamp.best_effort_timestamp_time
        row.time = value === undefined || value === '' ? Number.NaN : Number(value)
        row.deltaSeconds = row.time - (row.expectedTime ?? Number.NaN)
        if (!Number.isFinite(row.deltaSeconds) || Math.abs(row.deltaSeconds) > report.toleranceSeconds)
          errors.push(`Display PTS: ${value} / source ${row.expectedTime} seconds`)
      } else errors.push('Missing independent display timestamp')
      if (errors.length) {
        report.failures.push(`Frame ${index}: ${errors.join('; ')}`)
        if (!savedFailureFrame) {
          writeFileSync(moviePath + `.picture-failed-${index}.rgba`, pixels)
          savedFailureFrame = true
        }
      }
    }
    assert.equal(report.failures.length, 0, report.failures.join('\n'))
    report.matched = true
  } catch (error) {
    if (!report.failures.length) report.failures.push(String(error))
    throw error
  }
  return report
}
