import type { DecodedImage } from '../ports/graphics.ts'
import type { Resource } from '../ports/storage.ts'
import type { ImageDecodeSelection } from '../../formats/image/selection.ts'
import { ProcessedImageCache, type ProcessedImage, type ProcessedImageObservations, type ProcessedImageRequest } from './processed-image-cache.ts'
import { expandRule, planeImage, tileImage } from './processed-image.ts'
import { decodedImageBytes } from './image-cache.ts'
import { TvpError } from '../system/tvp-error.ts'
import {
  applyImageKey,
  applyImageMask,
  matteImage,
  noColorKey,
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
  private readonly cache: ProcessedImageCache
  constructor(
    private readonly find: (name: string) => Resource | undefined | Promise<Resource | undefined>,
    private readonly decode: (bytes: Uint8Array, selection: ImageDecodeSelection) => Promise<DecodedImage>,
    private readonly finish: <T>(work: Generator<void, T>) => Promise<T>,
    private readonly scheduler: ImageScheduler,
    private readonly normalize: (name: string) => string = (name) => name,
  ) {
    this.cache = new ProcessedImageCache((request, observations) => this.process(request, observations))
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
  /** Search changes keep completed native cache hits; in-flight publication is revoked. */
  namespaceChanged(): void { this.cache.namespaceChanged() }
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
    const start = this.scheduler.now()
    let yieldAt = start + 8, bytes = 0, attempted = 0
    try {
      while (attempted < names.length) {
        this.scheduler.check()
        if (bytes >= limit || (timeout && this.scheduler.now() - start >= timeout)) break
        const name = names[attempted++]!
        try {
          // TVPLoadGraphic always discovers the province name internally,
          // including when TouchImages supplies a null output pointer. Only
          // Layer's later province load reads/decodes its pixels.
          const image = await this.read(this.request(name, noColorKey, 'normal'))
          // Count every successful result, including repeated cache hits.
          // Mask/province/metadata buffers are not separate preload charges.
          bytes += image.width * image.height * 4
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
      // Native re-touches the attempted prefix, including failures/duplicates.
      // This never performs I/O or resurrects entries evicted during the pass.
      while (attempted > 0) {
        this.scheduler.check()
        this.cache.touch(this.request(names[--attempted]!, noColorKey, 'normal'))
      }
    }
  }
  private extension(name: string): string {
    const base = name.split(/[/\\>]/).at(-1)!,
      index = base.lastIndexOf('.')
    return index < 0 ? '' : base.slice(index).replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  }
  private async lookup(name: string, observations?: ProcessedImageObservations): Promise<Resource | undefined> {
    this.scheduler.check()
    const resource = await this.find(name)
    this.scheduler.check()
    observations?.observe(name, resource)
    return resource
  }
  private async findSelected(name: string, observations?: ProcessedImageObservations): Promise<SelectedImage | undefined> {
    const ext = this.extension(name)
    if (ext) {
      const format = handlers[ext]
      // Selection precedes storage lookup: a valid image with an unknown
      // suffix must not be opened or offered to a sniffing decoder.
      if (!format) throw new TvpError('TVPUnknownGraphicFormat', [name], `Unknown image format: ${name}`)
      const resource = await this.lookup(name, observations)
      return resource ? { resource, format, requestedName: name } : undefined
    }
    for (const extension of imageExtensions) {
      const resource = await this.lookup(name + extension, observations)
      if (resource) return { resource, format: handlers[extension]!, requestedName: name + extension }
    }
    return undefined
  }
  async findImage(name: string): Promise<Resource | undefined> {
    return (await this.findSelected(this.normalize(name)))?.resource
  }
  private async resolveSelected(name: string, observations?: ProcessedImageObservations): Promise<SelectedImage> {
    const selected = await this.findSelected(name, observations)
    if (!selected) throw new TvpError(this.extension(name) ? 'TVPCannotOpenStorage' : 'TVPCannotSuggestGraphicExtension',
      [name], `Image resource not found: ${name}`)
    return selected
  }
  async resolve(name: string): Promise<Resource> {
    return (await this.resolveSelected(this.normalize(name))).resource
  }
  private async companion(name: string, suffix: string, preferExtension: boolean, observations: ProcessedImageObservations): Promise<SelectedImage | undefined> {
    const ext = this.extension(name),
      stem = ext ? name.slice(0, -ext.length) : name
    if (ext && preferExtension) {
      const resource = await this.lookup(stem + suffix + ext, observations)
      if (resource) return { resource, format: handlers[ext]!, requestedName: stem + suffix + ext }
    }
    // Companions use registered extensions, and can come from later auto paths.
    for (const extension of imageExtensions) {
      const resource = await this.lookup(stem + suffix + extension, observations)
      if (resource) return { resource, format: handlers[extension]!, requestedName: stem + suffix + extension }
    }
    return undefined
  }
  private request(name: string, key: number, mode: ImageDecodeSelection['mode'], width = 0, height = 0): ProcessedImageRequest {
    return { name: this.normalize(name), key, mode, width, height }
  }
  private async read(request: ProcessedImageRequest): Promise<ProcessedImage> {
    this.scheduler.check()
    const image = await this.cache.read(request)
    this.scheduler.check()
    return image
  }
  private async decodeSelected(selected: SelectedImage, mode: ImageDecodeSelection['mode']): Promise<DecodedImage> {
    this.scheduler.check()
    const bytes = await selected.resource.read()
    this.scheduler.check()
    const image = await this.decode(bytes, { format: selected.format, mode })
    this.scheduler.check()
    decodedImageBytes(image)
    return image
  }
  private async process(request: ProcessedImageRequest, observations: ProcessedImageObservations): Promise<ProcessedImage> {
    const selected = await this.resolveSelected(request.name, observations),
      decoded = await this.decodeSelected(selected, request.mode)
    if (request.mode !== 'normal')
      return this.finish(planeImage(decoded, request.mode, request.width, request.height))
    const image = request.width || request.height
      ? await this.finish(tileImage(decoded, request.width, request.height)) : decoded
    await this.finish(applyImageKey(image, request.key))
    const province = await this.companion(request.name, '_p', false, observations),
      mask = await this.companion(request.name, '_m', true, observations)
    if (mask) {
      const decodedMask = await this.decodeSelected(mask, 'grayscale'),
        maskImage = request.width || request.height
          ? await this.finish(tileImage(decodedMask, request.width, request.height)) : decodedMask
      await this.finish(applyImageMask(image, maskImage))
    }
    await this.finish(matteImage(image, request.key))
    // Source indices are only needed while applying the key. Native retains
    // the finished 32-bit bitmap and province name, never a separate mask.
    return { mode: 'normal', width: image.width, height: image.height, data: image.data,
      ...(image.metadata ? { metadata: image.metadata } : {}),
      ...(province ? { provinceName: province.requestedName } : {}) }
  }
  async rule(name: string, width = 0, height = 0): Promise<DecodedImage> {
    return this.finish(expandRule(await this.read(this.request(name, 0x02ffffff, 'grayscale', width, height))))
  }
  private async provincePlane(request: ProcessedImageRequest, diagnosticName: string): Promise<Uint8Array> {
    const plane = await this.read(request)
    if (plane.width !== request.width || plane.height !== request.height)
      throw new TvpError('TVPProvinceSizeMismatch', [diagnosticName], 'Province image size mismatch')
    return plane.data
  }
  async load(name: string, key: number): Promise<LoadedImage> {
    validateColorKey(key)
    const processed = await this.read(this.request(name, key, 'normal')),
      image: DecodedImage = { width: processed.width, height: processed.height, data: processed.data,
        ...(processed.metadata ? { metadata: processed.metadata } : {}) }
    if (!processed.provinceName) return { image }
    try {
      return {
        image,
        province: await this.provincePlane({ name: processed.provinceName, key: 0, mode: 'palettized',
          width: image.width, height: image.height }, processed.provinceName),
      }
    } catch (cause) {
      throw new ProvinceImageLoadError(image, cause)
    }
  }
  async province(name: string, width: number, height: number): Promise<Uint8Array> {
    // Layer.LoadProvinceImage reports its original argument after loading;
    // automatic companions instead report the normalized discovered name.
    return this.provincePlane(this.request(name, 0, 'palettized', width, height), name)
  }
}
