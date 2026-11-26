import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'
import { customEntryDistribution } from './custom-entry-distribution.ts'

interface DateRequest {
  path: string
  method: string
  range?: string
  unmodifiedSince?: string
  ifRange?: string
  ifMatch?: string
  responseDate?: string
  responseLastModified?: string
  responseETag?: string
  status?: number
  from?: number
  to?: number
  sent: number
  complete: boolean
  aborted: boolean
  error?: string
}

/** An ordinary ZIP containing a real stored zero-filled member, followed by
 * the unchanged authored KAG release. Only small prefix/tail buffers exist;
 * every game member has a real archive offset beyond 64 MiB. */
export async function remoteDateGame() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error('The large date-version game fixture requires a GitHub-hosted runner')
  const game = await customEntryDistribution(false), original = game.bytes,
    endAt = original.length - 22, oldEnd = original.subarray(endAt),
    directoryAt = oldEnd.readUInt32LE(16), directoryBytes = oldEnd.readUInt32LE(12), count = oldEnd.readUInt16LE(10),
    paddingBytes = 70 * 1024 ** 2, zero = Buffer.alloc(65536), paddingName = Buffer.from('Release/unused-padding.bin')
  assert.equal(oldEnd.readUInt32LE(0), 0x06054b50)
  assert.equal(oldEnd.readUInt16LE(20), 0)
  assert.equal(directoryAt + directoryBytes, endAt)
  assert.equal(oldEnd.readUInt16LE(8), count)
  let crc = 0
  for (let at = 0; at < paddingBytes; at += zero.length)
    crc = crc32(zero.subarray(0, Math.min(zero.length, paddingBytes - at)), crc)
  const local = Buffer.alloc(30), centralPadding = Buffer.alloc(46)
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(paddingBytes, 18); local.writeUInt32LE(paddingBytes, 22)
  local.writeUInt16LE(paddingName.length, 26)
  centralPadding.writeUInt32LE(0x02014b50); centralPadding.writeUInt16LE(20, 4)
  local.copy(centralPadding, 6, 4, 28)
  const prefix = Buffer.concat([local, paddingName]), gameAt = prefix.length + paddingBytes,
    central = Buffer.from(original.subarray(directoryAt, endAt)), members: { name: string; dataAt: number; packedBytes: number }[] = []
  for (let at = 0; at < central.length;) {
    assert.equal(central.readUInt32LE(at), 0x02014b50)
    const nameLength = central.readUInt16LE(at + 28), extraLength = central.readUInt16LE(at + 30),
      commentLength = central.readUInt16LE(at + 32), offset = central.readUInt32LE(at + 42),
      name = central.toString('utf8', at + 46, at + 46 + nameLength), packedBytes = central.readUInt32LE(at + 20)
    assert.equal(original.readUInt32LE(offset), 0x04034b50)
    const dataAt = gameAt + offset + 30 + original.readUInt16LE(offset + 26) + original.readUInt16LE(offset + 28)
    central.writeUInt32LE(offset + gameAt, at + 42)
    members.push({ name, dataAt, packedBytes })
    at += 46 + nameLength + extraLength + commentLength
    assert(at <= central.length)
  }
  assert.equal(members.length, count)
  const end = Buffer.from(oldEnd)
  end.writeUInt16LE(count + 1, 8); end.writeUInt16LE(count + 1, 10)
  end.writeUInt32LE(directoryBytes + centralPadding.length + paddingName.length, 12)
  end.writeUInt32LE(directoryAt + gameAt, 16)
  const tail = Buffer.concat([original.subarray(0, directoryAt), centralPadding, paddingName, central, end]), size = gameAt + tail.length,
    hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    issuedAt = Math.floor(Date.now() / 1000) * 1000,
    date = new Date(issuedAt).toUTCString(), lastModified = new Date(issuedAt - 120000).toUTCString(),
    requests: DateRequest[] = [], errors: string[] = []
  let closed = false
  const read = (at: number, length: number) => {
    assert(at >= 0 && length >= 0 && length <= 65536 && at + length <= size)
    const bytes = Buffer.alloc(length)
    for (const part of [{ at: 0, bytes: prefix }, { at: gameAt, bytes: tail }]) {
      const from = Math.max(at, part.at), to = Math.min(at + length, part.at + part.bytes.length)
      if (from < to) part.bytes.copy(bytes, from - at, from - part.at, to - part.at)
    }
    return bytes
  }
  const server = createServer((request, response) => {
    const row: DateRequest = { path: new URL(request.url!, 'http://localhost').pathname, method: request.method!,
      range: request.headers.range, unmodifiedSince: request.headers['if-unmodified-since'] as string | undefined,
      ifRange: request.headers['if-range'] as string | undefined, ifMatch: request.headers['if-match'] as string | undefined,
      sent: 0, complete: false, aborted: false }
    requests.push(row)
    response.on('finish', () => { row.complete = true })
    response.on('close', () => { if (!response.writableFinished) row.aborted = true })
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Range, If-Unmodified-Since')
    response.setHeader('Access-Control-Expose-Headers', 'Date, Last-Modified, Content-Range, Content-Length, Content-Encoding, Accept-Ranges')
    // Response Date advances normally; the unchanged representation keeps its
    // Last-Modified value across the game's full stop and page reload.
    response.setHeader('Date', new Date().toUTCString()); response.setHeader('Last-Modified', lastModified)
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader('Content-Type', 'application/zip')
    row.responseDate = String(response.getHeader('Date'))
    row.responseLastModified = String(response.getHeader('Last-Modified'))
    if (response.hasHeader('ETag')) row.responseETag = String(response.getHeader('ETag'))
    const reject = (status: number) => { row.status = status; response.writeHead(status).end() }
    if (row.path !== '/game.zip') return reject(404)
    if (row.method === 'OPTIONS') return reject(204)
    if (row.method !== 'GET') return reject(405)
    if (row.ifRange || row.ifMatch || row.unmodifiedSince && row.unmodifiedSince !== lastModified) return reject(412)
    const range = /^bytes=(\d+)-(\d+)$/.exec(row.range ?? '')
    if (!range) return reject(400)
    const from = Number(range[1]), to = Math.min(Number(range[2]), size - 1)
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to) return reject(416)
    if (row.range !== 'bytes=0-0' && row.unmodifiedSince !== lastModified) return reject(428)
    row.from = from; row.to = to; row.status = 206
    response.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${size}`, 'Content-Length': to - from + 1 })
    async function* chunks() {
      for (let at = from; at <= to; at += 65536) {
        if (response.destroyed) return
        const bytes = read(at, Math.min(65536, to - at + 1))
        row.sent += bytes.length
        yield bytes
      }
    }
    void pipeline(Readable.from(chunks()), response).catch((error: unknown) => {
      const code = (error as { code?: string }).code
      if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET') row.aborted = true
      else { row.error = String(error); errors.push(row.error) }
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/game.zip`, size, gameAt, lastModified, date, members,
    evidence: { game: game.evidence, size, gameAt, paddingBytes, paddingCrc32: crc,
      prefix: { bytes: prefix.length, sha256: hash(prefix) }, tail: { bytes: tail.length, sha256: hash(tail) },
      members, lastModified, date, etag: null,
      scope: 'A valid ZIP stored zero member plus the unchanged authored original-KAG release. Sparse bytes are produced at requested ranges; no large array or file is generated.' },
    snapshot: () => ({ requests: requests.map((row) => ({ ...row })), errors: [...errors], closed }),
    async close() {
      if (closed) return
      closed = true
      const done = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      server.closeAllConnections(); await done
    },
  }
}
