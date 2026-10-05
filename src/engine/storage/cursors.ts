import type { CursorAsset } from '../../formats/cursor/index.ts'
import type { Resource } from '../ports/storage.ts'

export const maximumCursorSourceBytes = 32 * 1024 * 1024
export const maximumCursorPendingSourceBytes = 64 * 1024 * 1024
export const maximumCursorCacheBytes = 64 * 1024 * 1024
export const maximumCursorCacheEntries = 256

interface Entry { id: number; asset: CursorAsset }
interface Reader { valid: () => boolean; failed: boolean; error?: unknown }
interface Flight {
  path: string
  readers: Set<Reader>
  read: Promise<Uint8Array>
  decode?: Promise<CursorAsset>
  reservedBytes: number
  sourceBytes: number
}
interface DecodeJob {
  flight: Flight
  source?: Uint8Array
  resolve: (asset: CursorAsset) => void
  reject: (error: unknown) => void
}
function fail(message: string): never { throw new Error('Cursor: ' + message) }

/** Count the actual retained planes, not a decoder-supplied lower estimate. */
function decodedBytes(asset: CursorAsset): number {
  if (!asset || !Array.isArray(asset.frames) || !asset.frames.length ||
      !Array.isArray(asset.sequence) || !Array.isArray(asset.rates))
    fail('invalid decoded asset')
  let bytes = 0, count = 0
  for (const frame of asset.frames) {
    if (!Array.isArray(frame.images) || !frame.images.length) fail('invalid decoded frame')
    for (const image of frame.images) {
      const pixels = image.width * image.height
      if (!Number.isInteger(image.width) || !Number.isInteger(image.height) ||
          image.width < 1 || image.height < 1 || image.width > 256 || image.height > 256 ||
          !(image.data instanceof Uint8Array) || !(image.andMask instanceof Uint8Array) ||
          image.data.byteLength !== pixels * 4 || image.andMask.byteLength !== pixels)
        fail('invalid decoded image planes')
      bytes += image.data.byteLength + image.andMask.byteLength
      count++
      if (!Number.isSafeInteger(bytes) || bytes > maximumCursorCacheBytes)
        fail('decoded cache byte budget exceeded')
    }
  }
  if (asset.decodedBytes !== bytes || asset.imageCount !== count)
    fail('decoded asset accounting mismatch')
  return bytes
}
/** Session owns compact planes. A decoder workspace or Buffer view must not
 * keep an uncharged backing allocation alive after the load has completed. */
function owned(asset: CursorAsset): CursorAsset {
  return {
    ...asset,
    sequence: [...asset.sequence],
    rates: [...asset.rates],
    ...(asset.animation ? { animation: { ...asset.animation } } : {}),
    frames: asset.frames.map((frame) => ({
      images: frame.images.map((image) => ({
        ...image,
        hotspot: { ...image.hotspot },
        data: new Uint8Array(image.data),
        andMask: new Uint8Array(image.andMask),
      })),
    })),
  }
}

/** Fixed native cursor IDs cache successful loads by resolved path for the
 * whole Session. Assignment and Layer retirement never invalidate an ID.
 * Returned/published assets are Session-internal read-only values. */
export class CursorStorage {
  private readonly entries = new Map<string, Entry>()
  private readonly ids = new Map<number, CursorAsset>()
  private readonly flights = new Map<string, Flight>()
  private nextId = 2
  private bytes = 0
  private reservedBytes = 0
  private sourceBytes = 0
  private disposed = false
  private readonly decodeQueue: DecodeJob[] = []
  private activeDecode?: DecodeJob
  private readonly waiters = new Set<(error: unknown) => void>()
  private disposalError?: Error

  constructor(
    private readonly find: (name: string) => Resource | undefined | Promise<Resource | undefined>,
    private readonly decode: (bytes: Uint8Array) => Promise<CursorAsset>,
    private readonly check: () => void,
    private readonly publish: (id: number, asset: CursorAsset) => void,
  ) {}

