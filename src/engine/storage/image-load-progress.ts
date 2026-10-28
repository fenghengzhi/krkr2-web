import type { Pixels } from '../ports/graphics.ts'

/** Synchronous borrowed rows. A receiver must copy any bytes it retains. */
export interface ImageLoadProgress {
  size(width: number, height: number): void
  row(y: number, rgba: Uint8Array): void
}
interface Reader {
  sink: ImageLoadProgress
  reject(error: unknown): void
}

/** One bounded current bitmap per processed flight, never a history of rows.
 * Native Recreate allocates even at the same size. Its uninitialized pixels are
 * deliberately represented by safe zeroes in the Web implementation. */
export class ProcessedImageProgress implements ImageLoadProgress {
  private current?: Pixels
  private closed = false
  private readonly readers = new Set<Reader>()
  constructor(private readonly reserve: (delta: number) => void) {}
  get image(): Pixels | undefined { return this.closed ? undefined : this.current }
  get bytes(): number { return this.current?.data.byteLength ?? 0 }
  private deliver(reader: Reader, operation: () => void): void {
    if (!this.readers.has(reader)) return
    try { operation() }
    catch (error) { this.readers.delete(reader); reader.reject(error) }
  }
  size(width: number, height: number): void {
    if (this.closed) throw new Error('Image progress is closed')
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || height < 1 || width > 4096 || height > 4096)
      throw new Error('Invalid image progress dimensions')
    const bytes = width * height * 4, delta = bytes - (this.current?.data.byteLength ?? 0)
    this.reserve(delta)
    try { this.current = { width, height, data: new Uint8Array(bytes) } }
    catch (error) { this.reserve(-delta); throw error }
    for (const reader of [...this.readers]) this.deliver(reader, () => reader.sink.size(width, height))
  }
  row(y: number, rgba: Uint8Array): void {
    if (this.closed) throw new Error('Image progress is closed')
    const image = this.current
    if (!image || !Number.isInteger(y) || y < 0 || y >= image.height || rgba.length !== image.width * 4)
      throw new Error('Invalid image progress row')
    image.data.set(rgba, y * image.width * 4)
    this.publish(y)
  }
  publish(y: number): void {
    const image = this.current!
    for (const reader of [...this.readers]) this.deliver(reader, () => {
      // A consumer cannot mutate the flight or another consumer's row.
      reader.sink.row(y, image.data.slice(y * image.width * 4, (y + 1) * image.width * 4))
    })
  }
  /** Image key/mask/matte generators advance 4096 linear pixels per yield.
   * Publish that span before yielding, including its possibly partial last row,
   * so an existing reader and a joining reader observe the same current pixels. */
  *finish<T>(work: Generator<void, T>): Generator<void, T> {
    let pixels = 0
    try {
      while (true) {
        const step = work.next()
        if (step.done) return step.value
        const image = this.current!
        for (let y = Math.floor(pixels / image.width); y < Math.min(image.height, Math.ceil((pixels + 4096) / image.width)); y++)
          this.publish(y)
        pixels += 4096
        yield
      }
    } finally {
      work.return(undefined as T)
      if (this.current) for (let y = Math.floor(pixels / this.current.width); y < this.current.height; y++) this.publish(y)
    }
  }
  subscribe(sink: ImageLoadProgress): { failure: Promise<never>; remove(): void } {
    let reject!: (error: unknown) => void
    const failure = new Promise<never>((_resolve, no) => { reject = no }), reader = { sink, reject }
    // Replay may reject synchronously, before the caller installs its race.
    void failure.catch(() => {})
    this.readers.add(reader)
    const image = this.closed ? undefined : this.current
    if (image) this.deliver(reader, () => {
      sink.size(image.width, image.height)
      for (let y = 0; y < image.height && this.readers.has(reader); y++)
        sink.row(y, image.data.slice(y * image.width * 4, (y + 1) * image.width * 4))
    })
    return { failure, remove: () => { this.readers.delete(reader) } }
  }
  release(): void {
    if (this.current) this.reserve(-this.current.data.byteLength)
    this.current = undefined
    this.closed = true
    this.readers.clear()
  }
  retireReaders(): void { this.readers.clear() }
  /** Move our known, compact buffer at successful processing completion.
   * Transfer detaches producer aliases instead of allocating a second bitmap.
   * The bytes stay charged until entry adoption or flight settlement. */
  transfer(image: Pixels): Uint8Array | undefined {
    const current = this.current
    if (!current || image.width !== current.width || image.height !== current.height || image.data !== current.data ||
        !(current.data.buffer instanceof ArrayBuffer) || current.data.byteOffset !== 0 ||
        current.data.byteLength !== current.data.buffer.byteLength) return undefined
    const data = structuredClone(current.data, { transfer: [current.data.buffer] })
    this.current = { width: current.width, height: current.height, data }
    this.closed = true
    this.readers.clear()
    return data
  }
}
