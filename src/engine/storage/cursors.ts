import type { CursorAsset } from '../../formats/cursor/index.ts'
import type { Resource } from '../ports/storage.ts'

export const maximumCursorSourceBytes = 32 * 1024 * 1024
export const maximumCursorPendingSourceBytes = 64 * 1024 * 1024
export const maximumCursorCacheBytes = 64 * 1024 * 1024
export const maximumCursorCacheEntries = 256

interface Entry { id: number; asset: CursorAsset }
interface Flight {
  readers: number
  read: Promise<Uint8Array>
  decode?: Promise<CursorAsset>
  reservedBytes: number
  sourceBytes: number
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

  constructor(
    private readonly find: (name: string) => Resource | undefined,
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
  private sourceSize(size: number): void {
    if (!Number.isSafeInteger(size) || size <= 0 || size > maximumCursorSourceBytes)
      fail('source byte budget exceeded')
  }
  private start(resource: Resource): Flight {
    this.sourceSize(resource.size)
    if (this.flights.size >= maximumCursorCacheEntries) fail('pending load budget exceeded')
    if (resource.size > maximumCursorPendingSourceBytes - this.sourceBytes)
      fail('pending source byte budget exceeded')
    const flight: Flight = {
      readers: 0,
      reservedBytes: 0,
      sourceBytes: resource.size,
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
      }),
    }
    this.sourceBytes += flight.sourceBytes
    this.flights.set(resource.name, flight)
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
  private release(name: string, flight: Flight): void {
    if (--flight.readers !== 0) return
    // dispose already removed both reservations and flight metadata.
    if (this.flights.get(name) !== flight) return
    this.flights.delete(name)
    this.reservedBytes -= flight.reservedBytes
    this.sourceBytes -= flight.sourceBytes
    flight.reservedBytes = 0
    flight.sourceBytes = 0
  }

  async load(name: string, valid: () => boolean): Promise<number> {
    this.caller(valid)
    const resource = this.find(name)
    if (!resource) fail('resource not found: ' + name)
    const path = resource.name
    if (typeof path !== 'string' || !path) fail('resource has no resolved path')
    this.caller(valid)
    // Resolve on every assignment, including a cache hit. Deleting a path must
    // still fail; replacing bytes at an existing path preserves its loaded ID.
    const cached = this.entries.get(path)
    if (cached) return cached.id
    if (this.entries.size >= maximumCursorCacheEntries) fail('asset count budget exceeded')
    const flight = this.flights.get(path) ?? this.start(resource)
    flight.readers++
    try {
      const source = await flight.read
      this.caller(valid)
      // Each reader owns its own validity. An expired first caller must not
      // cancel a live second caller or trigger needless decode when alone.
      flight.decode ??= this.prepare(source, flight)
      const asset = await flight.decode
      this.caller(valid)
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
      this.caller(valid)
      return id
    } finally { this.release(path, flight) }
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
    this.disposed = true
    this.entries.clear()
    this.ids.clear()
    for (const flight of this.flights.values()) flight.reservedBytes = flight.sourceBytes = 0
    this.flights.clear()
    this.bytes = this.reservedBytes = this.sourceBytes = 0
  }
}