  private live(): void {
    if (this.disposed) fail('storage is disposed')
    this.check()
    if (this.disposed) fail('storage is disposed')
  }
  private caller(valid: () => boolean): void {
    this.live()
    if (!valid()) fail('load caller has expired')
    if (this.disposed) fail('storage is disposed')
  }
  private reader(reader: Reader): void {
    this.live()
    if (reader.failed) throw reader.error
    try {
      if (!reader.valid()) fail('load caller has expired')
    } catch (error) {
      reader.failed = true
      reader.error = error
      throw error
    }
    this.live()
  }
  private hasReader(flight: Flight): boolean {
    let live = false
    for (const reader of flight.readers) {
      this.live()
      if (reader.failed) continue
      try { this.reader(reader); live = true }
      catch (error) {
        // One expired/throwing owner must not cancel a valid shared reader.
        // Session cancellation and disposal, however, stop the whole job.
        if (this.disposed || !reader.failed) throw error
      }
    }
    this.live()
    return live
  }
  private wait<T>(work: Promise<T>): Promise<T> {
    // Unsubscribe completed work. Racing every read against one never-settled
    // stop Promise would retain all its race results (including source bytes)
    // until Session shutdown even after the corresponding flight is released.
    return new Promise<T>((resolve, reject) => {
      const cancel = (error: unknown) => { this.waiters.delete(cancel); reject(error) }
      this.waiters.add(cancel)
      void work.then(
        (value) => { this.waiters.delete(cancel); resolve(value) },
        (error) => { this.waiters.delete(cancel); reject(error) },
      )
      if (this.disposed) cancel(this.disposalError)
    })
  }
  private sourceSize(size: number): void {
    if (!Number.isSafeInteger(size) || size <= 0 || size > maximumCursorSourceBytes)
      fail('source byte budget exceeded')
  }
  private start(resource: Resource, path: string): Flight {
    const size = resource.size
    this.sourceSize(size)
    if (this.flights.size >= maximumCursorCacheEntries) fail('pending load budget exceeded')
    if (size > maximumCursorPendingSourceBytes - this.sourceBytes)
      fail('pending source byte budget exceeded')
    const flight: Flight = {
      path,
      readers: new Set(),
      reservedBytes: 0,
      sourceBytes: size,
      // Defer the read until the flight is registered. Synchronous read throws
      // and reentrant calls therefore follow the same cleanup path.
      read: Promise.resolve().then(async () => {
        this.live()
        const bytes = await resource.read()
        this.live()
        if (!(bytes instanceof Uint8Array)) fail('resource did not return bytes')
        this.sourceSize(bytes.byteLength)
        const extra = bytes.byteLength - flight.sourceBytes
        if (extra > maximumCursorPendingSourceBytes - this.sourceBytes)
          fail('pending source byte budget exceeded')
        this.sourceBytes += extra
        flight.sourceBytes = bytes.byteLength
        // A short archive/Buffer view may own a much larger backing store.
        // Retain only the charged bytes while readers share this flight.
        return new Uint8Array(bytes)
      }).catch((error) => { this.retire(flight); throw error }),
    }
    this.sourceBytes += flight.sourceBytes
    this.flights.set(path, flight)
    return flight
  }
  private async prepare(bytes: Uint8Array, flight: Flight): Promise<CursorAsset> {
    this.live()
    const decoded = await this.decode(bytes)
    this.live()
    const size = decodedBytes(decoded)
    if (decoded.sourceBytes !== bytes.byteLength) fail('decoded source accounting mismatch')
    if (size > maximumCursorCacheBytes - this.bytes - this.reservedBytes)
      fail('decoded cache byte budget exceeded')
    const asset = owned(decoded)
    flight.reservedBytes = size
    this.reservedBytes += size
    return asset
  }
  private enqueue(source: Uint8Array, flight: Flight): Promise<CursorAsset> {
    let resolve!: DecodeJob['resolve'], reject!: DecodeJob['reject']
    const pending = new Promise<CursorAsset>((yes, no) => { resolve = yes; reject = no })
    // Install shared identity before invoking any potentially reentrant hook.
    flight.decode = pending
    this.decodeQueue.push({ source, flight, resolve, reject })
    this.drain()
    return pending
  }
  private drain(): void {
    if (this.disposed || this.activeDecode) return
    const job = this.decodeQueue.shift()
    if (!job) return
    this.activeDecode = job
    void this.runDecode(job)
  }
  private async runDecode(job: DecodeJob): Promise<void> {
    try {
      this.live()
      if (!this.hasReader(job.flight)) fail('load caller has expired')
      const source = job.source!
      job.source = undefined
      // Bound active format/workspace expansion separately from committed
      // cache bytes. The permit covers ownership copies and reservation too.
      // The decoder must not await another load from this same storage.
      job.resolve(await this.prepare(source, job.flight))
    } catch (error) {
      // A later valid request must never join a flight already known to have
      // failed, even before the old callers' promise continuations unwind.
      this.retire(job.flight)
      job.reject(error)
    }
    finally {
      job.source = undefined
      if (this.activeDecode === job) this.activeDecode = undefined
      // Let this frame and its temporary decoder references unwind first.
      void Promise.resolve().then(() => this.drain())
    }
  }
  private release(name: string, flight: Flight, reader: Reader): void {
    flight.readers.delete(reader)
    if (flight.readers.size) return
    // Failed/disposed flights may already have been replaced at this path.
    if (this.flights.get(name) !== flight) return
    this.retire(flight)
  }
  private retire(flight: Flight): void {
    if (this.flights.get(flight.path) !== flight) return
    this.flights.delete(flight.path)
    this.reservedBytes -= flight.reservedBytes
    this.sourceBytes -= flight.sourceBytes
    flight.reservedBytes = 0
    flight.sourceBytes = 0
  }

