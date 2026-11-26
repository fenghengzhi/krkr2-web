import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

/** Hosted independent AAC decode. In particular, do not add an aresample,
 * adelay or timestamp repair filter here: the actual produced media must
 * contain its leading silence, even for a consumer ignoring an empty edit. */
export function inspectLegacyAudio(moviePath: string, offset: number, observation: Record<string, unknown>) {
  assert(Number.isFinite(offset) && (offset === 0 || offset === .3))
  const probe = ['-v', 'error', '-select_streams', 'a', '-show_streams', '-of', 'json', moviePath],
    decode = ['-v', 'error', '-i', moviePath, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    report = { commands: [['ffprobe', ...probe], ['ffmpeg', ...decode]],
      streams: [] as { sample_rate: string; start_time: string }[], bytes: 0, sha256: '',
      checks: [] as { start: number; duration: number; expectedHz: number; peak: number; measuredHz: number }[] }
  // Publish before external decoding/assertions so a failed comparison retains
  // its command, metadata and already measured PCM, alongside the original MP4.
  observation.audio = report
  report.streams = (JSON.parse(execFileSync('ffprobe', probe, { encoding: 'utf8',
    timeout: 30000, maxBuffer: 1024 * 1024 })) as { streams: typeof report.streams }).streams
  assert.equal(report.streams.length, 1)
  const stream = report.streams[0]!, rate = Number(stream.sample_rate)
  assert(Number.isFinite(rate) && rate > 0)
  const pcm = execFileSync('ffmpeg', decode, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  report.bytes = pcm.length; report.sha256 = createHash('sha256').update(pcm).digest('hex')
  writeFileSync(moviePath + '.f32le', pcm)
  assert(Math.abs(Number(stream.start_time)) <= 1 / rate,
    'Converted audio must start at the common zero origin, with delay represented by PCM')
  assert.equal(pcm.length % 4, 0)
  assert(pcm.length / 4 >= 3.7 * 48000, 'The authored final tone must remain present')
  // The author supplied .5 s of silence, then 440/660/880 Hz tones. MPEG
  // and the delayed ASF keep another .3 s of relative audio delay. These
  // windows avoid codec onset ringing and never derive timing from output.
  const windows = offset ? [[.55, .15, 0], [1.05, .2, 440], [2.15, .2, 660], [3.35, .2, 880]]
    : [[.18, .17, 0], [.9, .2, 440], [2.05, .2, 660], [3.25, .2, 880]]
  for (const [start, duration, expectedHz] of windows as [number, number, number][]) {
    const first = Math.round(start * 48000), count = Math.round(duration * 48000)
    let peak = 0, crossings = 0, previous = pcm.readFloatLE((first - 1) * 4)
    for (let frame = first; frame < first + count; frame++) {
      const sample = pcm.readFloatLE(frame * 4)
      assert(Number.isFinite(sample), `Non-finite independent audio sample at ${frame}`)
      peak = Math.max(peak, Math.abs(sample))
      if (sample > 0 && previous <= 0) crossings++
      previous = sample
    }
    const measuredHz = crossings * 48000 / count
    report.checks.push({ start, duration, expectedHz, peak, measuredHz })
    if (expectedHz) {
      assert(peak > .04, `Missing ${expectedHz} Hz audio at ${start} s`)
      assert(Math.abs(measuredHz - expectedHz) <= 10, `Audio at ${start} s: ${measuredHz} / ${expectedHz} Hz`)
    } else assert(peak < .005, `Initial audio delay was lost: peak ${peak} at ${start} s`)
  }
  return report
}
