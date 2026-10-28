import type { ImageDecodeSelection } from '../../formats/image/selection.ts'
import type { Resource } from '../ports/storage.ts'
import { ProcessedImageProgress, type ImageLoadProgress } from './image-load-progress.ts'

export const autoImageCacheBytes = 32 * 1024 * 1024
export const maximumImageCacheBytes = 64 * 1024 * 1024
export const maximumProcessedImageEntries = 4096
export const maximumProcessedImagePending = 64

export interface ProcessedImageRequest {
  readonly name: string
  readonly key: number
  readonly mode: ImageDecodeSelection['mode']
  /** Requested dimensions, not the decoder's eventual output dimensions. */
  readonly width: number
  readonly height: number
}
export interface ProcessedImage {
  mode: ImageDecodeSelection['mode']
  width: number
  height: number
  /** RGBA in normal mode; one actual byte per pixel in either other mode. */
  data: Uint8Array
  metadata?: Map<string, string>
  provinceName?: string
}
export interface ProcessedImageObservations {
  observe(requestedName: string, resource?: Resource): void
  readonly progress: ProcessedImageProgress
}
type Processor = (request: ProcessedImageRequest, observations: ProcessedImageObservations) =>
  ProcessedImage | Promise<ProcessedImage>
interface Dependency { requested: string; canonical?: string; alias?: string; token?: object }
interface Entry {
  image: ProcessedImage
  logical: number
  resident: number
  dependencies: Observations
}
interface Flight { promise: Promise<ProcessedImage>; observations: Observations }

function identityName(name: string): string {
  // Case folding here is only a conservative mutation index. Actual cache
  // keys retain the Web resolver's normalized spelling and exact-case identity.
  return name.replaceAll('\\', '/').replace(/^game:\/\/(?:\.\/|\/)/i, '')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}
function basename(name: string): string {
  return name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('>')) + 1)
}

class Observations implements ProcessedImageObservations {
  private readonly records = new Map<string, Dependency>()
  private readonly names = new Set<string>()
  private readonly basenames = new Set<string>()
  private readonly tokens = new Map<string, object>()
  private open = true
  retainable = true
  bytes = 0
  constructor(private readonly tokenFor: (resource: Resource) => object,
    readonly progress: ProcessedImageProgress) {}
  private addName(value: string): void {
    const name = identityName(value), container = name.includes('>') ? name.slice(0, name.indexOf('>')) : undefined
    for (const part of container === undefined ? [name] : [name, container]) {
      if (!this.names.has(part)) { this.names.add(part); this.bytes += part.length * 2 }
      const base = basename(part)
      if (!this.basenames.has(base)) { this.basenames.add(base); this.bytes += base.length * 2 }
    }
  }
  observe(requestedName: string, resource?: Resource): void {
    if (!this.open || !this.retainable) return
    if (typeof requestedName !== 'string' || (resource && typeof resource.name !== 'string'))
      throw new Error('Invalid processed image dependency')
    const canonical = resource?.name, alias = resource?.aliasOf,
      key = JSON.stringify([requestedName, canonical ?? null, alias ?? null]),
      token = resource ? this.tokenFor(resource) : undefined
    if (canonical && token) {
      const previous = this.tokens.get(canonical)
      if (previous && previous !== token) { this.disable(); return }
      if (!previous) { this.tokens.set(canonical, token); this.bytes += canonical.length * 2 + 8 }
    }
    if (this.records.has(key)) return
    // Store only names and an immutable token, never read/source capabilities.
    this.records.set(key, { requested: requestedName, canonical, alias, token })
    this.bytes += (key.length + requestedName.length + (canonical?.length ?? 0) + (alias?.length ?? 0)) * 2
    if (token) this.bytes += 8
    this.addName(requestedName)
    if (canonical) this.addName(canonical)
    if (alias) this.addName(alias)
    // This is a non-retention decision, never a failure of the completed image.
    if (this.bytes > maximumImageCacheBytes) this.disable()
  }
  matches(changed: string): boolean {
    const name = identityName(changed)
    return this.names.has(name) || this.basenames.has(basename(name))
  }
  seal(): void { this.open = false }
  disable(): void {
    this.open = false
    this.retainable = false
    this.records.clear(); this.names.clear(); this.basenames.clear(); this.tokens.clear()
    this.bytes = 0
  }
}

