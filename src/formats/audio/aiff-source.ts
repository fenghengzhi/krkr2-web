import { emptyLoops } from '../../engine/ports/audio.ts'
import { audioTag, audioView, OwnedPcmSource, pcmSourceLimits, type PcmSourceContext } from './pcm-source.ts'

interface AiffFormat {
  channels: number
  frames: number
  bits: number
  rate: number
  bytesPerSample: number
  sample(view: DataView, at: number): number
}

/** AIFF uses a big-endian 80-bit extended number. Keep all significand
 * bits until an integral rate on the mixer's sample clock is established. */
function sampleRate(view: DataView): number {
  const exponent = view.getUint16(8) - 16383, significand = view.getBigUint64(10)
  if (exponent < 9 || exponent > 18 || !(significand >> 63n)) throw new Error('Invalid AIFF sample rate')
  const unit = 1n << BigInt(63 - exponent), rate = Number(significand / unit)
  if (significand % unit || rate < 1000 || rate > 384000) throw new Error('Unsupported AIFF sample rate')
  return rate
}

function integerReader(width: number, little: boolean): AiffFormat['sample'] {
  if (width === 1) return (v, at) => v.getInt8(at)
  if (width === 2) return (v, at) => v.getInt16(at, little)
  if (width === 3) return little
    ? (v, at) => v.getInt8(at + 2) * 65536 + v.getUint16(at, true)
    : (v, at) => v.getInt8(at) * 65536 + v.getUint16(at + 1)
  return (v, at) => v.getInt32(at, little)
}

function common(bytes: Uint8Array, aifc: boolean): AiffFormat {
  const view = audioView(bytes), channels = view.getUint16(0), frames = view.getUint32(2),
    bits = view.getUint16(6), rate = sampleRate(view), codec = aifc ? audioTag(bytes, 18) : 'NONE'
  if (channels < 1 || channels > 8) throw new Error('Unsupported AIFF channel count')
  if (codec === 'fl32' || codec === 'FL32' || codec === 'fl64' || codec === 'FL64') {
    if (bits !== Number(codec.slice(2))) throw new Error('Invalid AIFF floating-point width')
    return { channels, frames, bits, rate, bytesPerSample: bits / 8,
      sample: bits === 32 ? (v, at) => v.getFloat32(at) : (v, at) => v.getFloat64(at) }
  }
  if (codec === 'raw ' && bits === 8)
    return { channels, frames, bits, rate, bytesPerSample: 1, sample: (v, at) => (v.getUint8(at) - 128) / 128 }
  const bigIntegerTag = (codec === 'in24' && bits === 24) || (codec === 'in32' && bits === 32)
  if (codec !== 'NONE' && codec !== 'twos' && codec !== 'sowt' && !bigIntegerTag)
    throw new Error('Unsupported AIFF-C encoding: ' + codec)
  if (bits < 1 || bits > 32) throw new Error('Unsupported AIFF PCM width')
  const width = Math.ceil(bits / 8), padding = width * 8 - bits, divisor = 2 ** (bits - 1),
    read = integerReader(width, codec === 'sowt')
  return { channels, frames, bits, rate, bytesPerSample: width, sample: (v, at) => (read(v, at) >> padding) / divisor }
}

class AiffSource extends OwnedPcmSource {
  constructor(context: PcmSourceContext, private readonly format: AiffFormat, private readonly start: number) {
    super({ sampleRate: format.rate, sampleCount: format.frames, channels: format.channels,
      bits: format.bits, loops: emptyLoops() }, context)
  }
  protected async readFrames(position: number, frames: number): Promise<Float32Array[]> {
    const { channels, bytesPerSample, sample } = this.format, stride = channels * bytesPerSample,
      unit = Math.floor(pcmSourceLimits.readBytes / stride),
      output = Array.from({ length: channels }, () => new Float32Array(frames))
    for (let written = 0; written < frames; written += unit) {
      const count = Math.min(unit, frames - written),
        view = audioView(await this.context.read(this.start + (position + written) * stride, count * stride))
      let at = 0
      for (let frame = written; frame < written + count; frame++) {
        for (const plane of output) {
          const value = Math.fround(sample(view, at))
          if (!Number.isFinite(value)) throw new Error('AIFF sample exceeds finite PCM range')
          plane[frame] = value
          at += bytesPerSample
        }
      }
    }
    return output
  }
}

/** COMM counts playable frames. SSND may have an offset before them and
 * alignment bytes after them. Neither padding area is audible CD material. */
export async function openAiffPcmSource(context: PcmSourceContext, prefix: Uint8Array) {
  const type = audioTag(prefix, 8), aifc = type === 'AIFC'
  if (prefix.length < 12 || audioTag(prefix, 0) !== 'FORM' || (!aifc && type !== 'AIFF')) return
  const end = 8 + audioView(prefix).getUint32(4)
  if (end < 12 || end > context.source.size) throw new Error('Truncated AIFF FORM')
  let format: AiffFormat | undefined, data: { start: number; length: number } | undefined
  let chunks = 0, version = false
  for (let at = 12; at < end;) {
    if (end - at < 8) throw new Error('Truncated AIFF chunk header')
    if (++chunks > pcmSourceLimits.waveChunks) throw new Error('AIFF metadata chunk budget exceeded')
    const chunk = await context.read(at, 8), name = audioTag(chunk, 0), size = audioView(chunk).getUint32(4),
      start = at + 8, next = start + size + (size & 1)
    if (next > end) throw new Error('Truncated AIFF ' + name + ' chunk')
    if (name === 'COMM') {
      const count = aifc ? 22 : 18
      if (format || size < count) throw new Error('Invalid AIFF COMM chunk')
      const header = await context.read(start, aifc && size > count ? count + 1 : count)
      if (header.length > count && header[count]! > size - count - 1)
        throw new Error('Truncated AIFF-C compression name')
      format = common(header, aifc)
    } else if (name === 'SSND') {
      if (data || size < 8) throw new Error('Invalid AIFF SSND chunk')
      const offset = audioView(await context.read(start, 8)).getUint32(0)
      if (offset > size - 8) throw new Error('Invalid AIFF SSND offset')
      data = { start: start + 8 + offset, length: size - 8 - offset }
    } else if (aifc && name === 'FVER') {
      if (version || size !== 4 || audioView(await context.read(start, 4)).getUint32(0) !== 0xa2805140)
        throw new Error('Unsupported AIFF-C version')
      version = true
    }
    at = next
  }
  if (!format) throw new Error('Missing AIFF COMM chunk')
  if (format.frames && (!data || format.frames * format.channels * format.bytesPerSample > data.length))
    throw new Error('AIFF sample frames exceed sound data')
  return new AiffSource(context, format, data?.start ?? 0)
}
