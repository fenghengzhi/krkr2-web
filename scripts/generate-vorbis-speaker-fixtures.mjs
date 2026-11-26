import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const directory = resolve('out/verification/vorbis-speakers')
mkdirSync(directory, { recursive: true })
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Vorbis speaker material must be generated on GitHub-hosted Actions')
const rate = 48000, samples = rate * 2, frequencies = { FL: 375, FR: 750, FC: 1125, LFE: 80, BL: 1500, BR: 1875, BC: 2250, SL: 2625, SR: 3000 },
  definitions = [
    { name: 'five', layout: '5.0', mask: 0x37, speakers: ['FL', 'FR', 'FC', 'BL', 'BR'],
      pan: ['FL+0.70710678*FC+0.70710678*BL', 'FR+0.70710678*FC+0.70710678*BR'] },
    { name: 'six-one', layout: '6.1', mask: 0x70f, speakers: ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'],
      pan: ['FL+0.70710678*FC+0.5*BC+0.70710678*SL', 'FR+0.70710678*FC+0.5*BC+0.70710678*SR'] },
    { name: 'seven-one', layout: '7.1', mask: 0x63f, speakers: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
      pan: ['FL+0.70710678*FC+0.70710678*BL+0.5*SL', 'FR+0.70710678*FC+0.70710678*BR+0.5*SR'] },
  ], commands = [], fixtures = [], hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  report = { schema: 1, complete: false, rate, samples, frequencies, inputAmplitude: .12, fixtures, commands,
    scope: 'Vorbis I mapping 0 speaker identity. FFmpeg independently decodes canonical planes and explicitly applies the existing Web stereo coefficients; not a physical Windows driver comparison.' },
  save = () => writeFileSync(resolve(directory, 'reference.json'), JSON.stringify(report, null, 2) + '\n'),
  run = (program, args) => {
    commands.push({ program, args }); save()
    return execFileSync(program, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  }, asset = (file) => { const bytes = readFileSync(resolve(directory, file)); return { file, bytes: bytes.length, sha256: hash(bytes) } }
save()
try {
  report.ffmpeg = run('ffmpeg', ['-version']).toString()
  for (const definition of definitions) {
    const file = `${definition.name}.ogg`, input = definition.speakers.map((speaker) => `.12*sin(2*PI*${frequencies[speaker]}*t)`).join('|')
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      `aevalsrc=${input}:s=${rate}:d=2:c=${definition.layout}`, '-c:a', 'libvorbis', '-q:a', '7', '-page_duration', '200000', resolve(directory, file)])
    const metadata = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', resolve(directory, file)]).toString()), stream = metadata.streams[0]
    writeFileSync(resolve(directory, `${definition.name}.metadata.json`), JSON.stringify(metadata, null, 2) + '\n')
    if (metadata.streams.length !== 1 || stream.codec_name !== 'vorbis' || stream.sample_rate !== String(rate) ||
        stream.channels !== definition.speakers.length || stream.channel_layout !== definition.layout || stream.time_base !== `1/${rate}` || Number(stream.duration_ts) !== samples)
      throw new Error(`Unexpected Vorbis layout or duration: ${definition.name}`)
    const decoded = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_frames',
      '-show_entries', 'frame=pts,nb_samples', '-of', 'json', resolve(directory, file)]).toString())
    writeFileSync(resolve(directory, `${definition.name}.frames.json`), JSON.stringify(decoded, null, 2) + '\n')
    const encoded = readFileSync(resolve(directory, file)), identification = 27 + encoded[26],
      shortBlock = 2 ** (encoded[identification + 28] & 15), decodedStart = Number(decoded.frames[0]?.pts)
    if (encoded[identification] !== 1 || encoded.toString('ascii', identification + 1, identification + 7) !== 'vorbis' ||
        shortBlock < 64 || shortBlock > 8192 || (decodedStart !== 0 && decodedStart !== shortBlock / 2))
      throw new Error(`Unexpected independent Vorbis output origin: ${definition.name}/${decodedStart}`)
    let decodedEnd = decodedStart
    for (const frame of decoded.frames) {
      const count = Number(frame.nb_samples)
      if (Number(frame.pts) !== decodedEnd || !Number.isSafeInteger(count) || count <= 0)
        throw new Error(`Noncontiguous independent Vorbis output: ${definition.name}`)
      decodedEnd += count
    }
    if (decodedEnd !== samples) throw new Error(`Independent Vorbis output does not reach declared EOF: ${definition.name}`)
    const decodedFrames = decodedEnd - decodedStart
    const canonical = `${definition.name}.canonical.f32`, stereo = `${definition.name}.stereo.f32`
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', resolve(directory, file),
      '-c:a', 'pcm_f32le', '-f', 'f32le', resolve(directory, canonical)])
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', resolve(directory, file), '-af',
      `aformat=sample_fmts=flt,pan=stereo|c0=${definition.pan[0]}|c1=${definition.pan[1]}`,
      '-c:a', 'pcm_f32le', '-f', 'f32le', resolve(directory, stereo)])
    const raw = readFileSync(resolve(directory, canonical)), mixed = readFileSync(resolve(directory, stereo))
    if (raw.length !== decodedFrames * definition.speakers.length * 4 || mixed.length !== decodedFrames * 2 * 4)
      throw new Error(`Independent Vorbis PCM length differs: ${definition.name}`)
    // Resolve each named channel independently of the product decoder/order.
    // The LFE uses 80 Hz, within Vorbis's dedicated low-frequency bandwidth.
    const amplitudes = definition.speakers.map((speaker, channel) => {
      let real = 0, imaginary = 0
      for (let at = rate / 2; at < rate; at++) {
        const value = raw.readFloatLE(((at - decodedStart) * definition.speakers.length + channel) * 4), angle = 2 * Math.PI * frequencies[speaker] * at / rate
        if (!Number.isFinite(value)) throw new Error('Nonfinite independent Vorbis sample')
        real += value * Math.cos(angle); imaginary += value * Math.sin(angle)
      }
      const amplitude = Math.hypot(real, imaginary) * 4 / rate
      if (Math.abs(amplitude - .12) > .01) throw new Error(`Independent speaker is missing or misordered: ${definition.name}/${speaker}/${amplitude}`)
      return { speaker, frequency: frequencies[speaker], amplitude }
    })
    fixtures.push({ ...definition, decodedStart, decodedFrames, shortBlock,
      input: asset(file), canonical: asset(canonical), stereo: asset(stereo), metadata, amplitudes,
      independentCoverage: `[${decodedStart}, ${decodedEnd}); any omitted priming prefix is not fabricated or claimed as independently compared.` }); save()
  }
  report.complete = true; save()
} catch (error) {
  report.failure = String(error?.stack ?? error); save()
  writeFileSync(resolve(directory, 'failure.txt'), report.failure + '\n'); throw error
}