function requestCopy(request: ProcessedImageRequest): ProcessedImageRequest {
  if (!request || typeof request.name !== 'string' ||
      !Number.isInteger(request.key) || request.key < -0x80000000 || request.key > 0xffffffff ||
      !['normal', 'grayscale', 'palettized'].includes(request.mode) ||
      !Number.isInteger(request.width) || !Number.isInteger(request.height) ||
      request.width < 0 || request.height < 0 || request.width > 4096 || request.height > 4096)
    throw new Error('Invalid processed image request')
  return Object.freeze({ name: request.name, key: request.key >>> 0, mode: request.mode,
    width: request.width, height: request.height })
}
function requestKey(request: ProcessedImageRequest): string {
  return JSON.stringify([request.name, request.key | 0, request.mode, request.width, request.height])
}
function payloadBytes(image: ProcessedImage, request: ProcessedImageRequest): number {
  if (!image || image.mode !== request.mode || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
      image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096 ||
      image.width < request.width || image.height < request.height || !(image.data instanceof Uint8Array) ||
      image.data.byteLength !== image.width * image.height * (image.mode === 'normal' ? 4 : 1) ||
      (image.provinceName !== undefined && typeof image.provinceName !== 'string') ||
      (image.metadata !== undefined && !(image.metadata instanceof Map)))
    throw new Error('Invalid processed image')
  let bytes = image.data.byteLength + (image.provinceName?.length ?? 0) * 2
  for (const [key, value] of image.metadata ?? []) {
    if (typeof key !== 'string' || typeof value !== 'string') throw new Error('Invalid processed image metadata')
    bytes += (key.length + value.length) * 2
  }
  return bytes
}
function copy(image: ProcessedImage, ownedData?: Uint8Array): ProcessedImage {
  // Avoid Buffer.slice(), inherited decoder workspaces and unknown extra fields.
  return { mode: image.mode, width: image.width, height: image.height, data: ownedData ?? new Uint8Array(image.data),
    ...(image.metadata ? { metadata: new Map(image.metadata) } : {}),
    ...(image.provinceName !== undefined ? { provinceName: image.provinceName } : {}) }
}

/** Finished native five-key bitmaps. Logical bytes follow native accounting;
 * resident bytes charge owned planes and UTF-16 names/metadata/key/dependencies
 * (plus token references), not V8 RSS or an exact measurement of JS Map overhead. */
