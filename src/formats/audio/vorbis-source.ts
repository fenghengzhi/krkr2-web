import CodecParser, { type OggPage } from 'codec-parser'
import type { OggVorbisDecoder } from '@wasm-audio-decoders/ogg-vorbis'
import { emptyLoops } from '../../engine/ports/audio.ts'
import { audioTag, audioView, OwnedPcmSource, PcmSourceContext, pcmSourceLimits, type PcmSource } from './pcm-source.ts'

interface PageHeader {
  start: number; body: number; end: number; flags: number; serial: number; sequence: number
  granule: bigint; laces: Uint8Array
}
interface VorbisLink {
  start: number; end: number; serial: number; position: number; samples: number
  channels: number; rate: number; origin: number; skip: number
}
interface DecodedBlock { position: number; data: Float32Array[] }
const unknownGranule = 0xffffffffffffffffn
const speakerOrder: Record<number, number[]> = {
  3: [0, 2, 1], 5: [0, 2, 1, 3, 4], 6: [0, 2, 1, 5, 3, 4],
  7: [0, 2, 1, 6, 3, 4, 5], 8: [0, 2, 1, 7, 5, 6, 3, 4],
}

async function pageHeader(context: PcmSourceContext, start: number, end: number): Promise<PageHeader> {
  if (end - start < 27) throw new Error('Truncated Ogg page header')
  const bytes = await context.read(start, 27), view = audioView(bytes)
  if (audioTag(bytes, 0) !== 'OggS' || bytes[4] !== 0 || (bytes[5]! & ~7))
    throw new Error('Invalid Ogg page header')
  const count = bytes[26]!, body = start + 27 + count
  if (body > end) throw new Error('Truncated Ogg lacing table')
  const laces = await context.read(start + 27, count)
  let length = 0
  for (const lace of laces) length += lace
  if (body + length > end) throw new Error('Truncated Ogg page body')
  return { start, body, end: body + length, flags: bytes[5]!, serial: view.getUint32(14, true),
    sequence: view.getUint32(18, true), granule: view.getBigUint64(6, true), laces }
}

/** Only headers/lacing and the first 30 bytes of each Vorbis header are read.
 * Data pages are skipped by offset. No encoded-file or decoded-PCM allocation
 * is proportional to duration; the bounded index records logical links only. */
