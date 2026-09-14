import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ShellManifest } from '../../src/pwa/manifest.ts'
export async function releaseManifest(version: 'a' | 'b') {
  const script = await readFile(resolve(`out/verification/pwa/site-${version}/sw.js`), 'utf8')
  return JSON.parse(
    script.slice('self.__KRKR_SHELL__='.length, script.indexOf(';\n')),
  ) as ShellManifest
}
export async function pwaServer() {
  let version: 'a' | 'b' = 'a',
    failure: string | undefined
  const requests: { path: string; range?: string; version: string }[] = []
  const extra = new Map<string, Buffer>()
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    requests.push({ path, range: request.headers.range, version })
    if (path === '/player') {
      response.writeHead(308, { Location: '/player/' }).end()
      return
    }
    if (!path.startsWith('/player/')) {
      response.writeHead(404).end()
      return
    }
    const file = path.slice('/player/'.length) || 'index.html'
    if (!/^[a-zA-Z0-9_./-]+$/.test(file) || file.split('/').includes('..')) {
      response.writeHead(400).end()
      return
    }
    try {
      let bytes =
        extra.get(file) ?? (await readFile(resolve(`out/verification/pwa/site-${version}`, file)))
      if (file === failure) bytes = Buffer.from('deliberately incomplete deployment')
      const ext = file.split('.').at(-1)!,
        mime: Record<string, string> = {
          html: 'text/html',
          js: 'text/javascript',
          mjs: 'text/javascript',
          css: 'text/css',
          wasm: 'application/wasm',
          json: 'application/json',
          webmanifest: 'application/manifest+json',
          png: 'image/png',
          svg: 'image/svg+xml',
        }
      response.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('ETag', '"test-' + version + '"')
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      if (range) {
        const from = Number(range[1]),
          to = Math.min(bytes.length - 1, Number(range[2]))
        response
          .writeHead(206, {
            'Content-Range': `bytes ${from}-${to}/${bytes.length}`,
            'Content-Length': to - from + 1,
          })
          .end(bytes.subarray(from, to + 1))
      } else response.writeHead(200, { 'Content-Length': bytes.length }).end(bytes)
    } catch {
      response.writeHead(404).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/player/`,
    requests,
    extra,
    deploy(next: 'a' | 'b', bad?: string) {
      version = next
      failure = bad
    },
    async close() {
      const done = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await done
    },
  }
}
