import type { ByteSource } from '../../engine/ports/storage.ts'
import type { CddaPcmTrack } from '../../engine/ports/cdda.ts'
import { emptyLoops } from '../../engine/ports/audio.ts'
import { OwnedPcmSource, PcmSourceContext, pcmSourceLimits, type PcmSource, type PcmSourceOptions } from './pcm-source.ts'

type OpenEncoded = (source: ByteSource, options?: PcmSourceOptions) => Promise<PcmSource | undefined>
interface Segment { start: number; count: number; decoder?: PcmSource; offset: number; preEmphasis?: true }

/** Fit the 50/15 µs CD playback curve |(1+s·15µs)/(1+s·50µs)| at
 * DC, one quarter of the sample rate, and Nyquist. A first-order shelf
 * with (1+k)+(1-k)z^-1 has squared gain 1+k² at a quarter rate after
 * dropping the common factor. These k values satisfy all three points. */
function cdDeEmphasis(rate: number) {
  const k = (seconds: number) => Math.hypot(1, Math.PI * rate * seconds) / Math.sqrt(3),
    pole = k(50e-6), zero = k(15e-6), feedback = (pole - 1) / (pole + 1)
  return { direct: (1 + zero) / (1 + pole), delayed: (1 - zero) / (1 + pole), feedback,
    // For a seek, forget the old playhead and prime from real preceding
    // samples. The omitted normalized tail is below Float32 subnormal range.
    history: Math.max(1, Math.ceil(-160 * Math.LN2 / Math.log(Math.abs(feedback)))) }
}
class RawCddaSource extends OwnedPcmSource {
  constructor(context: PcmSourceContext, private readonly littleEndian: boolean) {
    if (context.source.size % 2352) throw new Error('Raw CDDA source is not an integral 2352-byte sector image')
    super({ sampleRate: 44100, channels: 2, bits: 16, sampleCount: context.source.size / 4, loops: emptyLoops() }, context)
  }
  protected async readFrames(position: number, frames: number): Promise<Float32Array[]> {
    const data = [new Float32Array(frames), new Float32Array(frames)], unit = pcmSourceLimits.readBytes / 4
    for (let at = 0; at < frames; at += unit) {
      const count = Math.min(unit, frames - at), bytes = await this.context.read((position + at) * 4, count * 4),
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let i = 0; i < count; i++) {
        data[0]![at + i] = view.getInt16(i * 4, this.littleEndian) / 32768
        data[1]![at + i] = view.getInt16(i * 4 + 2, this.littleEndian) / 32768
      }
    }
    return data
  }
}
class CddaTrackSource extends OwnedPcmSource {
  private retiring?: Promise<void>
  private readonly emphasis?: ReturnType<typeof cdDeEmphasis>
  private filterMemory?: Float64Array
  private nextPosition = -1
  constructor(context: PcmSourceContext, private readonly segments: Segment[],
    private readonly decoders: readonly PcmSource[], sampleRate: number, channels: number, count: number, bits: number) {
    super({ sampleRate, channels, bits, sampleCount: count, loops: emptyLoops() }, context)
    if (segments.some((segment) => segment.preEmphasis)) {
      this.emphasis = cdDeEmphasis(sampleRate)
      this.filterMemory = new Float64Array(channels)
    }
  }
  protected async readFrames(position: number, frames: number): Promise<Float32Array[]> {
    const filter = this.emphasis, sequential = position === this.nextPosition,
      history = filter && !sequential ? Math.min(position, filter.history) : 0,
      first = position - history, end = position + frames,
      output = Array.from({ length: this.info.channels }, () => new Float32Array(frames)),
      memory = this.filterMemory?.slice()
    if (!sequential) memory?.fill(0)
    for (const segment of this.segments) {
      const start = Math.max(first, segment.start), stop = Math.min(end, segment.start + segment.count)
      if (start >= stop) continue
      if (!segment.preEmphasis) memory?.fill(0)
      for (let at = segment.preEmphasis ? start : Math.max(position, start); at < stop;) {
        await this.context.checkpoint()
        const count = Math.min(stop - at, pcmSourceLimits.readFrames),
          planes = await segment.decoder?.read(segment.offset + at - segment.start, count)
        this.context.assertOpen()
        if (segment.decoder && (!planes || planes.length !== output.length || planes.some((plane) => plane.length !== count)))
          throw new Error('Truncated CDDA segment decode')
        for (let channel = 0; channel < output.length; channel++) {
          const input = planes?.[channel], destination = output[channel]!
          if (segment.preEmphasis && filter && memory) {
            let state = memory[channel]!
            for (let i = 0; i < count; i++) {
              const sample = input?.[i] ?? 0, value = filter.direct * sample + state
              state = filter.delayed * sample + filter.feedback * value
              if (at + i >= position) destination[at + i - position] = value
            }
            memory[channel] = state
          } else if (input) destination.set(input, at - position)
        }
        at += count
      }
    }
    this.filterMemory = memory
    this.nextPosition = end
    return output
  }
  private retireDecoders(): Promise<void> {
    if (!this.retiring) {
      // Publish ownership before invoking a decoder. A decoder can have a
      // suspended read whose waiter only its own close() can release.
      this.retiring = Promise.allSettled(this.decoders.map((decoder) => Promise.resolve().then(() => decoder.close())))
        .then((results) => {
          const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
          if (failures.length === 1) throw failures[0]
          if (failures.length) throw new AggregateError(failures, 'CDDA decoder cleanup failed')
        })
      void this.retiring.catch(() => {})
    }
    return this.retiring
  }
  override close(): Promise<void> {
    this.retireDecoders()
    return super.close()
  }
  protected override dispose(): Promise<void> { return this.retireDecoders() }
}

