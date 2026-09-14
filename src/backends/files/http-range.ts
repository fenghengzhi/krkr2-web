import { MAX_RESOURCE_BYTES, type ByteSource } from '../../engine/ports/storage.ts'
import { BinaryWriter } from '../../formats/binary/writer.ts'

export const HTTP_BLOCK_BYTES = 256 * 1024
export const HTTP_CACHE_BYTES = 32 * 1024 * 1024
const GROUP_BLOCKS = 4
const MAX_PENDING_READ_BYTES = 128 * 1024 * 1024
export interface HttpSource extends ByteSource {
  readonly identity: string
  readonly mode: 'range' | 'snapshot'
}
interface Options {
  fetch?: typeof fetch
  cacheBytes?: number
  timeoutMs?: number
}
class ProtocolError extends Error {}
interface Ticket {
  signal: AbortSignal
  start(): void
  cancel(): void
}
export function remoteUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Remote game files require an HTTP(S) URL without embedded credentials')
  url.hash = ''
  return url.href
}
function strongTag(value: string | null): string | undefined {
  return value && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : undefined
}
function size(value: string): number {
  if (!/^\d+$/.test(value)) throw new ProtocolError('Invalid HTTP byte count')
  const number = Number(value)
  if (!Number.isSafeInteger(number))
    throw new ProtocolError('HTTP byte count exceeds the safe range')
  return number
}
function contentRange(value: string | null): { start: number; end: number; total: number } {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '')
  if (!match)
    throw new ProtocolError(
      'A readable Content-Range header is required; check server CORS exposure',
    )
  const start = size(match[1]!),
    end = size(match[2]!),
    total = size(match[3]!)
  if (start > end || end >= total) throw new ProtocolError('Invalid HTTP Content-Range bounds')
  return { start, end, total }
}
function check(signal: AbortSignal): void {
  signal.throwIfAborted()
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** A session-wide owner for network operations, immutable snapshots and a bounded block LRU. */
export class HttpRangePool {
  private readonly abort = new AbortController()
  private readonly fetcher: typeof fetch
  private readonly cache = new Map<string, Uint8Array>()
  private readonly opened = new Map<string, Promise<HttpSource>>()
  private readonly cleanups = new Set<() => void>()
  private readonly waiting: Ticket[] = []
  private next = 0
  private active = 0
  private retained = 0
  private fixed = 0
  private reserved = 0
  private reading = 0
  private requests = 0
  private received = 0
  private hits = 0
  private readonly limit: number
  private readonly timeout: number
  constructor(options: Options = {}) {
    this.fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args))
    this.limit = options.cacheBytes ?? HTTP_CACHE_BYTES
    this.timeout = options.timeoutMs ?? 15000
    if (
      !Number.isSafeInteger(this.limit) ||
      this.limit < 0 ||
      this.limit > MAX_RESOURCE_BYTES ||
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 120000
    )
      throw new Error('Invalid HTTP source budget or timeout')
  }
  get signal(): AbortSignal {
    return this.abort.signal
  }
  inspect() {
    return {
      requests: this.requests,
      receivedBytes: this.received,
      cacheBytes: this.retained,
      cacheEntries: this.cache.size,
      cacheHits: this.hits,
      snapshotBytes: this.fixed,
      reservedBytes: this.reserved,
      pendingReadBytes: this.reading,
      activeRequests: this.active,
      queuedRequests: this.waiting.length,
    }
  }
  close(): void {
    if (this.signal.aborted) return
    this.abort.abort(new DOMException('Remote sources closed', 'AbortError'))
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups.clear()
    this.opened.clear()
    this.cache.clear()
    this.retained = 0
    this.fixed = 0
  }
  reserveRead(length: number): () => void {
    check(this.signal)
    if (this.reading + length > MAX_PENDING_READ_BYTES)
      throw new Error('Pending HTTP reads exceed 128 MiB budget')
    this.reading += length
    return () => {
      this.reading -= length
    }
  }
  cached(key: string): Uint8Array | undefined {
    const data = this.cache.get(key)
    if (data) {
      this.hits++
      this.cache.delete(key)
      this.cache.set(key, data)
    }
    return data
  }
  has(key: string): boolean {
    return this.cache.has(key)
  }
  store(key: string, data: Uint8Array): void {
    check(this.signal)
    this.remove(key)
    if (data.length > this.limit) return
    while (this.retained + data.length > this.limit) this.remove(this.cache.keys().next().value!)
    this.cache.set(key, data)
    this.retained += data.length
  }
  private remove(key: string): void {
    const value = this.cache.get(key)
    if (value) {
      this.retained -= value.length
      this.cache.delete(key)
    }
  }
  forget(prefix: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.remove(key)
  }
  private acquire(signal: AbortSignal): Promise<void> {
    check(signal)
    if (this.active < 4) {
      this.active++
      return Promise.resolve()
    }
    if (this.active + this.waiting.length >= 128)
      return Promise.reject(new Error('HTTP request queue exceeds 128 operations'))
    return new Promise((resolve, reject) => {
      const ticket: Ticket = {
        signal,
        start: () => {
          signal.removeEventListener('abort', ticket.cancel)
          this.active++
          resolve()
        },
        cancel: () => {
          const at = this.waiting.indexOf(ticket)
          if (at >= 0) this.waiting.splice(at, 1)
          signal.removeEventListener('abort', ticket.cancel)
          reject(signal.reason)
        },
      }
      this.waiting.push(ticket)
      signal.addEventListener('abort', ticket.cancel, { once: true })
      if (signal.aborted) ticket.cancel()
    })
  }
  private release(): void {
    this.active--
    while (this.waiting.length) {
      const next = this.waiting.shift()!
      if (next.signal.aborted) next.cancel()
      else {
        next.start()
        break
      }
    }
  }
  async request<T>(
    url: string,
    headers: Record<string, string>,
    sourceSignal: AbortSignal | undefined,
    use: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operation = new AbortController(),
      signals = [this.signal, ...(sourceSignal ? [sourceSignal] : [])]
    const listeners = signals.map((signal) => {
      const listener = () => operation.abort(signal.reason)
      signal.addEventListener('abort', listener, { once: true })
      if (signal.aborted) listener()
      return () => signal.removeEventListener('abort', listener)
    })
    const timer = setTimeout(
      () => operation.abort(new DOMException('HTTP request timed out', 'TimeoutError')),
      this.timeout,
    )
    let acquired = false
    try {
      await this.acquire(operation.signal)
      acquired = true
      check(operation.signal)
      this.requests++
      const fetching = this.fetcher(url, {
        headers,
        signal: operation.signal,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
      }).then((response) => {
        if (operation.signal.aborted) {
          void response.body?.cancel().catch(() => {})
          check(operation.signal)
        }
        return response
      })
      const response = await abortable(fetching, operation.signal)
      try {
        return await abortable(use(response, operation.signal), operation.signal)
      } finally {
        if (!response.body?.locked) void response.body?.cancel().catch(() => {})
      }
    } finally {
      clearTimeout(timer)
      for (const unlink of listeners) unlink()
      if (acquired) this.release()
    }
  }
  async body(
    response: Response,
    signal: AbortSignal,
    maximum: number,
    expected?: number,
  ): Promise<Uint8Array> {
    if (expected !== undefined && expected > maximum)
      throw new ProtocolError('HTTP body exceeds its read budget')
    const output = expected === undefined ? new BinaryWriter(maximum) : new Uint8Array(expected)
    let position = 0
    const reader = response.body?.getReader()
    if (!reader) {
      if (expected) throw new ProtocolError('HTTP response has no body')
      return new Uint8Array()
    }
    try {
      while (true) {
        check(signal)
        const { value, done } = await abortable(reader.read(), signal)
        check(signal)
        if (done) break
        this.received += value.length
        if (
          value.length > maximum - position ||
          (expected !== undefined && value.length > expected - position)
        )
          throw new ProtocolError('HTTP body exceeds declared size or budget')
        if (output instanceof Uint8Array) output.set(value, position)
        else output.append(value)
        position += value.length
      }
      if (expected !== undefined && position !== expected)
        throw new ProtocolError('HTTP body size mismatch')
      return output instanceof Uint8Array ? output : output.finish()
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  open(input: string): Promise<HttpSource> {
    check(this.signal)
    const url = remoteUrl(input),
      existing = this.opened.get(url)
    if (existing) return existing
    const pending = this.discover(url).catch((error) => {
      if (this.opened.get(url) === pending) this.opened.delete(url)
      throw error
    })
    this.opened.set(url, pending)
    return pending
  }
  private async discover(url: string): Promise<HttpSource> {
    const probe = await this.request(
      url,
      { Range: 'bytes=0-0' },
      undefined,
      async (response, signal) => {
        const finalUrl = remoteUrl(response.url || url)
        if (response.status === 200) return this.snapshot(url, finalUrl, response, signal)
        if (response.status === 416 && response.headers.get('content-range') === 'bytes */0')
          return undefined
        if (response.status !== 206)
          throw new Error(`HTTP source probe failed (${response.status})`)
        const range = contentRange(response.headers.get('content-range'))
        if (range.start !== 0 || range.end !== 0)
          throw new ProtocolError('HTTP source probe returned the wrong range')
        const encoding = response.headers.get('content-encoding')
        if (encoding && encoding.toLowerCase() !== 'identity')
          throw new ProtocolError('HTTP ranges must use identity content encoding')
        const etag = strongTag(response.headers.get('etag'))
        if (!etag) {
          if (range.total > MAX_RESOURCE_BYTES)
            throw new Error('Large remote files require Range and a strong, CORS-exposed ETag')
          return undefined
        }
        if (
          response.headers.has('content-length') &&
          size(response.headers.get('content-length')!) !== 1
        )
          throw new ProtocolError('HTTP probe Content-Length mismatch')
        await this.body(response, signal, 1, 1)
        check(signal)
        const source = new RangeSource(this, `${++this.next}:`, url, finalUrl, range.total, etag)
        this.cleanups.add(() => source.close())
        return source
      },
    )
    if (probe) return probe
    // No trustworthy partial validator: one complete, bounded response becomes an immutable snapshot.
    return this.request(url, {}, undefined, async (response, signal) => {
      if (response.status !== 200)
        throw new Error(`HTTP snapshot download failed (${response.status})`)
      return this.snapshot(url, remoteUrl(response.url || url), response, signal)
    })
  }
  private async snapshot(
    url: string,
    finalUrl: string,
    response: Response,
    signal: AbortSignal,
  ): Promise<HttpSource> {
    const available = MAX_RESOURCE_BYTES - this.fixed - this.reserved
    const identityEncoding =
      !response.headers.get('content-encoding') ||
      response.headers.get('content-encoding')?.toLowerCase() === 'identity'
    const length =
      identityEncoding && response.headers.has('content-length')
        ? size(response.headers.get('content-length')!)
        : undefined
    if ((available <= 0 && length !== 0) || (length !== undefined && length > available))
      throw new Error(
        'HTTP full snapshots exceed the shared 64 MiB budget; a Range server with a strong ETag is required',
      )
    const reservation = length ?? available
    this.reserved += reservation
    try {
      let bytes = await this.body(response, signal, reservation, length)
      const etag = strongTag(response.headers.get('etag'))
      const version =
        etag ??
        'sha256:' +
          [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
      check(signal)
      check(this.signal)
      this.fixed += bytes.length
      const count = bytes.length
      this.cleanups.add(() => {
        bytes = new Uint8Array()
      })
      return {
        size: count,
        mode: 'snapshot',
        identity: JSON.stringify([url, finalUrl, version]),
        read: async (offset, length) => {
          check(this.signal)
          readBounds(offset, length, count)
          const release = this.reserveRead(length)
          try {
            return bytes.slice(offset, offset + length)
          } finally {
            release()
          }
        },
      }
    } finally {
      this.reserved -= reservation
    }
  }
}

function readBounds(offset: number, length: number, total: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > total ||
    length > total - offset
  )
    throw new Error('HTTP read outside file bounds')
  if (length > MAX_RESOURCE_BYTES) throw new Error('HTTP read exceeds 64 MiB budget')
}
class RangeSource implements HttpSource {
  readonly mode = 'range'
  readonly identity: string
  private readonly abort = new AbortController()
  private readonly flights = new Map<number, Promise<Uint8Array>>()
  constructor(
    private readonly pool: HttpRangePool,
    private readonly prefix: string,
    originalUrl: string,
    private readonly url: string,
    readonly size: number,
    private readonly etag: string,
  ) {
    this.identity = JSON.stringify([originalUrl, this.url, etag])
  }
  private check(): void {
    check(this.pool.signal)
    check(this.abort.signal)
  }
  close(reason: Error = new DOMException('HTTP source closed', 'AbortError')): void {
    if (!this.abort.signal.aborted) this.abort.abort(reason)
    this.pool.forget(this.prefix)
    this.flights.clear()
  }
  private load(first: number, count: number): void {
    const start = first * HTTP_BLOCK_BYTES,
      end = Math.min(this.size, (first + count) * HTTP_BLOCK_BYTES) - 1
    const group = this.pool
      .request(
        this.url,
        { Range: `bytes=${start}-${end}`, 'If-Match': this.etag },
        this.abort.signal,
        async (response, signal) => {
          if (response.status === 412 || response.status === 200)
            throw new ProtocolError(
              'Remote file changed or stopped supporting ranges; reload the game',
            )
          if (response.status !== 206)
            throw new Error(`HTTP range request failed (${response.status})`)
          const range = contentRange(response.headers.get('content-range'))
          if (
            remoteUrl(response.url || this.url) !== this.url ||
            strongTag(response.headers.get('etag')) !== this.etag ||
            range.total !== this.size
          )
            throw new ProtocolError('Remote file version changed; reload the game')
          if (range.start !== start || range.end !== end)
            throw new ProtocolError('HTTP server returned the wrong byte range')
          const encoding = response.headers.get('content-encoding')
          if (encoding && encoding.toLowerCase() !== 'identity')
            throw new ProtocolError('HTTP ranges must use identity content encoding')
          if (
            response.headers.has('content-length') &&
            size(response.headers.get('content-length')!) !== end - start + 1
          )
            throw new ProtocolError('HTTP range Content-Length mismatch')
          return this.pool.body(response, signal, end - start + 1, end - start + 1)
        },
      )
      .catch((error) => {
        if (error instanceof ProtocolError) this.close(error)
        throw error
      })
    for (let index = first; index < first + count; index++) {
      const pending = group
        .then((bytes) => {
          this.check()
          const from = (index - first) * HTTP_BLOCK_BYTES
          const chunk = Uint8Array.from(bytes.subarray(from, from + HTTP_BLOCK_BYTES))
          this.pool.store(this.prefix + index, chunk)
          return chunk
        })
        .finally(() => {
          if (this.flights.get(index) === pending) this.flights.delete(index)
        })
      this.flights.set(index, pending)
    }
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.check()
    readBounds(offset, length, this.size)
    const release = this.pool.reserveRead(length)
    try {
      const result = new Uint8Array(length),
        waits: Promise<void>[] = []
      if (!length) return result
      const last = Math.floor((offset + length - 1) / HTTP_BLOCK_BYTES)
      for (let index = Math.floor(offset / HTTP_BLOCK_BYTES); index <= last; index++) {
        const key = this.prefix + index,
          cached = this.pool.cached(key)
        const copy = (bytes: Uint8Array) => {
          this.check()
          const from = Math.max(offset, index * HTTP_BLOCK_BYTES),
            to = Math.min(offset + length, (index + 1) * HTTP_BLOCK_BYTES)
          result.set(
            bytes.subarray(from - index * HTTP_BLOCK_BYTES, to - index * HTTP_BLOCK_BYTES),
            from - offset,
          )
        }
        if (cached) {
          copy(cached)
          continue
        }
        if (!this.flights.has(index)) {
          let count = 1
          while (
            count < GROUP_BLOCKS &&
            index + count <= last &&
            !this.flights.has(index + count) &&
            !this.pool.has(this.prefix + (index + count))
          )
            count++
          this.load(index, count)
        }
        waits.push(this.flights.get(index)!.then(copy))
      }
      const settled = await Promise.allSettled(waits)
      this.check()
      const failed = settled.find((value) => value.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      return result
    } finally {
      release()
    }
  }
}
