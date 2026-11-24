import { emptyLoops } from '../../engine/ports/audio.ts'
import { audioTag, audioView, OwnedPcmSource, PcmSourceContext, pcmSourceLimits, type PcmSource } from './pcm-source.ts'

import { readWaveFormat, waveInfo, copyWaveSamples, type WaveFormat } from './wav-format.ts'

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
      format = readWaveFormat(await context.read(start, Math.min(length, 40)))
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
  if (!format) return
  if (!data) throw new Error('Unsupported WAVE PCM format')
  return new WavePcmSource(context, format, data.offset, data.length, loops)
}

class WavePcmSource extends OwnedPcmSource {
  constructor(context: PcmSourceContext, private readonly format: WaveFormat,
    private readonly dataOffset: number, dataBytes: number, loops: ReturnType<typeof emptyLoops>) {
    super({ ...waveInfo(format, dataBytes), loops }, context)
  }
  protected async readFrames(position: number, frames: number): Promise<Float32Array[]> {
    const { channels, align } = this.format,
      result = Array.from({ length: channels }, () => new Float32Array(frames)),
      unit = Math.floor(pcmSourceLimits.readBytes / align)
    for (let written = 0; written < frames;) {
      const count = Math.min(unit, frames - written),
        bytes = await this.context.read(this.dataOffset + (position + written) * align, count * align)
      copyWaveSamples(this.format, bytes, result, written)
      written += count
    }
    return result
  }
}
