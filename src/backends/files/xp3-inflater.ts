import type { ByteSource } from '../../engine/ports/storage.ts'
import { CompressionError } from '../../formats/binary/compression-error.ts'
import { Xp3SegmentPool } from '../../formats/xp3/segments.ts'

// Feed the browser's zlib reader lazily. Large segment reads never need a
// contiguous encoded or decoded buffer. Every input belongs to the byte source.
async function* inflateChunks(source: ByteSource, start: number, length: number, check: () => void | Promise<void>) {
  let input = 0, stopped = false, buffer = new Uint8Array(0), index = 0
  let inputFailure: { error: unknown } | undefined
  const inflater = new DecompressionStream('deflate')
  const encoded = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        if (stopped) return
        if (input === length) { controller.close(); return }
        if (index === buffer.length) {
          await check()
          const count = Math.min(64 * 1024, length - input)
          const bytes = await source.read(start + input, count)
          await check()
          if (stopped) return
          if (bytes.length !== count) throw new Error('Short compressed XP3 segment read')
          buffer = Uint8Array.from(bytes)
          index = 0
        }
        // Bound expansion per native write while allowing larger disk/HTTP reads.
        const count = Math.min(4096, buffer.length - index)
        controller.enqueue(buffer.subarray(index, index + count))
        input += count
        index += count
      } catch (error) { inputFailure = { error }; throw error }
    },
    cancel() { stopped = true },
  })
  const reader = encoded.pipeThrough(inflater).getReader()
  void reader.closed.catch(() => {}) // The next read still observes a failed idle cursor.
  let ended = false
  try {
    for (;;) {
      const next = await reader.read().catch((error: unknown) => {
        if (inputFailure) throw inputFailure.error
        throw new CompressionError('inflate', error instanceof Error ? error.message : 'XP3 zlib stream failed', { cause: error })
      })
      if (next.done) { ended = true; break }
      if (next.value.length) yield next.value
    }
  } finally {
    stopped = true
    if (!ended) await reader.cancel().catch(() => {})
  }
}

export const createXp3SegmentPool = (keepCursor = false) => new Xp3SegmentPool(inflateChunks, keepCursor)
