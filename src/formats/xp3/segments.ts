import { CompressionError } from '../binary/compression-error.ts'
import type { ByteSource } from '../../engine/ports/storage.ts'
import { resourceReadBounds } from '../../engine/storage/resource-source.ts'

export interface Xp3Segment {
  compressed: boolean
  offset: number
  size: number
  stored: number
  logical: number
}
type Checkpoint = () => void | Promise<void>
type InflateChunks = (source: ByteSource, start: number, length: number, check: Checkpoint) => AsyncGenerator<Uint8Array>
const cacheBytes = 1024 * 1024
const maxLargeSegments = 4

/** A cursor consumes only as much output as requested. The first pass must
 * also consume the zlib trailer before any bytes leave the archive reader. */
class SegmentCursor {
  at = 0
  private pending?: Uint8Array
  private index = 0
  private work = 0
  constructor(private readonly segment: Xp3Segment, private readonly stream: AsyncGenerator<Uint8Array>,
    private readonly check: Checkpoint) {}

  async advance(end: number, start: number, output: Uint8Array): Promise<void> {
    while (this.at < end) {
      if (!this.pending || this.index === this.pending.length) {
        const next = await this.stream.next()
        if (next.done) throw new CompressionError('inflate', 'Short decompressed XP3 segment')
        if (next.value.length > this.segment.size - this.at) throw new CompressionError('inflate', 'Decompressed XP3 segment exceeds declared size')
        this.pending = next.value
        this.index = 0
      }
      const count = Math.min(this.pending.length - this.index, end - this.at)
      const first = Math.max(this.at, start), last = Math.min(this.at + count, start + output.length)
      if (first < last) output.set(this.pending.subarray(this.index + (first - this.at), this.index + (last - this.at)), first - start)
      this.at += count
      this.index += count
      this.work += count
      if (this.work >= cacheBytes) { this.work = 0; await this.check() }
    }
  }
  async finish(start: number, output: Uint8Array): Promise<void> {
    await this.advance(this.segment.size, start, output)
    // Check the trailer even if the last data chunk had exactly the advertised size.
    for (;;) {
      const next = await this.stream.next()
      if (next.done) return
      if (next.value.length) throw new CompressionError('inflate', 'Decompressed XP3 segment exceeds declared size')
    }
  }
  async close(): Promise<void> { await this.stream.return(undefined) }
}

interface LargeSegment {
  window?: { start: number; bytes: Uint8Array }
  cursor?: SegmentCursor
}

/** The native reader verifies a compressed segment upon entry, and shares a
 * 1 MiB LRU for small decoded segments. For a large segment the Web keeps a
 * bounded read-ahead window and, for playback, a resumable decoder per hot
 * segment. Music and speech can advance independently. Backward seeks outside
 * the window may restart at the segment head. */
export class Xp3SegmentPool {
  private small = new Map<Xp3Segment, Uint8Array>()
  private bytes = 0
  private verified = new WeakSet<Xp3Segment>()
  private large = new Map<Xp3Segment, LargeSegment>()
  private tail: Promise<void> = Promise.resolve()
  private epoch = 0
  private disposed = false
  private readonly waiters = new Set<(error: Error) => void>()
  constructor(private readonly inflate: InflateChunks, private readonly keepCursor: boolean) {}

  async read(source: ByteSource, segment: Xp3Segment, offset: number, target: Uint8Array, checkpoint?: Checkpoint): Promise<void> {
    resourceReadBounds(segment.size, offset, target.length)
    const check = async () => {
      if (this.disposed) throw new Error('XP3 segment reader is disposed')
      await checkpoint?.()
      if (this.disposed) throw new Error('XP3 segment reader is disposed')
    }
    const read = this.tail.then(async () => {
      await check()
      const epoch = this.epoch, cached = this.small.get(segment)
      if (cached) {
        this.small.delete(segment); this.small.set(segment, cached)
        target.set(cached.subarray(offset, offset + target.length))
        return
      }
      const small = segment.size < cacheBytes, full = small || !this.verified.has(segment)
      const state: LargeSegment = this.large.get(segment) ?? {}
      if (!small) {
        this.large.delete(segment); this.large.set(segment, state)
        if (this.large.size > maxLargeSegments) {
          const [old, evicted] = this.large.entries().next().value!
          this.large.delete(old)
          await evicted.cursor?.close()
          await check()
        }
      }
      const window = state.window
      if (window && offset >= window.start && offset + target.length <= window.start + window.bytes.length) {
        target.set(window.bytes.subarray(offset - window.start, offset - window.start + target.length))
        return
      }
      const start = small ? 0 : offset, buffer = small ? new Uint8Array(segment.size) : target.length < cacheBytes
        ? new Uint8Array(Math.min(cacheBytes, segment.size - start)) : target
      let cursor = state.cursor
      state.cursor = undefined
      let copied = 0, failure: { error: unknown } | undefined
      if (!full && window && start >= window.start && start < window.start + window.bytes.length) {
        copied = Math.min(buffer.length, window.start + window.bytes.length - start)
        buffer.set(window.bytes.subarray(start - window.start, start - window.start + copied))
      }
      try {
        if (full || !cursor || cursor.at > start + copied) {
          const previous = cursor
          cursor = undefined
          await previous?.close()
          cursor = new SegmentCursor(segment, this.inflate(source, segment.offset, segment.stored, check), check)
        }
        if (full) await cursor.finish(start, buffer)
        else await cursor.advance(start + buffer.length, start + copied, buffer.subarray(copied))
        await check()
        if (epoch === this.epoch && small) {
          for (const [old, data] of this.small) {
            if (this.bytes + buffer.length <= cacheBytes) break
            this.small.delete(old); this.bytes -= data.length
          }
          if (buffer.length) { this.small.set(segment, buffer); this.bytes += buffer.length }
        } else if (epoch === this.epoch) {
          this.verified.add(segment)
          if (buffer !== target) state.window = { start, bytes: buffer }
          if (!full && this.keepCursor && cursor.at < segment.size) { state.cursor = cursor; cursor = undefined }
        }
        if (buffer !== target) target.set(buffer.subarray(offset - start, offset - start + target.length))
      } catch (error) {
        failure = { error }
        this.verified.delete(segment)
        state.window = undefined
        throw error
      } finally {
        try { await cursor?.close() }
        catch (cleanup) {
          if (failure) throw new AggregateError([failure.error, cleanup], 'XP3 segment read and cleanup failed', { cause: failure.error })
          throw cleanup
        }
      }
    })
    this.tail = read.catch(() => {})
    // A stalled underlying source can drain later. Stop wakes its callers now.
    return new Promise<void>((resolve, reject) => {
      if (this.disposed) reject(new Error('XP3 segment reader is disposed'))
      else this.waiters.add(reject)
      read.then(() => { this.waiters.delete(reject); resolve() }, (error) => { this.waiters.delete(reject); reject(error) })
    })
  }

  compact(): void {
    this.epoch++
    this.small.clear(); this.bytes = 0
    this.verified = new WeakSet()
    for (const { cursor } of this.large.values()) if (cursor) void cursor.close().catch(() => {})
    this.large.clear()
  }

  dispose(): void {
    this.disposed = true
    this.compact()
    for (const reject of this.waiters) reject(new Error('XP3 segment reader is disposed'))
    this.waiters.clear()
  }
}