export class ProcessedImageCache {
  private readonly entries = new Map<string, Entry>()
  private readonly flights = new Map<string, Flight>()
  private readonly active = new Set<Flight>()
  private readonly identityTokens = new WeakMap<object, object>()
  private generation = 0
  private disposed = false
  private maximum = autoImageCacheBytes
  private logical = 0
  private resident = 0
  private progressResident = 0
  private hits = 0
  private misses = 0
  constructor(private readonly processor: Processor) {}
  get limit(): number { return this.maximum }
  private live(): void { if (this.disposed) throw new Error('Processed image cache is disposed') }
  snapshot() {
    return { imageCacheBytes: this.logical, imageCacheResidentBytes: this.disposed ? 0 : this.resident + this.progressResident,
      imageCacheEntries: this.entries.size, imageCachePending: this.disposed ? 0 : this.active.size,
      imageCacheHits: this.hits, imageCacheMisses: this.misses, imageCacheLimit: this.maximum }
  }
  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.logical -= entry.logical
    this.resident -= entry.resident
  }
  private oldest(): void {
    const key = this.entries.keys().next().value as string | undefined
    if (key !== undefined) this.remove(key)
  }
  private trimSoft(): void {
    while (this.logical > this.maximum && this.entries.size) this.oldest()
  }
  private revoke(detach: boolean): void {
    this.generation++
    for (const flight of this.active) flight.observations.disable()
    if (detach) this.flights.clear()
  }
  setLimit(value: number): void {
    this.live()
    if (!Number.isSafeInteger(value) || value < -1) throw new Error('Invalid graphic cache limit')
    this.maximum = value === -1 ? autoImageCacheBytes : Math.min(value, maximumImageCacheBytes)
    if (this.maximum === 0) this.clear()
    else this.trimSoft()
  }
  clear(): void {
    this.entries.clear(); this.logical = 0; this.resident = 0
    this.revoke(true)
  }
  compact(): void {
    this.entries.clear(); this.logical = 0; this.resident = 0
    this.revoke(false)
  }
  namespaceChanged(): void { this.revoke(true) }
  invalidate(resourceName: string): void {
    for (const [key, entry] of this.entries) if (entry.dependencies.matches(resourceName)) this.remove(key)
    this.revoke(true)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clear()
    for (const flight of this.active) flight.observations.progress.retireReaders()
    // Do not race a synthetic disposed rejection against an in-flight decode:
    // its real failure (notably a late province error) must reach existing owners.
    // New reads are forbidden, and late successful results cannot be retained.
  }
  touch(request: ProcessedImageRequest): void {
    if (this.disposed || !this.maximum) return
    const key = requestKey(requestCopy(request)), entry = this.entries.get(key)
    if (entry) { this.entries.delete(key); this.entries.set(key, entry) }
  }
  private token(resource: Resource): object {
    // Retain an identity representative, not an externally supplied object
    // which could itself capture a Resource or an encoded backing buffer.
    const identity = resource.cacheToken ?? resource
    let token = this.identityTokens.get(identity)
    if (!token) { token = {}; this.identityTokens.set(identity, token) }
    return token
  }
  async read(input: ProcessedImageRequest, progress?: ImageLoadProgress): Promise<ProcessedImage> {
    this.live()
    const request = requestCopy(input), key = requestKey(request), entry = this.maximum ? this.entries.get(key) : undefined
    if (entry) {
      this.hits++
      this.entries.delete(key); this.entries.set(key, entry)
      return copy(entry.image)
    }
    let flight = this.maximum ? this.flights.get(key) : undefined
    if (flight) this.hits++
    else {
      if (this.active.size >= maximumProcessedImagePending) throw new Error('Too many pending processed image loads')
      this.misses++
      const generation = this.generation,
        partial = new ProcessedImageProgress((delta) => {
          if (delta > 0) {
            while (this.entries.size && this.resident + this.progressResident + delta > maximumImageCacheBytes)
              this.oldest()
            if (this.progressResident + delta > maximumImageCacheBytes)
              throw new Error('Pending image progress exceeds 64 MiB budget')
          }
          this.progressResident += delta
        }),
        observations = new Observations((resource) => this.token(resource), partial)
      observations.observe(request.name)
      let retained = false
      const pending: Flight = { observations, promise: undefined! }
      pending.promise = Promise.resolve().then(() => {
        this.live()
        return this.processor(request, observations)
      }).then((result) => {
        this.live()
        const payload = payloadBytes(result, request), transferred = partial.transfer(result)
        // A different processor result has no ownership relationship with the
        // completed progress bitmap. Retire that bitmap before copying output.
        if (!transferred) partial.release()
        const image = copy(result, transferred)
        observations.seal()
        const resident = payload + key.length * 2 + observations.bytes
        if (this.maximum && generation === this.generation && this.flights.get(key) === pending && observations.retainable) {
          // Native checks the old logical total, then inserts without a second
          // soft-limit trim. A hit never trims the resulting one-image overshoot.
          this.trimSoft()
          if (resident <= maximumImageCacheBytes) {
            // The flight's progress bitmap is released in finally. Other live
            // flights remain charged while deciding whether to retain output.
            const otherProgress = this.progressResident - partial.bytes
            while (this.entries.size && (this.resident + resident + otherProgress > maximumImageCacheBytes ||
              this.entries.size >= maximumProcessedImageEntries)) this.oldest()
            if (this.resident + resident + otherProgress <= maximumImageCacheBytes) {
              // No await or external callback occurs across this ownership
              // move. Entry and partial never own two copies of this buffer.
              partial.release()
              this.entries.set(key, { image, logical: image.data.byteLength, resident, dependencies: observations })
              this.logical += image.data.byteLength
              this.resident += resident
              retained = true
            }
          }
        }
        return image
      }).finally(() => {
        partial.release()
        if (!retained) observations.disable()
        this.active.delete(pending)
        if (this.flights.get(key) === pending) this.flights.delete(key)
      })
      this.active.add(pending)
      if (this.maximum) this.flights.set(key, pending)
      flight = pending
    }
    const subscription = progress ? flight.observations.progress.subscribe(progress) : undefined
    try {
      const image = await (subscription ? Promise.race([flight.promise, subscription.failure]) : flight.promise)
      this.live()
      return copy(image)
    } finally { subscription?.remove() }
  }
}
