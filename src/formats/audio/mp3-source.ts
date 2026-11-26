import type { MPEGDecoder } from 'mpg123-decoder'
import { emptyLoops } from '../../engine/ports/audio.ts'
import { audioTag, audioView, OwnedPcmSource, PcmSourceContext, pcmSourceLimits, type PcmSource } from './pcm-source.ts'
import { mp3AudioEnd } from './mp3-tags.ts'

interface Header { rate: number; channels: number; samples: number; size: number; side: number; crc: number }
interface Anchor { offset: number; frame: number }
interface Mp3Layout {
  start: number; end: number; frames: number; header: Header; skip: number; samples: number; anchors: Anchor[]
}
interface Block { position: number; data: Float32Array[] }
const bitrate1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const bitrate2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

/** MPEG Layer III frame length and side information (ISO/IEC 11172-3,
 * 13818-3); same header tables as fixed mpg123 parse.c:45-58. */
function header(bytes: Uint8Array): Header | undefined {
  if (bytes.length < 4 || bytes[0] !== 255 || (bytes[1]! & 0xe0) !== 0xe0) return
  const version = (bytes[1]! >>> 3) & 3, layer = (bytes[1]! >>> 1) & 3,
    index = bytes[2]! >>> 4, frequency = (bytes[2]! >>> 2) & 3
  if (version === 1 || layer !== 1 || index === 15 || frequency === 3) return
  if (!index) throw new Error('Free-format MP3 is not supported by the CUE reader')
  const rate = [44100, 48000, 32000][frequency]! / (version === 3 ? 1 : version === 2 ? 2 : 4),
    channels = (bytes[3]! >>> 6) === 3 ? 1 : 2, samples = version === 3 ? 1152 : 576,
    side = version === 3 ? channels === 1 ? 17 : 32 : channels === 1 ? 9 : 17,
    crc = bytes[1]! & 1 ? 0 : 2,
    size = Math.floor((version === 3 ? 144000 : 72000) * (version === 3 ? bitrate1 : bitrate2)[index]! / rate) + ((bytes[2]! >>> 1) & 1)
  if (size < 4 + crc + side) throw new Error('Invalid MP3 audio frame size')
  return { rate, channels, samples, size, side, crc }
}
function compatible(a: Header, b: Header): boolean {
  return a.rate === b.rate && a.channels === b.channels && a.samples === b.samples
}

/** One bounded read window avoids one remote round trip per audio header.
 * Header scans skip tag bodies and retain only sparse independent frames. */
class Mp3Input {
  private bytes: Uint8Array = new Uint8Array()
  private start = 0
  constructor(readonly context: PcmSourceContext) {}
  async read(at: number, count: number): Promise<Uint8Array> {
    this.context.assertOpen()
    if (!Number.isSafeInteger(at) || at < 0 || count < 0 || count > pcmSourceLimits.readBytes ||
        at > this.context.source.size || count > this.context.source.size - at) throw new Error('Truncated MP3 frame')
    if (at < this.start || at + count > this.start + this.bytes.length) {
      this.bytes = await this.context.read(at, Math.min(pcmSourceLimits.readBytes, this.context.source.size - at))
      this.start = at
    }
    return this.bytes.subarray(at - this.start, at - this.start + count)
  }
  clear(): void { this.bytes = new Uint8Array() }
}

/** mpg123 08247b3 parse.c:121-403 recognizes Info/Xing independently of CRC,
 * omits that frame, and reads the optional 24-byte LAME extension. These
 * fields are interpreted here once for both sequential reads and seeks. */
function xing(bytes: Uint8Array, format: Header): { frames?: number; delay: number; padding: number } | undefined {
  let at = 4 + format.side
  if (bytes.length < at + 8 || !['Xing', 'Info'].includes(audioTag(bytes, at))) return
  for (let i = 6; i < at; i++) if (bytes[i] !== 0) return
  const view = audioView(bytes), flags = view.getUint32(at + 4), result: { frames?: number; delay: number; padding: number } = { delay: 0, padding: 0 }
  at += 8
  for (const [flag, count] of [[1, 4], [2, 4], [4, 100], [8, 4]] as const) if (flags & flag) {
    if (at + count > bytes.length) throw new Error('Truncated MP3 Xing header')
    if (flag === 1) result.frames = view.getUint32(at)
    at += count
  }
  if (at + 24 <= bytes.length && bytes[at]) {
    result.delay = (bytes[at + 21]! << 4) | (bytes[at + 22]! >>> 4)
    result.padding = ((bytes[at + 22]! & 15) << 8) | bytes[at + 23]!
  }
  return result
}