  async load(name: string, valid: () => boolean): Promise<number> {
    this.caller(valid)
    const resource = await this.wait(Promise.resolve(this.find(name)))
    this.caller(valid)
    if (!resource) fail('resource not found: ' + name)
    const path = resource.name
    if (typeof path !== 'string' || !path) fail('resource has no resolved path')
    this.caller(valid)
    // Resolve on every assignment, including a cache hit. Deleting a path must
    // still fail; replacing bytes at an existing path preserves its loaded ID.
    const cached = this.entries.get(path)
    if (cached) return cached.id
    if (this.entries.size >= maximumCursorCacheEntries) fail('asset count budget exceeded')
    const flight = this.flights.get(path) ?? this.start(resource, path), reader: Reader = { valid, failed: false }
    flight.readers.add(reader)
    try {
      const source = await this.wait(flight.read)
      this.reader(reader)
      // Each reader owns its own validity. An expired first caller must not
      // cancel a live second caller or trigger needless decode when alone.
      const pending = flight.decode ?? this.enqueue(source, flight)
      let asset: CursorAsset
      try { asset = await this.wait(pending) }
      catch (error) {
        this.live()
        if (reader.failed) throw reader.error
        throw error
      }
      this.reader(reader)
      const committed = this.entries.get(path)
      if (committed) return committed.id
      if (this.entries.size >= maximumCursorCacheEntries) fail('asset count budget exceeded')
      const id = this.nextId
      // Publication is synchronous and must throw before sending on failure.
      // A successfully sent identity is never reused, even if the Layer expires
      // in this callback. External events cannot be rolled back.
      this.publish(id, asset)
      this.nextId++
      if (this.disposed) fail('storage is disposed')
      this.entries.set(path, { id, asset })
      this.ids.set(id, asset)
      this.reservedBytes -= flight.reservedBytes
      flight.reservedBytes = 0
      this.bytes += asset.decodedBytes
      this.reader(reader)
      return id
    } finally { this.release(path, flight, reader) }
  }

  get(id: number): CursorAsset | undefined { return this.ids.get(id) }
  snapshot() {
    return {
      cursorCacheEntries: this.entries.size,
      cursorCacheBytes: this.bytes,
      cursorCachePending: this.flights.size,
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.entries.clear()
    this.ids.clear()
    for (const flight of this.flights.values()) {
      flight.reservedBytes = flight.sourceBytes = 0
      flight.readers.clear()
    }
    this.flights.clear()
    this.bytes = this.reservedBytes = this.sourceBytes = 0
    const stopped = this.disposalError = new Error('Cursor: storage is disposed')
    for (const job of this.decodeQueue.splice(0)) {
      job.source = undefined
      job.reject(stopped)
    }
    // All callers settle even if an external read/decoder has not returned.
    // The active permit remains owned until that actual decoder settles.
    for (const cancel of this.waiters) cancel(stopped)
    this.waiters.clear()
  }
}
