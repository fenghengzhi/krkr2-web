import { open } from 'node:fs/promises'
import { httpServer } from './http-server.ts'

export interface VideoRangeResponse {
  path: string
  from: number
  to: number
  held: boolean
  sent: number
  finished: boolean
  closed: boolean
  aborted: boolean
}

/** Serve an already-authored sparse XP3 via actual HTTP range responses.
 * Only requested chunks are read; neither route snapshots the complete file. */
export async function videoRangeServer(path: string, holdAt: number) {
  const file = await open(path, 'r'), size = (await file.stat()).size,
    responses: VideoRangeResponse[] = [], errors: string[] = [], pending = new Set<Promise<void>>(),
    tag = '"large-video-range-142"'
  let server: Awaited<ReturnType<typeof httpServer>>
  try {
    const serve = (held: boolean) => ({ bytes: Buffer.alloc(0), etag: tag,
      intercept(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) {
        if (request.method !== 'GET') { response.writeHead(405).end(); return true }
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
        if (!range) { response.writeHead(400).end('Range required'); return true }
        if (request.headers['if-match'] && request.headers['if-match'] !== tag) {
          response.writeHead(412).end(); return true
        }
        const from = Number(range[1]), to = Math.min(size - 1, Number(range[2])), length = to - from + 1
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || length <= 0 || length > 8 * 1024 * 1024) {
          response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return true
        }
        const record: VideoRangeResponse = { path: new URL(request.url!, 'http://fixture').pathname,
          from, to, held: held && from <= holdAt && to >= holdAt, sent: 0,
          finished: false, closed: false, aborted: false }
        responses.push(record)
        response.on('finish', () => { record.finished = true })
        response.on('close', () => { record.closed = true; record.aborted = !response.writableFinished })
        response.writeHead(206, { ETag: tag, 'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store', 'Content-Range': `bytes ${from}-${to}/${size}`, 'Content-Length': length })
        if (record.held) { response.flushHeaders(); return true }
        const work = (async () => {
          try {
            const bytes = Buffer.allocUnsafe(length)
            let read = 0
            while (read < length) {
              const result = await file.read(bytes, read, length - read, from + read)
              if (!result.bytesRead) throw new Error('Sparse video archive returned a short range')
              read += result.bytesRead
            }
            if (response.destroyed) return
            record.sent = bytes.length
            response.end(bytes)
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
            response.destroy(error instanceof Error ? error : new Error(String(error)))
          }
        })()
        pending.add(work)
        void work.finally(() => pending.delete(work))
        return true
      },
    })
    server = await httpServer({ '/play.xp3': serve(false), '/held.xp3': serve(true) })
  } catch (error) { await file.close(); throw error }
  return { url: server.url, size, tag, responses, errors, requests: server.requests,
    stats: () => ({ ...server.stats(), sent: responses.reduce((sum, row) => sum + row.sent, 0),
      pendingFileReads: pending.size, pendingResponses: responses.filter((row) => !row.closed && !row.finished).length }),
    async close() {
      try { await server.close() }
      finally { await Promise.allSettled([...pending]); await file.close() }
    },
  }
}

export function receivedMovieBytes(responses: readonly VideoRangeResponse[], path: string, offset: number, size: number): number {
  const ranges = responses.filter((row) => row.path === path && row.finished && !row.held)
    .map((row) => ({ from: Math.max(offset, row.from), end: Math.min(offset + size, row.to + 1) }))
    .filter((row) => row.end > row.from).sort((a, b) => a.from - b.from)
  let covered = 0, end = offset
  for (const range of ranges) {
    if (range.end <= end) continue
    covered += range.end - Math.max(end, range.from)
    end = range.end
  }
  return covered
}
