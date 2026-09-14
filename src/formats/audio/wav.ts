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
  let format = 0,
    channels = 0,
    sampleRate = 0,
    bits = 0,
    align = 0,
    data: Uint8Array | undefined
  const loops = emptyLoops()
  for (let at = 12; at + 8 <= end;) {
    const tag = text(at, 4),
      length = view.getUint32(at + 4, true),
      start = at + 8,
      limit = start + length
    if (limit > end) throw new Error(`Truncated WAVE ${tag} chunk`)
    if (tag === 'fmt ') {
      if (length < 16) throw new Error('WAVE format chunk is too short')
      format = view.getUint16(start, true)
      channels = view.getUint16(start + 2, true)
      sampleRate = view.getUint32(start + 4, true)
      align = view.getUint16(start + 12, true)
      bits = view.getUint16(start + 14, true)
      if (format === 0xfffe) {
        if (length < 40 || view.getUint16(start + 16, true) < 22)
          throw new Error('Malformed extensible WAVE')
        format = view.getUint16(start + 24, true)
      }
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
  if (format !== 1 && format !== 3) return // Browser decoder may handle compressed WAVE.
  if (
    !data ||
    channels < 1 ||
    channels > 8 ||
    sampleRate < 1000 ||
    sampleRate > 384000 ||
    ![8, 16, 24, 32, 64].includes(bits) ||
    (format === 3 && bits !== 32 && bits !== 64)
  )
    throw new Error('Unsupported WAVE PCM format')
  if (align !== (channels * bits) / 8 || data.length % align)
    throw new Error('Invalid WAVE block alignment')
  const frames = data.length / align
  if (frames * channels * 4 > MAX_PCM_BYTES) throw new Error('Decoded audio exceeds 128 MiB budget')
  const samples = Array.from({ length: channels }, () => new Float32Array(frames)),
    pcm = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < channels; channel++) {
      const at = frame * align + (channel * bits) / 8
      let value: number
      if (format === 3) value = bits === 32 ? pcm.getFloat32(at, true) : pcm.getFloat64(at, true)
      else if (bits === 8) value = (pcm.getUint8(at) - 128) / 128
      else if (bits === 16) value = pcm.getInt16(at, true) / 32768
      else if (bits === 24)
        value =
          (((pcm.getUint8(at) | (pcm.getUint8(at + 1) << 8) | (pcm.getUint8(at + 2) << 16)) << 8) >>
            8) /
          8388608
      else if (bits === 32) value = pcm.getInt32(at, true) / 2147483648
      else throw new Error('Unsupported integer WAVE bit depth')
      if (!Number.isFinite(value)) throw new Error('WAVE contains a non-finite sample')
      samples[channel]![frame] = value
    }
  return { kind: 'pcm', sampleRate, sampleCount: frames, channels, bits, data: samples, loops }
}
