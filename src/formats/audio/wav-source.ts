import { emptyLoops } from '../../engine/ports/audio.ts'
import { audioTag, audioView, OwnedPcmSource, PcmSourceContext, pcmSourceLimits, type PcmSource } from './pcm-source.ts'

interface WaveFormat { format: number; channels: number; sampleRate: number; bits: number; align: number }

/** Range-based counterpart of decodeWav, retaining its existing PCM, float,
 * extensible subtype and smpl-loop interpretation. Unknown chunks/data bodies
 * are skipped while scanning metadata; no full data allocation is performed. */
export async function openWavePcmSource(context: PcmSourceContext, initial: Uint8Array): Promise<PcmSource | undefined> {
  if (initial.length < 12 || audioTag(initial, 0) !== 'RIFF' || audioTag(initial, 8) !== 'WAVE') return
  const end = audioView(initial).getUint32(4, true) + 8
  if (end < 12 || end > context.source.size) throw new Error('Truncated WAVE file')
  let format: WaveFormat | undefined, data: { offset: number; length: number } | undefined, chunks = 0, loopRecords = 0
  const loops = emptyLoops()
  for (let at = 12; at + 8 <= end;) {
    if (++chunks > pcmSourceLimits.waveChunks) throw new Error('WAVE metadata chunk budget exceeded')
    const chunk = await context.read(at, 8), length = audioView(chunk).getUint32(4, true),
      start = at + 8, limit = start + length, tag = audioTag(chunk, 0)
    if (limit > end) throw new Error(`Truncated WAVE ${tag} chunk`)
    if (tag === 'fmt ') {
      if (length < 16) throw new Error('WAVE format chunk is too short')
      const body = await context.read(start, Math.min(length, 40)), view = audioView(body)
      let code = view.getUint16(0, true)
      if (code === 0xfffe) {
        if (length < 40 || view.getUint16(16, true) < 22) throw new Error('Malformed extensible WAVE')
        code = view.getUint16(24, true)
      }
      format = { format: code, channels: view.getUint16(2, true), sampleRate: view.getUint32(4, true),
        align: view.getUint16(12, true), bits: view.getUint16(14, true) }
    } else if (tag === 'data') data = { offset: start, length }
    else if (tag === 'smpl' && length >= 36) {
      const header = await context.read(start, 36), count = audioView(header).getUint32(28, true)
      if (count > (length - 36) / 24) throw new Error('Truncated WAVE sample loop')
      if (count > pcmSourceLimits.waveLoops - loopRecords) throw new Error('WAVE loop metadata budget exceeded')
      loopRecords += count
      for (let index = 0; index < count; index++) {
        const loop = audioView(await context.read(start + 36 + index * 24, 24))
        if (loop.getUint32(4, true) === 0) loops.links.push({
          from: loop.getUint32(12, true) + 1, to: loop.getUint32(8, true), smooth: false,
          condition: 'no', variable: 0, reference: 0, whenLooping: true,
        })
      }
    }
    at = limit + (length & 1)
  }
  if (!format || (format.format !== 1 && format.format !== 3)) return
  const { channels, sampleRate, bits, align } = format
  if (!data || channels < 1 || channels > 8 || sampleRate < 1000 || sampleRate > 384000 ||
      ![8, 16, 24, 32, 64].includes(bits) || (format.format === 3 && bits !== 32 && bits !== 64) ||
      (format.format === 1 && bits === 64)) throw new Error('Unsupported WAVE PCM format')
  if (align !== channels * bits / 8 || data.length % align) throw new Error('Invalid WAVE block alignment')
  return new WavePcmSource(context, format, data.offset, data.length / align, loops)
}

class WavePcmSource extends OwnedPcmSource {
  constructor(context: PcmSourceContext, private readonly format: WaveFormat,
    private readonly dataOffset: number, sampleCount: number, loops: ReturnType<typeof emptyLoops>) {
    super({ sampleRate: format.sampleRate, sampleCount, channels: format.channels, bits: format.bits, loops }, context)
  }
  protected async readFrames(position: number, frames: number): Promise<Float32Array[]> {
    const { format, channels, bits, align } = this.format,
      result = Array.from({ length: channels }, () => new Float32Array(frames)),
      unit = Math.floor(pcmSourceLimits.readBytes / align)
    for (let written = 0; written < frames;) {
      const count = Math.min(unit, frames - written),
        bytes = await this.context.read(this.dataOffset + (position + written) * align, count * align),
        pcm = audioView(bytes)
      for (let frame = 0; frame < count; frame++) for (let channel = 0; channel < channels; channel++) {
        const at = frame * align + channel * bits / 8
        let value: number
        if (format === 3) value = bits === 32 ? pcm.getFloat32(at, true) : pcm.getFloat64(at, true)
        else if (bits === 8) value = (pcm.getUint8(at) - 128) / 128
        else if (bits === 16) value = pcm.getInt16(at, true) / 32768
        else if (bits === 24) value = ((pcm.getUint8(at) | (pcm.getUint8(at + 1) << 8) |
          (pcm.getUint8(at + 2) << 16)) << 8 >> 8) / 8388608
        else value = pcm.getInt32(at, true) / 2147483648
        if (!Number.isFinite(value)) throw new Error('WAVE contains a non-finite sample')
        result[channel]![written + frame] = value
        if (!Number.isFinite(result[channel]![written + frame])) throw new Error('WAVE sample exceeds Float32 range')
      }
      written += count
    }
    return result
  }
}
