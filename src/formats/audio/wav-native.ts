import { audioTag, audioView, pcmSourceLimits } from './pcm-source.ts'
import { readWaveFormat, type WaveFormat } from './wav-format.ts'

export interface WaveReadRange { offset: number; length: number }
export interface NativeWaveLayout { format: WaveFormat; data: WaveReadRange }

/** WaveIntf.cpp TVPWDC_RIFFWave::Create / TVPFindRIFFChunk, fixed 2.32:
 * RIFF's outer size is discarded. Find the first fmt, then the first data
 * after it; chunk skips use the declared length without inserting padding.
 * Web compatibility: if that search fails after an odd-sized skipped chunk,
 * retry the first pair with standard word padding. A recognized truncated
 * fmt/data is never hidden by retry. Each of the at most two passes retains
 * the metadata budget (including a misaligned scan through silent PCM).
 * Real storage boundaries remain authoritative.
 * This iterator is shared by buffered and range readers. Only a repeated
 * misaligned empty-chunk scan enables bounded 8 KiB lookahead; ordinary files
 * read just their headers/format, stopping before the selected PCM. */
export function* nativeWaveLayout(size: number): Generator<WaveReadRange, NativeWaveLayout | undefined, Uint8Array> {
  let cachedAt = -1, cached: Uint8Array = new Uint8Array(0)
  function* read(offset: number, length: number, lookAhead = false): Generator<WaveReadRange, Uint8Array, Uint8Array> {
    if (offset >= cachedAt && offset + length <= cachedAt + cached.length)
      return cached.subarray(offset - cachedAt, offset - cachedAt + length)
    if (!lookAhead) return yield { offset, length }
    cachedAt = offset
    cached = yield { offset, length: Math.min(8192, size - offset) }
    return cached.subarray(0, length)
  }
  for (const padded of [false, true]) {
    let offset = 12, chunks = 0, emptyChunks = 0, crossedOdd = false, format: WaveFormat | undefined
    while (offset + 8 <= size) {
      if (++chunks > pcmSourceLimits.waveChunks) {
        if (!padded && crossedOdd) break
        throw new Error('WAVE metadata chunk budget exceeded')
      }
      const header: Uint8Array = yield* read(offset, 8, !padded && crossedOdd && emptyChunks >= 8),
        length: number = audioView(header).getUint32(4, true), start = offset + 8,
        tag = audioTag(header, 0)
      if (length > size - start) {
        if (!padded && crossedOdd && tag !== 'fmt ' && tag !== 'data') break
        throw new Error(`Truncated WAVE ${tag} chunk`)
      }
      if (!format && tag === 'fmt ') {
        format = readWaveFormat(yield* read(start, Math.min(length, 40)))
        if (!format) return
      } else if (format && tag === 'data') return { format, data: { offset: start, length } }
      crossedOdd ||= !!(length & 1)
      emptyChunks = length === 0 ? emptyChunks + 1 : 0
      offset = start + length + (padded ? length & 1 : 0)
    }
    if (!padded && crossedOdd) continue
    if (format) throw new Error('Unsupported WAVE PCM format')
    return
  }
}
