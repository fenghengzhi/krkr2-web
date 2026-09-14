import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

export interface HttpFixture {
  bytes: Buffer
  etag?: string
  full?: boolean
  cors?: boolean
  expose?: string
  intercept?: (request: IncomingMessage, response: ServerResponse) => boolean
}
export async function httpServer(files: Record<string, HttpFixture>) {
  const requests: { path: string; method: string; range?: string; match?: string }[] = []
  let sent = 0,
    aborted = 0
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    const file = files[path]
    requests.push({
      path,
      method: request.method!,
      range: request.headers.range,
      match: request.headers['if-match'] as string | undefined,
    })
    response.on('close', () => {
      if (!response.writableFinished) aborted++
    })
    if (!file) {
      response.writeHead(404).end()
      return
    }
    if (file.cors !== false) {
      response.setHeader('Access-Control-Allow-Origin', '*')
      response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      response.setHeader('Access-Control-Allow-Headers', 'If-Match, Range')
      response.setHeader(
        'Access-Control-Expose-Headers',
        file.expose ?? 'ETag, Content-Range, Content-Encoding',
      )
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return
    }
    if (file.intercept?.(request, response)) return
    if (file.etag) response.setHeader('ETag', file.etag)
    response.setHeader('Content-Type', 'application/octet-stream')
    response.setHeader('Cache-Control', 'no-store')
    if (request.headers['if-match'] && request.headers['if-match'] !== file.etag) {
      response.writeHead(412).end()
      return
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
    if (range && !file.full) {
      const from = Number(range[1]),
        to = Math.min(file.bytes.length - 1, Number(range[2]))
      if (from > to) {
        response.writeHead(416, { 'Content-Range': `bytes */${file.bytes.length}` }).end()
        return
      }
      const bytes = file.bytes.subarray(from, to + 1)
      response.writeHead(206, {
        'Content-Range': `bytes ${from}-${to}/${file.bytes.length}`,
        'Content-Length': bytes.length,
      })
      sent += bytes.length
      response.end(bytes)
    } else {
      response.writeHead(200, { 'Content-Length': file.bytes.length })
      sent += file.bytes.length
      response.end(file.bytes)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    stats: () => ({ sent, aborted }),
    close: async () => {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      server.closeAllConnections()
      await closed
    },
  }
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
export async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('Condition did not settle')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
