import { readWaveFormat, waveInfo, copyWaveSamples, type WaveFormat } from './wav-format.ts'
import type { PcmAsset } from '../../engine/ports/audio.ts'
import { emptyLoops } from '../../engine/ports/audio.ts'
const MAX_PCM_BYTES = 128 * 1024 * 1024

/** RIFF/WAVE integer/float PCM, including WAVE_FORMAT_EXTENSIBLE containers.
 * Keep original sample rate and frame numbers; Web Audio's decoder resamples. */
export function decodeWav(bytes: Uint8Array): PcmAsset | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number, count: number) => String.fromCharCode(...bytes.subarray(at, at + count))
  if (bytes.length < 12 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') return
  const end = view.getUint32(4, true) + 8
  if (end > bytes.length) throw new Error('Truncated WAVE file')
  let format: WaveFormat | undefined,
    data: Uint8Array | undefined
  const loops = emptyLoops()
  for (let at = 12; at + 8 <= end;) {
    const tag = text(at, 4),
      length = view.getUint32(at + 4, true),
      start = at + 8,
      limit = start + length
    if (limit > end) throw new Error(`Truncated WAVE ${tag} chunk`)
    if (tag === 'fmt ') {
      format = readWaveFormat(bytes.subarray(start, limit))
    } else if (tag === 'data') data = bytes.subarray(start, limit)
    else if (tag === 'smpl' && length >= 36) {
      const count = view.getUint32(start + 28, true)
      if (count > (length - 36) / 24) throw new Error('Truncated WAVE sample loop')
      for (let i = 0; i < count; i++) {
        const p = start + 36 + i * 24,
          type = view.getUint32(p + 4, true)
        if (type === 0)
          loops.links.push({
            from: view.getUint32(p + 12, true) + 1,
            to: view.getUint32(p + 8, true),
            smooth: false,
            condition: 'no',
            variable: 0,
            reference: 0,
            whenLooping: true,
          })
      }
    }
    at = limit + (length & 1)
  }
  if (!format) return // The host may support another encoding.
  if (!data) throw new Error('Unsupported WAVE PCM format')
  const info = waveInfo(format, data.length)
  if (info.sampleCount * info.channels * 4 > MAX_PCM_BYTES) throw new Error('Decoded audio exceeds 128 MiB budget')
  const samples = Array.from({ length: info.channels }, () => new Float32Array(info.sampleCount))
  copyWaveSamples(format, data, samples, 0)
  return { kind: 'pcm', ...info, data: samples, loops }
}
