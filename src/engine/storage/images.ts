import type { DecodedImage } from '../ports/graphics.ts'
import type { Resource } from '../ports/storage.ts'
import type { ImageDecodeProgress, ImageDecodeSelection } from '../../formats/image/selection.ts'
import { ProcessedImageCache, type ProcessedImage, type ProcessedImageObservations, type ProcessedImageRequest } from './processed-image-cache.ts'
import { expandRule, planeImage, tileImage } from './processed-image.ts'
import { decodedImageBytes } from './image-cache.ts'
import { TvpError } from '../system/tvp-error.ts'
import type { ImageLoadProgress } from './image-load-progress.ts'
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
export interface ImageLoadDestination extends ImageLoadProgress {
  /** Normal processing/cache lookup completed; precedes province loading. */
  main(image: DecodedImage): void
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
  /** A paused session may finish private I/O but must wait before publication. */
  wait?(): void | Promise<void>
}

export class ImageLoader {
  private readonly cache: ProcessedImageCache
  constructor(
    private readonly find: (name: string) => Resource | undefined | Promise<Resource | undefined>,
    private readonly decode: (bytes: Uint8Array, selection: ImageDecodeSelection, progress?: ImageDecodeProgress) => Promise<DecodedImage>,
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
  private async read(request: ProcessedImageRequest, progress?: ImageLoadProgress): Promise<ProcessedImage> {
    let waiting = this.scheduler.wait?.()
    if (waiting) await waiting
    this.scheduler.check()
    const image = await this.cache.read(request, progress)
    waiting = this.scheduler.wait?.()
    if (waiting) await waiting
    this.scheduler.check()
    return image
  }
  private async decodeSelected(selected: SelectedImage, mode: ImageDecodeSelection['mode'], progress?: ImageDecodeProgress): Promise<DecodedImage> {
    this.scheduler.check()
    const bytes = await selected.resource.read()
    let waiting = this.scheduler.wait?.()
    if (waiting) await waiting
    this.scheduler.check()
    let sized = false
    const observer: ImageDecodeProgress | undefined = progress ? {
      size: (width, height) => { this.scheduler.check(); progress.size(width, height); sized = true },
      row: (y, rgba, indices) => { this.scheduler.check(); progress.row(y, rgba, indices) },
    } : undefined
    const image = await this.decode(bytes, { format: selected.format, mode }, observer)
    waiting = this.scheduler.wait?.()
    if (waiting) await waiting
    this.scheduler.check()
    decodedImageBytes(image)
    // Embedding decoders may only expose a complete image. They cannot claim
    // native partial rows on failure, but successful output still uses the
    // same size/row destination path as portable selected handlers.
    if (progress && !sized) {
      observer!.size(image.width, image.height)
      for (let y = 0; y < image.height; y++) observer!.row(y,
        image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
        image.indices?.subarray(y * image.width, (y + 1) * image.width))
    }
    return image
  }
  private progress(request: ProcessedImageRequest, observations: ProcessedImageObservations, mask = false): ImageDecodeProgress {
    let sourceWidth = 0, sourceHeight = 0
    return {
      size: (width, height) => {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096)
          throw new Error('Invalid image progress dimensions')
        const w = Math.max(width, request.width), h = Math.max(height, request.height)
        sourceWidth = width; sourceHeight = height
        if (mask) {
          const image = observations.progress.image
          if (!image || image.width !== w || image.height !== h)
            throw new TvpError('TVPMaskSizeMismatch', [], 'Companion mask size mismatch')
        } else observations.progress.size(w, h)
      },
      row: (y, rgba, indices) => {
        if (!sourceWidth || !Number.isInteger(y) || y < 0 || y >= sourceHeight || rgba.length !== sourceWidth * 4 ||
            (indices && indices.length !== sourceWidth)) throw new Error('Invalid decoded image row')
        const image = observations.progress.image!, row = new Uint8Array(image.width * 4)
        for (let targetY = y; targetY < image.height; targetY += sourceHeight) {
          if (mask) row.set(image.data.subarray(targetY * image.width * 4, (targetY + 1) * image.width * 4))
          for (let x = 0; x < image.width; x++) {
            const sourceX = x % sourceWidth, from = sourceX * 4, to = x * 4
            if (mask) row[to + 3] = (54 * rgba[from]! + 183 * rgba[from + 1]! + 19 * rgba[from + 2]!) >>> 8
            else {
              row[to] = rgba[from]!
              row[to + 1] = rgba[from + 1]!
              row[to + 2] = rgba[from + 2]!
              row[to + 3] = rgba[from + 3]!
              if (request.key >>> 24 === 0)
                row[to + 3] = ((row[to]! << 16) | (row[to + 1]! << 8) | row[to + 2]!) === request.key ? 0 : 255
              else if (request.key >>> 24 === 3 && indices)
                row[to + 3] = indices[sourceX] === (request.key & 255) ? 0 : 255
            }
          }
          observations.progress.row(targetY, row)
        }
      },
    }
  }
  private async process(request: ProcessedImageRequest, observations: ProcessedImageObservations): Promise<ProcessedImage> {
    const selected = await this.resolveSelected(request.name, observations),
      decoded = await this.decodeSelected(selected, request.mode,
        request.mode === 'normal' ? this.progress(request, observations) : undefined)
    if (request.mode !== 'normal')
      return this.finish(planeImage(decoded, request.mode, request.width, request.height))
    const image: DecodedImage = { ...observations.progress.image!,
      ...(decoded.metadata ? { metadata: decoded.metadata } : {}) }
    // RGB/palette keys already apply at each completed row. Adaptive keying
    // starts only after the selected handler has completed, including its tail.
    await this.finish(observations.progress.finish(applyImageKey(image,
      request.key === 0x01ffffff ? request.key : noColorKey)))
    const province = await this.companion(request.name, '_p', false, observations),
      mask = await this.companion(request.name, '_m', true, observations)
    if (mask) {
      const decodedMask = await this.decodeSelected(mask, 'grayscale', this.progress(request, observations, true)),
        maskImage = request.width || request.height
          ? await this.finish(tileImage(decodedMask, request.width, request.height)) : decodedMask
      await this.finish(observations.progress.finish(applyImageMask(image, maskImage)))
    }
    await this.finish(observations.progress.finish(matteImage(image, request.key)))
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
  async load(name: string, key: number, destination?: ImageLoadDestination): Promise<LoadedImage> {
    validateColorKey(key)
    const processed = await this.read(this.request(name, key, 'normal'), destination),
      image: DecodedImage = { width: processed.width, height: processed.height, data: processed.data,
        ...(processed.metadata ? { metadata: processed.metadata } : {}) }
    const waiting = this.scheduler.wait?.()
    if (waiting) await waiting
    this.scheduler.check()
    destination?.main(image)
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