async function scan(input: Mp3Input): Promise<Mp3Layout | undefined> {
  const { context } = input
  let start = 0
  const end = await mp3AudioEnd((at, count) => input.read(at, count), context.source.size)
  // Standard ID3v2 tags precede the elementary stream and do not occupy any
  // PCM time. Skip their declared bodies without materializing cover art.
  while (end - start >= 10) {
    const tag = await input.read(start, 10)
    if (audioTag(tag, 0, 3) !== 'ID3') break
    if (![2, 3, 4].includes(tag[3]!) || tag.subarray(6, 10).some((byte) => byte > 127))
      throw new Error('Invalid MP3 ID3 header')
    const length = tag[6]! * 2097152 + tag[7]! * 16384 + tag[8]! * 128 + tag[9]!,
      total = 10 + length + (tag[3] === 4 && (tag[5]! & 16) ? 10 : 0)
    if (total > end - start) throw new Error('Truncated MP3 ID3 tag')
    start += total; await context.checkpoint()
  }
  if (end - start < 4) return
  const first = header(await input.read(start, 4))
  if (!first) return
  const info = xing(await input.read(start, first.size), first)
  if (info) start += first.size
  const anchors: Anchor[] = []
  let at = start, frames = 0, spacing = 1
  while (at < end) {
    if (++frames > pcmSourceLimits.mp3Frames) throw new Error('MP3 audio frame budget exceeded')
    const current = header(await input.read(at, 4))
    if (!current || !compatible(current, first)) throw new Error('MP3 stream changes format or contains a non-audio suffix')
    if (current.size > end - at) throw new Error('Truncated MP3 audio frame')
    const side = await input.read(at + 4 + current.crc, 2),
      back = current.samples === 1152 ? (side[0]! << 1) | (side[1]! >>> 7) : side[0]!, frame = frames - 1
    if (!frame && back) throw new Error('MP3 begins inside an earlier frame reservoir')
    if (!back && (!anchors.length || frame - anchors.at(-1)!.frame >= spacing)) {
      if (anchors.length === pcmSourceLimits.mp3SeekPoints) {
        let kept = 0
        for (let i = 0; i < anchors.length; i += 2) anchors[kept++] = anchors[i]!
        anchors.length = kept; spacing *= 2
      }
      anchors.push({ offset: at, frame })
    }
    at += current.size; await context.checkpoint()
  }
  if (!frames || (info?.frames && info.frames !== frames)) throw new Error('MP3 Xing frame count disagrees with the audio stream')
  // Fixed mpg123 frame.c:804 uses decoder delay 529 (layer3.h), with the
  // logical interval [encoderDelay+529, frames*spf-padding+529). An untagged
  // file keeps its physical decoder timeline; do not invent encoder delay.
  const raw = frames * first.samples, skip = info?.frames ? info.delay + 529 : 0,
    limit = info?.frames ? Math.min(raw, raw - info.padding + 529) : raw, samples = limit - skip
  if (!Number.isSafeInteger(samples) || samples <= 0) throw new Error('MP3 delay and padding consume its audio stream')
  return { start, end, frames, header: first, skip, samples, anchors }
}

export async function openMp3PcmSource(context: PcmSourceContext): Promise<PcmSource | undefined> {
  const input = new Mp3Input(context), layout = await scan(input)
  input.clear()
  return layout && new Mp3PcmSource(context, layout)
}