async function scanLinks(context: PcmSourceContext): Promise<VorbisLink[] | undefined> {
  const links: VorbisLink[] = []
  let at = 0, pages = 0
  while (at < context.source.size) {
    if (links.length >= pcmSourceLimits.oggLinks) throw new Error('Ogg logical stream budget exceeded')
    const start = at
    let serial: number | undefined, sequence = 0, packetLength = 0, packet = 0,
      prefixLength = 0, rate = 0, channels = 0, ended = false, lastGranule = 0n
    const prefix = new Uint8Array(30)
    while (at < context.source.size) {
      if (++pages > pcmSourceLimits.oggPages) throw new Error('Ogg page budget exceeded')
      const page = await pageHeader(context, at, context.source.size)
      if (serial === undefined) {
        if (!(page.flags & 2) || (page.flags & 1) || page.sequence !== 0)
          throw new Error('Ogg logical stream must begin with an initial page')
        serial = page.serial
      } else if ((page.flags & 2) || page.serial !== serial)
        throw new Error('Multiplexed Ogg logical streams are not supported')
      if (page.sequence !== sequence++ || !!(page.flags & 1) !== (packetLength > 0))
        throw new Error('Ogg sequence or continued packet is inconsistent')
      let offset = page.body
      for (const lace of page.laces) {
        if (lace > pcmSourceLimits.oggPacketBytes - packetLength) throw new Error('Vorbis packet exceeds input budget')
        if (packet < 3 && prefixLength < prefix.length) {
          const count = Math.min(lace, prefix.length - prefixLength)
          if (count) prefix.set(await context.read(offset, count), prefixLength)
          prefixLength += count
          if (!links.length && packet === 0 && prefixLength >= 7 &&
              (prefix[0] !== 1 || audioTag(prefix, 1, 6) !== 'vorbis')) return
        }
        packetLength += lace
        offset += lace
        if (lace === 255) continue
        if (packet < 3) {
          const expected = packet * 2 + 1
          if (prefixLength < 7 || prefix[0] !== expected || audioTag(prefix, 1, 6) !== 'vorbis') {
            if (!links.length && packet === 0) return
            throw new Error('Invalid or mixed-codec Vorbis header')
          }
          if (packet === 0) {
            if (packetLength !== 30 || at !== start || offset !== page.end)
              throw new Error('Vorbis identification header must occupy its initial page')
            const header = audioView(prefix), block = prefix[28]!, small = block & 15, large = block >>> 4
            rate = header.getUint32(12, true); channels = prefix[11]!
            if (header.getUint32(7, true) !== 0 || !(prefix[29]! & 1) || channels < 1 || channels > 8 ||
                rate < 1000 || rate > 384000 || small < 6 || large > 13 || small > large)
              throw new Error('Unsupported Vorbis stream format')
            if (links.length && (rate !== links[0]!.rate || channels !== links[0]!.channels))
              throw new Error('Chained Vorbis streams must preserve sample rate and channels')
          } else if (packetLength < (packet === 1 ? 16 : 8)) throw new Error('Truncated Vorbis setup header')
        }
        packet++
        packetLength = 0; prefixLength = 0
      }
      if (page.granule !== unknownGranule) {
        if (page.granule < lastGranule) throw new Error('Ogg granule position moved backwards')
        lastGranule = page.granule
      }
      at = page.end
      if (page.flags & 4) {
        if (packetLength || packet < 3 || page.granule === unknownGranule ||
            page.granule > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error('Invalid Vorbis end-of-stream position')
        const samples = Number(page.granule)
        links.push({ start, end: at, serial, position: 0, samples, rate, channels, origin: 0, skip: 0 })
        ended = true
        break
      }
    }
    if (!ended) throw new Error('Vorbis stream has no end-of-stream page')
  }
  if (!links.length) throw new Error('Empty Ogg stream')
  return links
}

function verifyPageChecksum(bytes: Uint8Array): void {
  let crc = 0
  for (let index = 0; index < bytes.length; index++) {
    crc ^= (index >= 22 && index < 26 ? 0 : bytes[index]!) << 24
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0)
  }
  if ((crc >>> 0) !== audioView(bytes).getUint32(22, true)) throw new Error('Ogg page checksum mismatch')
}

/** A parser iterator is drained between chunks. At most one encoded page and
 * one continued packet are retained; the pre-scan and replay both bound packets. */
async function* parsedPages(context: PcmSourceContext, link: VorbisLink): AsyncGenerator<OggPage> {
  const parser = new CodecParser<OggPage>('audio/ogg', { enableFrameCRC32: false, enableLogging: false,
    onCodec(codec) { if (codec !== 'vorbis') throw new Error('Vorbis source codec changed while reading') } })
  let at = link.start, sequence = 0, packetLength = 0, finalSequence = -1
  while (at < link.end) {
    const page = await pageHeader(context, at, link.end)
    if (page.serial !== link.serial || page.sequence !== sequence++ ||
        !!(page.flags & 1) !== (packetLength > 0) || !!(page.flags & 2) !== (at === link.start) ||
        !!(page.flags & 4) !== (page.end === link.end)) throw new Error('Vorbis source pages changed while reading')
    for (const lace of page.laces) {
      if (lace > pcmSourceLimits.oggPacketBytes - packetLength) throw new Error('Vorbis packet exceeds input budget')
      packetLength = lace === 255 ? packetLength + lace : 0
    }
    const bytes = await context.read(at, page.end - at)
    verifyPageChecksum(bytes)
    if (page.flags & 4) {
      finalSequence = page.sequence
      // codec-parser also trims codecFrame.samples on EOS. Keep its public
      // parser's nominal packet spans for origin calibration and let this
      // source perform both head/tail trims. Only this owned parser input copy
      // changes; its original CRC was verified above and source bytes stay intact.
      bytes[5]! &= ~4
    }
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      const pages = parser.parseChunk(bytes.subarray(offset, offset + 16384))
      for (let next = pages.next(); !next.done; next = pages.next()) {
        yield { ...next.value, isLastPage: next.value.pageSequenceNumber === finalSequence }
      }
    }
    at = page.end
  }
  if (packetLength) throw new Error('Truncated Vorbis final packet')
  const final = parser.flush()
  for (let next = final.next(); !next.done; next = final.next()) {
    yield { ...next.value, isLastPage: next.value.pageSequenceNumber === finalSequence }
  }
}

