import type { DecodedImage } from '../ports/graphics.ts'
import type { Resource } from '../ports/storage.ts'
import type { ImageDecodeSelection } from '../../formats/image/selection.ts'
import { ImageCache, type PreloadBudget } from './image-cache.ts'
import { TvpError } from '../system/tvp-error.ts'
import {
  applyImageKey,
  applyImageMask,
  matteImage,
  noColorKey,
  provincePixels,
  validateColorKey,
} from '../graphics/loading.ts'

export const imageExtensions = [
  '.tlg6',
  '.tlg5',
  '.tlg',
  '.eri',
  '.png',
  '.jif',
  '.jpg',
  '.jpeg',
  '.dib',
  '.bmp',
] as const
const handlers: Readonly<Record<string, ImageDecodeSelection['format']>> = {
  '.bmp': 'bmp', '.dib': 'bmp', '.jpeg': 'jpeg', '.jpg': 'jpeg', '.jif': 'jpeg',
  '.png': 'png', '.eri': 'eri', '.tlg': 'tlg', '.tlg5': 'tlg', '.tlg6': 'tlg',
}
interface SelectedImage {
  resource: Resource
  format: ImageDecodeSelection['format']
  requestedName: string
}
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
    private readonly find: (name: string) => Resource | undefined | Promise<Resource | undefined>,
    decode: (bytes: Uint8Array, selection: ImageDecodeSelection) => Promise<DecodedImage>,
    private readonly finish: <T>(work: Generator<void, T>) => Promise<T>,
    private readonly scheduler: ImageScheduler,
    private readonly normalize: (name: string) => string = (name) => name,
  ) {
    this.cache = new ImageCache(async (resource, selection) => {
      if (!selection) throw new Error('Image decode selection is required')
      this.scheduler.check()
      const bytes = await resource.read()
      this.scheduler.check()
      return decode(bytes, selection)
    })
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
  compact(): void { this.cache.compact() }
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
          // TVPLoadGraphic always discovers the province name internally,
          // including when TouchImages supplies a null output pointer. Only
          // Layer's later province load reads/decodes its pixels.
          await this.normal(this.normalize(name), noColorKey, budget)
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
    return index < 0 ? '' : base.slice(index).replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  }
  private async lookup(name: string): Promise<Resource | undefined> {
    this.scheduler.check()
    const resource = await this.find(name)
    this.scheduler.check()
    return resource
  }
  private async findSelected(name: string): Promise<SelectedImage | undefined> {
    const ext = this.extension(name)
    if (ext) {
      const format = handlers[ext]
      // Selection precedes storage lookup: a valid image with an unknown
      // suffix must not be opened or offered to a sniffing decoder.
      if (!format) throw new TvpError('TVPUnknownGraphicFormat', [name], `Unknown image format: ${name}`)
      const resource = await this.lookup(name)
      return resource ? { resource, format, requestedName: name } : undefined
    }
    for (const extension of imageExtensions) {
      const resource = await this.lookup(name + extension)
      if (resource) return { resource, format: handlers[extension]!, requestedName: name + extension }
    }
    return undefined
  }
  async findImage(name: string): Promise<Resource | undefined> {
    return (await this.findSelected(this.normalize(name)))?.resource
  }
  private async resolveSelected(name: string): Promise<SelectedImage> {
    const selected = await this.findSelected(name)
    if (!selected) throw new TvpError(this.extension(name) ? 'TVPCannotOpenStorage' : 'TVPCannotSuggestGraphicExtension',
      [name], `Image resource not found: ${name}`)
    return selected
  }
  async resolve(name: string): Promise<Resource> {
    return (await this.resolveSelected(this.normalize(name))).resource
  }
  private async companion(name: string, suffix: string, preferExtension: boolean): Promise<SelectedImage | undefined> {
    const ext = this.extension(name),
      stem = ext ? name.slice(0, -ext.length) : name
    if (ext && preferExtension) {
      const resource = await this.lookup(stem + suffix + ext)
      if (resource) return { resource, format: handlers[ext]!, requestedName: stem + suffix + ext }
    }
    // Companions use registered extensions, and can come from later auto paths.
    for (const extension of imageExtensions) {
      const resource = await this.lookup(stem + suffix + extension)
      if (resource) return { resource, format: handlers[extension]!, requestedName: stem + suffix + extension }
    }
    return undefined
  }
  private async read(selected: SelectedImage, mode: ImageDecodeSelection['mode'], budget?: PreloadBudget): Promise<DecodedImage> {
    this.scheduler.check()
    const image = await this.cache.read(selected.resource, { format: selected.format, mode }, budget)
    this.scheduler.check()
    return image
  }
  async rule(name: string): Promise<DecodedImage> {
    return this.read(await this.resolveSelected(this.normalize(name)), 'grayscale')
  }
  private async normal(name: string, key: number, budget?: PreloadBudget): Promise<{ image: DecodedImage; province?: SelectedImage }> {
    const image = await this.read(await this.resolveSelected(name), 'normal', budget)
    await this.finish(applyImageKey(image, key))
    const province = await this.companion(name, '_p', false)
    const mask = await this.companion(name, '_m', true)
    if (mask) await this.finish(applyImageMask(image, await this.read(mask, 'grayscale', budget)))
    await this.finish(matteImage(image, key))
    return { image, province }
  }
  async load(name: string, key: number): Promise<LoadedImage> {
    validateColorKey(key)
    const { image, province } = await this.normal(this.normalize(name), key)
    if (!province) return { image }
    try {
      return {
        image,
        province: await this.finish(
          provincePixels(await this.read(province, 'palettized'), image.width, image.height, province.requestedName),
        ),
      }
    } catch (cause) {
      throw new ProvinceImageLoadError(image, cause)
    }
  }
  async province(name: string, width: number, height: number): Promise<Uint8Array> {
    const selected = await this.resolveSelected(this.normalize(name))
    // Layer.LoadProvinceImage reports its original argument after loading;
    // automatic companions instead report the normalized discovered name.
    return this.finish(provincePixels(await this.read(selected, 'palettized'), width, height, name))
  }
}
