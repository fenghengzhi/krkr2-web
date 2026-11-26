import type { AudioInfo, PcmEncoding } from '../../engine/ports/audio.ts'

export interface WaveFormat {
  floating: boolean
  channels: number
  sampleRate: number
  containerBits: number
  bits: number
  align: number
  /** Input plane for each canonical output plane; absent means intact copy. */
  channelOrder?: readonly number[]
}

// Fixed WaveImpl::TVPWaveFormatToBuffer: an unspecified six-channel source is
// FL, FC, FR, BL, BR, LF. DirectSound receives FL, FR, FC, LF, BL, BR. Preserve
// that conversion before our existing stereo mixer consumes canonical planes.
const unmaskedSixChannelOrder = [0, 2, 1, 5, 3, 4] as const

// The first four bytes encode the subtype. The remaining twelve belong to
// the standard KSDATAFORMAT GUID and are significant even for PCM.
const waveGuidTail = [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]
export class WaveFormatError extends Error {}

export function readWaveFormat(bytes: Uint8Array): WaveFormat | undefined {
  if (bytes.length < 16) throw new Error('WAVE format chunk is too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    channels = view.getUint16(2, true), sampleRate = view.getUint32(4, true),
    align = view.getUint16(12, true), containerBits = view.getUint16(14, true)
  let code = view.getUint16(0, true), bits = containerBits, speakerMask = 0
  if (code === 0xfffe) {
    if (bytes.length < 40 || view.getUint16(16, true) !== 22) throw new WaveFormatError('Malformed extensible WAVE')
    code = view.getUint32(24, true)
    if (!waveGuidTail.every((byte, index) => bytes[28 + index] === byte) || code > 0xffff) {
      if ((code & 0xffff) === 1 || (code & 0xffff) === 3) throw new WaveFormatError('Unknown extensible WAVE subtype GUID')
      return
    }
    bits = view.getUint16(18, true)
    speakerMask = view.getUint32(20, true)
  }
  if (code !== 1 && code !== 3) return
  const floating = code === 3
  if (!channels || channels > 8 || sampleRate < 1000 || sampleRate > 384000 ||
      (floating ? ![32, 64].includes(containerBits) || bits !== containerBits :
        ![8, 16, 24, 32].includes(containerBits) || bits < 8 || bits > containerBits))
    throw new WaveFormatError('Unsupported WAVE PCM format')
  if (align !== channels * containerBits / 8) throw new Error('Invalid WAVE block alignment')
  return { channels, sampleRate, align, containerBits, bits, floating,
    ...(channels === 6 && speakerMask === 0 ? { channelOrder: unmaskedSixChannelOrder } : {}) }
}

export function waveInfo(format: WaveFormat, size: number): AudioInfo {
  if (size % format.align) throw new Error('Invalid WAVE block alignment')
  const { channels, sampleRate, bits } = format, sampleCount = size / format.align
  // The 2.32r2 decoder reports TotalSamples using valid bits, but reads/seeks
  // by physical block alignment. Keep the declared time separate from the
  // PCM available to the mixer so it cannot play a following RIFF chunk.
  const reportedSampleCount = Math.floor(size / Math.floor(channels * bits / 8))
  const pcmEncoding = (format.floating ? `f${format.containerBits}` : format.containerBits === 8 ? 'u8' : `s${format.containerBits}`) as PcmEncoding
  return { channels, sampleRate, bits, sampleCount, pcmEncoding,
    ...(reportedSampleCount === sampleCount ? {} : { reportedSampleCount }) }
}

export function copyWaveSamples(format: WaveFormat, bytes: Uint8Array, output: Float32Array[], destination: number,
  narrowS32 = false): void {
  const { align, channels, containerBits, bits, floating } = format,
    input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    sampleBytes = containerBits / 8, padding = containerBits - bits, scale = 2 ** (bits - 1)
  for (let offset = 0, frame = destination; offset < bytes.length; offset += align, frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const at = offset + (format.channelOrder?.[channel] ?? channel) * sampleBytes
      let value: number
      if (floating) value = containerBits === 32 ? input.getFloat32(at, true) : input.getFloat64(at, true)
      else if (containerBits === 8) value = (input.getUint8(at) - 128) / 128
      else {
        const signed = containerBits === 16 ? input.getInt16(at, true) : containerBits === 32 ? input.getInt32(at, true) :
          input.getUint16(at, true) + input.getInt8(at + 2) * 65536
        value = narrowS32 && containerBits === 32
          ? (((signed >> padding) << padding) >> 16) / 32768
          : (signed >> padding) / scale
      }
      if (!Number.isFinite(value)) throw new Error('WAVE contains a non-finite sample')
      output[channel]![frame] = value
      if (!Number.isFinite(output[channel]![frame])) throw new Error('WAVE sample exceeds Float32 range')
    }
  }
}