/** A track is exposed as its own PCM timeline. No mixer seek, loop or page can
 * address audio outside the selected INDEX boundaries. All decoders share the
 * backend's cancellation signal and the original borrowed source lifetime. */
export async function openCddaPcmSource(source: ByteSource, track: CddaPcmTrack,
  options: PcmSourceOptions, openEncoded: OpenEncoded): Promise<PcmSource> {
  const context = new PcmSourceContext(source, options), decoders = new Map<string, PcmSource>(), segments: Segment[] = []
  try {
    if (!track || !Array.isArray(track.parts) || !track.parts.length || track.parts.length > 8)
      throw new Error('Invalid CDDA segment inventory')
    const parts = track.parts.map((part) => ({ ...part }))
    let rate = 0, channels = 0, bits = 0, total = 0
    // Open file metadata first so a leading generated gap uses the actual rate.
    for (const part of parts) {
      if (part.kind === 'silence') {
        if (!Number.isSafeInteger(part.frames) || part.frames < 0) throw new Error('Invalid CDDA silence range')
        continue
      }
      if (part.kind !== 'file' || !Number.isSafeInteger(part.offset) || !Number.isSafeInteger(part.size) ||
          part.offset < 0 || part.size <= 0 || part.offset > source.size || part.size > source.size - part.offset ||
          !['encoded', 's16le', 's16be'].includes(part.encoding)) throw new Error('Invalid CDDA source range')
      const key = `${part.offset}:${part.size}:${part.encoding}`
      if (!decoders.has(key)) {
        const slice: ByteSource = { size: part.size, read: (offset, length) => {
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
              offset > part.size || length > part.size - offset) throw new Error('CDDA source read escaped its file')
          return source.read(part.offset + offset, length)
        } }
        let decoder: PcmSource | undefined
        if (part.encoding === 'encoded') decoder = await openEncoded(slice, { ...options, cddaFile: true })
        else {
          const rawContext = new PcmSourceContext(slice, options)
          try { decoder = new RawCddaSource(rawContext, part.encoding === 's16le') }
          catch (error) { rawContext.close(); throw error }
        }
        if (!decoder) {
          context.assertOpen()
          throw new Error('CUE audio encoding is not supported by the portable streaming decoder')
        }
        decoders.set(key, decoder)
        await context.checkpoint()
        const info = decoder.info
        if (!Number.isSafeInteger(info.sampleCount) || info.sampleCount < 1 ||
            !Number.isInteger(info.sampleRate) || info.sampleRate < 1000 || info.sampleRate > 384000 ||
            !Number.isInteger(info.channels) || info.channels < 1 || info.channels > 8)
          throw new Error('Invalid CDDA decoder metadata')
        if (!rate) { rate = info.sampleRate; channels = info.channels; bits = info.bits }
        else if (rate !== info.sampleRate || channels !== info.channels)
          throw new Error('CUE segments with different sample rates or channel counts are not supported')
      }
    }
    if (!rate) throw new Error('CUE audio track has no file-backed samples')
    const sample = (frames: number) => {
      if (!Number.isSafeInteger(frames) || frames < 0 || !Number.isSafeInteger(frames * rate))
        throw new Error('CDDA frame range exceeds safe sample arithmetic')
      return Math.floor(frames * rate / 75)
    }
    for (const part of parts) {
      let decoder: PcmSource | undefined, offset = 0, count: number
      if (part.kind === 'silence') count = sample(part.frames)
      else {
        decoder = decoders.get(`${part.offset}:${part.size}:${part.encoding}`)!
        offset = sample(part.startFrame)
        const end = part.endFrame === undefined ? decoder.info.sampleCount : sample(part.endFrame)
        if (offset > end || end > decoder.info.sampleCount) throw new Error('CUE INDEX exceeds its audio file')
        count = end - offset
      }
      if (!Number.isSafeInteger(total + count)) throw new Error('CDDA track exceeds safe sample range')
      if (count) segments.push({ start: total, count, offset, decoder, preEmphasis: part.preEmphasis })
      total += count
    }
    if (!total) throw new Error('CUE audio track has no playable samples')
    await context.checkpoint()
    return new CddaTrackSource(context, segments, [...decoders.values()], rate, channels, total, bits)
  } catch (error) {
    context.close()
    const results = await Promise.allSettled([...decoders.values()].map((decoder) => decoder.close())),
      failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError([error, ...failures], 'CDDA opening and cleanup failed', { cause: error })
    throw error
  }
}