export async function openVorbisPcmSource(context: PcmSourceContext): Promise<PcmSource | undefined> {
  const links = await scanLinks(context)
  if (!links) return
  let position = 0
  for (const link of links) {
    const offset = await initialOffset(context, link)
    link.origin = Math.max(0, offset)
    link.skip = Math.max(0, -offset)
    link.samples -= link.origin
    if (link.samples > Number.MAX_SAFE_INTEGER - position) throw new Error('Vorbis duration exceeds the sample range')
    link.position = position
    position += link.samples
  }
  return new VorbisPcmSource(context, links)
}

function nominalSamples(page: OggPage): number {
  let samples = 0
  for (const frame of page.codecFrames) {
    if (!Number.isInteger(frame.samples) || frame.samples < 0 || frame.samples > 4096)
      throw new Error('Invalid Vorbis packet sample span')
    samples += frame.samples
  }
  return samples
}

/** Xiph Vorbis I A.2 and libvorbis 1.3.7 vorbisfile.c:_initial_pcmoffset:
 * the first PCM-bearing page's granule minus nominal packet spans identifies its
 * origin. Negative origins discard leading PCM; positive origins reduce the
 * reported duration (they are not silence). A short first-and-last page trims
 * its END, as block.c:vorbis_synthesis_blockin explicitly specifies.
 *
 * Only the setup and first audio page(s) are parsed, without a WASM decoder or
 * any PCM allocation. Nonzero origins must flush the second audio packet's
 * page before the third packet, so their calibration stays bounded as well. */
async function initialOffset(context: PcmSourceContext, link: VorbisLink): Promise<number> {
  let packets = 0, samples = 0, primingOrigin: bigint | undefined
  for await (const page of parsedPages(context, link)) {
    if (!page.codecFrames.length) continue
    packets += page.codecFrames.length
    samples += nominalSamples(page)
    const granule = BigInt(page.absoluteGranulePosition)
    if (granule < 0n || granule === unknownGranule) throw new Error('Completed Vorbis audio page has no granule position')
    // A separately paged first packet primes overlap but returns no PCM.
    // Its zero granule cannot distinguish ordinary playback from an edited
    // beginning on the second packet's page. A nonzero hint must agree later.
    if (!samples && !page.isLastPage) {
      if (granule) primingOrigin = granule
      continue
    }
    let offset = Number(granule - BigInt(samples))
    if (offset < 0 && page.isLastPage) offset = 0
    if (primingOrigin !== undefined) {
      if ((!page.isLastPage && BigInt(offset) !== primingOrigin) ||
          (page.isLastPage && granule > BigInt(samples) + primingOrigin))
        throw new Error('Vorbis opening granule positions are inconsistent')
      offset = Number(primingOrigin)
    }
    if (offset && packets > 2) throw new Error('A nonzero Vorbis origin must end the second packet page')
    return offset
  }
  if (link.samples) throw new Error('Vorbis stream has no audio packets')
  return 0
}

class VorbisPcmSource extends OwnedPcmSource {
  private blocks?: AsyncGenerator<DecodedBlock>
  private block?: DecodedBlock
  private linkIndex = -1
  constructor(context: PcmSourceContext, private readonly links: VorbisLink[]) {
    const first = links[0]!, last = links[links.length - 1]!
    super({ sampleRate: first.rate, sampleCount: last.position + last.samples,
      channels: first.channels, bits: 16, loops: emptyLoops() }, context)
  }

