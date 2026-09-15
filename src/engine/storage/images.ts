import type { DecodedImage } from '../ports/graphics.ts'
import type { Resource } from '../ports/storage.ts'
import { ImageCache, type PreloadBudget } from './image-cache.ts'
import {
  applyImageKey,
  applyImageMask,
  matteImage,
  provincePixels,
  validateColorKey,
} from '../graphics/loading.ts'

export const imageExtensions = [
  '.png',
  '.jpg',
  '.jpeg',
  '.bmp',
  '.webp',
  '.gif',
  '.tlg',
  '.tlg5',
  '.tlg6',
]
export interface LoadedImage {
  image: DecodedImage
  province?: Uint8Array
}
/** The main image finished loading before its optional province companion failed. */
export class ProvinceImageLoadError extends Error {
  constructor(
    readonly image: DecodedImage,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ProvinceImageLoadError'
  }
}
interface ImageScheduler {
  now(): number
  check(): void
  yield(): Promise<void>
}

export class ImageLoader {
  private readonly cache: ImageCache
  constructor(
    private readonly find: (name: string) => Resource | undefined,
    decode: (bytes: Uint8Array) => Promise<DecodedImage>,
    private readonly finish: <T>(work: Generator<void, T>) => Promise<T>,
    private readonly scheduler: ImageScheduler,
  ) {
    this.cache = new ImageCache(async (resource) => decode(await resource.read()))
  }
  get limit(): number {
    return this.cache.limit
  }
  setLimit(value: number): void {
    this.cache.setLimit(value)
  }
  clear(): void {
    this.cache.clear()
  }
  invalidate(name: string): void {
    this.cache.invalidate(name)
  }
  dispose(): void {
    this.cache.dispose()
  }
  snapshot() {
    return this.cache.snapshot()
  }
  async touch(names: string[], limitBytes = 0, timeout = 0): Promise<void> {
    if (names.length > 4096 || names.some((name) => typeof name !== 'string'))
      throw new Error('Invalid image preload list')
    if (!Number.isSafeInteger(limitBytes) || !Number.isSafeInteger(timeout) || timeout < 0)
      throw new Error('Invalid image preload limit or timeout')
    const capacity = this.cache.limit,
      limit = limitBytes <= 0 ? capacity + limitBytes : Math.min(capacity, limitBytes)
    if (!capacity || limit <= 0) return
    const budget: PreloadBudget = { remaining: limit, protected: new Map() },
      start = this.scheduler.now()
    let yieldAt = start + 8
    try {
      for (const name of names) {
        this.scheduler.check()
        if (!budget.remaining || (timeout && this.scheduler.now() - start >= timeout)) break
        try {
          await this.cache.warm(this.resolve(name), budget)
          for (const [suffix, prefer] of [
            ['_m', true],
            ['_p', false],
          ] as const) {
            if (!budget.remaining) break
            const resource = this.companion(name, suffix, prefer)
            if (resource) await this.cache.warm(resource, budget)
          }
        } catch {
          // Loading errors are ignored by touchImages; cancellation must still unwind the VM.
          this.scheduler.check()
        }
        if (this.scheduler.now() >= yieldAt) {
          await this.scheduler.yield()
          yieldAt = this.scheduler.now() + 8
        }
      }
    } finally {
      // The front of the caller's list survives subsequent LRU pressure longest.
      for (const [name, token] of [...budget.protected].reverse()) this.cache.touch(name, token)
    }
  }
  private extension(name: string): string {
    const base = name.split(/[/\\>]/).at(-1)!,
      index = base.lastIndexOf('.')
    return index < 0 ? '' : base.slice(index)
  }
  findImage(name: string): Resource | undefined {
    const exact = this.find(name)
    if (exact) return exact
    if (!this.extension(name))
      for (const ext of imageExtensions) {
        const resource = this.find(name + ext)
        if (resource) return resource
      }
    return undefined
  }
  resolve(name: string): Resource {
    const resource = this.findImage(name)
    if (!resource) throw new Error(`Image resource not found: ${name}`)
    return resource
  }
  private companion(name: string, suffix: string, preferExtension: boolean): Resource | undefined {
    const ext = this.extension(name),
      stem = ext ? name.slice(0, -ext.length) : name
    if (ext && preferExtension) {
      const same = this.find(stem + suffix + ext)
      if (same) return same
    }
    // Companions use registered extensions, and can come from later auto paths.
    for (const extension of imageExtensions) {
      const resource = this.find(stem + suffix + extension)
      if (resource) return resource
    }
    return undefined
  }
  async rule(name: string): Promise<DecodedImage> {
    return this.cache.read(this.resolve(name))
  }
  async load(name: string, key: number): Promise<LoadedImage> {
    validateColorKey(key)
    const image = await this.rule(name)
    await this.finish(applyImageKey(image, key))
    const mask = this.companion(name, '_m', true)
    if (mask) await this.finish(applyImageMask(image, await this.cache.read(mask)))
    await this.finish(matteImage(image, key))
    const province = this.companion(name, '_p', false)
    if (!province) return { image }
    try {
      return {
        image,
        province: await this.finish(
          provincePixels(await this.cache.read(province), image.width, image.height),
        ),
      }
    } catch (cause) {
      throw new ProvinceImageLoadError(image, cause)
    }
  }
  async province(name: string, width: number, height: number): Promise<Uint8Array> {
    return this.finish(provincePixels(await this.rule(name), width, height))
  }
}