class Mp3PcmSource extends OwnedPcmSource {
  private blocks?: AsyncGenerator<Block>
  private block?: Block
  private nextFrame = 0
  constructor(context: PcmSourceContext, private readonly layout: Mp3Layout) {
    super({ sampleRate: layout.header.rate, sampleCount: layout.samples, channels: layout.header.channels,
      bits: 32, pcmEncoding: 'f32', loops: emptyLoops() }, context)
  }
  private anchor(position: number): Anchor {
    // A reservoir-independent frame needs no discarded packets from before
    // it. Decode four complete frames first to restore the hybrid/polyphase
    // synthesis state (the fixed decoder's ordinary seek preframes default).
    const before = Math.floor((position + this.layout.skip) / this.layout.header.samples) - 4,
      points = this.layout.anchors
    let low = 0, high = points.length
    while (low < high) { const middle = (low + high) >>> 1
      if (points[middle]!.frame <= before) low = middle + 1; else high = middle }
    return points[Math.max(0, low - 1)]!
  }
  private async *decode(anchor: Anchor): AsyncGenerator<Block> {
    const { MPEGDecoder: Decoder } = await import('mpg123-decoder')
    this.context.assertOpen()
    const decoder: MPEGDecoder = new Decoder({ enableGapless: false }), input = new Mp3Input(this.context)
    let ready = false, at = anchor.offset
    try {
      await decoder.ready; ready = true; this.context.assertOpen()
      for (let frame = anchor.frame; frame < this.layout.frames; frame++) {
        await this.context.checkpoint()
        const format = header(await input.read(at, 4))
        if (!format || !compatible(format, this.layout.header) || format.size > this.layout.end - at)
          throw new Error('MP3 source changed while reading')
        const bytes = await input.read(at, format.size), side = 4 + format.crc,
          back = format.samples === 1152 ? (bytes[side]! << 1) | (bytes[side + 1]! >>> 7) : bytes[side]!
        if (frame === anchor.frame && back) throw new Error('MP3 seek anchor is no longer independent')
        const decoded = decoder.decodeFrame(bytes)
        this.context.assertOpen()
        if (decoded.errors.length) throw new Error('MP3 decode failed: ' + decoded.errors[0]!.message)
        if (decoded.samplesDecoded !== format.samples || decoded.sampleRate !== format.rate || decoded.channelData.length !== 2 ||
            decoded.channelData.some((channel) => channel.length !== format.samples)) throw new Error('MP3 decoder frame size disagrees with its header')
        at += format.size; this.nextFrame = frame + 1
        const raw = frame * format.samples - this.layout.skip, discard = Math.max(0, -raw),
          position = Math.max(0, raw), count = Math.max(0, Math.min(format.samples - discard, this.layout.samples - position))
        if (count) yield { position, data: decoded.channelData.slice(0, format.channels)
          .map((channel) => channel.slice(discard, discard + count)) }
      }
    } finally { input.clear(); if (ready) decoder.free() }
  }
  protected async readFrames(position: number, frames: number): Promise<Float32Array[]> {
    const output = Array.from({ length: this.info.channels }, () => new Float32Array(frames))
    let written = 0
    while (written < frames) {
      await this.context.checkpoint()
      const wanted = position + written, anchor = this.anchor(wanted), end = this.block && this.block.position + this.block.data[0]!.length
      if (!this.blocks || (this.block && wanted < this.block.position) ||
          (end !== undefined && wanted >= end && anchor.frame > this.nextFrame)) {
        await this.blocks?.return(undefined)
        this.block = undefined; this.nextFrame = anchor.frame; this.blocks = this.decode(anchor)
      }
      if (!this.block || wanted >= this.block.position + this.block.data[0]!.length) {
        const next = await this.blocks.next()
        if (next.done) throw new Error('MP3 ended before its declared PCM length')
        this.block = next.value; continue
      }
      if (wanted < this.block.position) throw new Error('MP3 seek skipped the requested sample')
      const offset = wanted - this.block.position, count = Math.min(frames - written, this.block.data[0]!.length - offset)
      for (let channel = 0; channel < output.length; channel++)
        output[channel]!.set(this.block.data[channel]!.subarray(offset, offset + count), written)
      written += count
    }
    return output
  }
  protected async dispose(): Promise<void> { await this.blocks?.return(undefined); this.blocks = undefined; this.block = undefined }
}
