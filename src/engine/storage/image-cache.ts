import type { DecodedImage } from '../ports/graphics.ts'
import type { Resource } from '../ports/storage.ts'

export const autoImageCacheBytes = 32 * 1024 * 1024
export const maximumImageCacheBytes = 64 * 1024 * 1024
interface Entry {
  token: object
  image: DecodedImage
  bytes: number
}
interface Flight {
  token: object
  promise: Promise<DecodedImage>
}
export interface PreloadBudget {
  remaining: number
  protected: Map<string, object>
}
export function decodedImageBytes(image: DecodedImage): number {
  const pixels = image.width * image.height
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width > 4096 ||
    image.height > 4096 ||
    image.data.length !== pixels * 4 ||
    (image.indices && image.indices.length !== pixels)
  )
    throw new Error('Invalid decoded image')
  let bytes = image.data.byteLength + (image.indices?.byteLength ?? 0)
  for (const [key, value] of image.metadata ?? []) bytes += (key.length + value.length) * 2
  return bytes
}
function copy(image: DecodedImage): DecodedImage {
  return {
    ...image,
    data: image.data.slice(),
    ...(image.indices ? { indices: image.indices.slice() } : {}),
    ...(image.metadata ? { metadata: new Map(image.metadata) } : {}),
  }
}

/** Cache only source pixels; callers receive isolated buffers before applying load options. */
export class ImageCache {
  private readonly entries = new Map<string, Entry>()
  private readonly flights = new Map<string, Flight>()
  private bytes = 0
  private epoch = 0
  private disposed = false
  private maximum = autoImageCacheBytes
  private hits = 0
  private misses = 0
  constructor(private readonly decode: (resource: Resource) => Promise<DecodedImage>) {}
  get limit(): number {
    return this.maximum
  }
  setLimit(value: number): void {
    if (!Number.isSafeInteger(value) || value < -1) throw new Error('Invalid graphic cache limit')
    this.maximum = value === -1 ? autoImageCacheBytes : Math.min(value, maximumImageCacheBytes)
    if (!this.maximum) this.clear()
    else this.trim(0, undefined, 0)
  }
  snapshot() {
    return {
      imageCacheBytes: this.bytes,
      imageCacheEntries: this.entries.size,
      imageCachePending: this.flights.size,
      imageCacheHits: this.hits,
      imageCacheMisses: this.misses,
      imageCacheLimit: this.maximum,
    }
  }
  private remove(name: string): void {
    const entry = this.entries.get(name)
    if (entry) {
      this.bytes -= entry.bytes
      this.entries.delete(name)
    }
  }
  clear(): void {
    this.entries.clear()
    this.flights.clear()
    this.bytes = 0
    this.epoch++
  }
  invalidate(name: string): void {
    this.remove(name)
    this.flights.delete(name)
    this.epoch++
  }
  dispose(): void {
    this.disposed = true
    this.clear()
  }
  private trim(extra: number, protectedEntries?: Map<string, object>, extraEntries = 1): boolean {
    for (const [name, entry] of this.entries) {
      if (this.bytes + extra <= this.maximum && this.entries.size + extraEntries <= 4096)
        return true
      if (protectedEntries?.get(name) !== entry.token) this.remove(name)
    }
    return this.bytes + extra <= this.maximum && this.entries.size + extraEntries <= 4096
  }
  touch(name: string, token: object): void {
    const entry = this.entries.get(name)
    if (entry?.token === token) {
      this.entries.delete(name)
      this.entries.set(name, entry)
    }
  }
  private async base(resource: Resource, budget?: PreloadBudget): Promise<DecodedImage> {
    if (this.disposed) throw new Error('Image cache is disposed')
    const { name } = resource,
      token = resource.cacheToken ?? resource,
      entry = this.entries.get(name)
    if (entry?.token === token) {
      this.hits++
      this.touch(name, token)
      this.charge(name, token, entry.bytes, budget)
      return entry.image
    }
    if (entry) this.remove(name)
    if (!this.maximum) {
      this.misses++
      const image = await this.decode(resource)
      if (this.disposed) throw new Error('Image cache is disposed')
      decodedImageBytes(image)
      return image
    }
    let flight = this.flights.get(name)
    if (flight?.token === token) this.hits++
    else {
      if (this.flights.size >= 64) throw new Error('Too many pending image loads')
      this.misses++
      const epoch = this.epoch
      const pending: Flight = {
        token,
        promise: Promise.resolve()
          .then(() => this.decode(resource))
          .then((image) => {
            if (this.disposed) throw new Error('Image cache is disposed')
            const size = decodedImageBytes(image)
            if (
              epoch === this.epoch &&
              this.flights.get(name) === pending &&
              size <= this.maximum &&
              (!budget || size <= budget.remaining) &&
              this.trim(size, budget?.protected)
            ) {
              // A decoder may return a view into a larger workspace. Retain only the charged payload.
              const stored = {
                ...image,
                data:
                  image.data.byteLength === image.data.buffer.byteLength
                    ? image.data
                    : image.data.slice(),
                ...(image.indices
                  ? {
                      indices:
                        image.indices.byteLength === image.indices.buffer.byteLength
                          ? image.indices
                          : image.indices.slice(),
                    }
                  : {}),
              }
              this.remove(name)
              this.entries.set(name, { token, image: stored, bytes: size })
              this.bytes += size
            }
            return image
          })
          .finally(() => {
            if (this.flights.get(name) === pending) this.flights.delete(name)
          }),
      }
      this.flights.set(name, pending)
      flight = pending
    }
    const image = await flight.promise
    this.charge(name, token, decodedImageBytes(image), budget)
    return image
  }
  private charge(name: string, token: object, size: number, budget?: PreloadBudget): void {
    if (!budget || budget.protected.get(name) === token) return
    budget.remaining = Math.max(0, budget.remaining - size)
    budget.protected.set(name, token)
  }
  async read(resource: Resource): Promise<DecodedImage> {
    const cached = this.maximum > 0,
      image = await this.base(resource)
    return cached ? copy(image) : image
  }
  async warm(resource: Resource, budget: PreloadBudget): Promise<void> {
    await this.base(resource, budget)
  }
}