  /** Replaying from the logical link's beginning preserves decoder overlap and
   * priming exactly. Backward seeks cost O(prefix); this is not a granule-anchor
   * approximation. Chained links receive separate decoders and parser state. */
  private async *decodeLink(link: VorbisLink): AsyncGenerator<DecodedBlock> {
    await this.context.checkpoint()
    const { OggVorbisDecoder: Decoder } = await import('@wasm-audio-decoders/ogg-vorbis')
    this.context.assertOpen()
    const decoder: OggVorbisDecoder = new Decoder()
    let ready = false, position = 0
    try {
      await decoder.ready
      ready = true
      this.context.assertOpen()
      for await (const page of parsedPages(this.context, link)) {
        const nominal = nominalSamples(page), granule = BigInt(page.absoluteGranulePosition),
          expected = BigInt(position + nominal) + BigInt(link.origin) - BigInt(link.skip),
          primingOnly = !position && !nominal && !page.isLastPage && granule === 0n
        if (page.codecFrames.length && !primingOnly && (granule < 0n || granule === unknownGranule ||
            (!page.isLastPage && granule !== expected) || (page.isLastPage && granule > expected)))
          throw new Error('Vorbis page position disagrees with its packet spans')
        // The public decoder otherwise batches an entire page's 255 packets
        // into one PCM allocation. Submit one packet (<= 4096 output frames).
        // EOS trimming is global here: trimming the last one-packet batch in
        // isolation can underflow when more than one trailing packet is padding.
        const frames = page.codecFrames.length ? page.codecFrames : [undefined]
        for (const frame of frames) {
          await this.context.checkpoint()
          const decoded = await decoder.decodeOggPages([{ ...page,
            codecFrames: frame ? [frame] : [], isLastPage: false }])
          this.context.assertOpen()
          if (decoded.errors.length) throw new Error(`Vorbis decode failed: ${decoded.errors[0]!.message}`)
          const count = decoded.samplesDecoded
          if (!Number.isSafeInteger(count) || count < 0 || count > 4096) throw new Error('Vorbis packet output exceeds frame budget')
          if (frame && count !== frame.samples) throw new Error('Vorbis decoded packet disagrees with its nominal sample span')
          if (!count) continue
          if (decoded.sampleRate !== link.rate || decoded.channelData.length !== link.channels ||
              decoded.channelData.some((channel) => channel.length !== count))
            throw new Error('Vorbis decoded format disagrees with its stream header')
          if (position + count - link.skip > link.samples && !page.isLastPage)
            throw new Error('Vorbis decoded data exceeds its end position before the final page')
          const discard = Math.max(0, Math.min(count, link.skip - position)),
            start = Math.max(0, position - link.skip),
            keep = Math.max(0, Math.min(count - discard, link.samples - start))
          position += count
          for (const channel of decoded.channelData) for (const value of channel)
            if (!Number.isFinite(value)) throw new Error('Vorbis contains a non-finite sample')
          if (keep) {
            const order = speakerOrder[link.channels], channels = order?.map((index) => decoded.channelData[index]!) ?? decoded.channelData
            yield { position: start, data: channels.map((channel) => new Float32Array(channel.subarray(discard, discard + keep))) }
          }
        }
      }
      if (position - link.skip < link.samples) throw new Error('Vorbis decoded length disagrees with its end position')
    } finally {
      // Never free across an outstanding ready/decode operation. The read queue
      // waits for this finally block before close releases the caller's lease.
      if (ready) decoder.free()
    }
  }

  private async resetLink(index: number): Promise<void> {
    if (this.blocks) await this.blocks.return(undefined)
    this.blocks = undefined; this.block = undefined; this.linkIndex = index
    if (index >= 0) this.blocks = this.decodeLink(this.links[index]!)
  }
  protected async readFrames(position: number, frames: number): Promise<Float32Array[]> {
    const result = Array.from({ length: this.info.channels }, () => new Float32Array(frames))
    try {
      for (let written = 0; written < frames;) {
        const absolute = position + written,
          index = this.links.findIndex((link) => absolute >= link.position && absolute < link.position + link.samples),
          link = this.links[index]!
        if (index < 0) throw new Error('Vorbis sample is outside all logical streams')
        const wanted = absolute - link.position
        if (index !== this.linkIndex || (this.block && wanted < this.block.position)) await this.resetLink(index)
        while (!this.block || wanted >= this.block.position + this.block.data[0]!.length) {
          const next = await this.blocks!.next()
          if (next.done) throw new Error('Vorbis decoded length disagrees with its end position')
          this.block = next.value
        }
        const offset = wanted - this.block.position,
          count = Math.min(frames - written, this.block.data[0]!.length - offset)
        for (let channel = 0; channel < result.length; channel++)
          result[channel]!.set(this.block.data[channel]!.subarray(offset, offset + count), written)
        written += count
        if (wanted + count === link.samples) {
          // Consume and validate the final packets/checksum even when all their
          // output is EOS padding. No full trailing-page PCM is retained.
          while (!(await this.blocks!.next()).done) { /* bounded discard */ }
          await this.resetLink(-1)
        }
      }
      return result
    } catch (error) { await this.resetLink(-1); throw error }
  }
  protected async dispose(): Promise<void> { await this.resetLink(-1) }
}
