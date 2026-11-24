import { ExecutionCancelled, type ExecutionControl } from '../scheduler/control.ts'
import { IMAGE_JPEG_MAX_SOURCE, type ImageJpegKernel, type ImageJpegMode,
  type ImageJpegPrecision, type ImageJpegProvider } from '../ports/image-jpeg.ts'

/** Session-owned lazy native decoder. A late load can only retire its own
 * kernel, never publish into a stopped or replacement Session. */
export class LazyImageJpegProvider implements ImageJpegProvider {
  private pending?: Promise<ImageJpegKernel>
  private kernel?: ImageJpegKernel
  private disposed = false
  constructor(private readonly load: () => Promise<ImageJpegKernel>,
    private readonly control: () => ExecutionControl) {}
  async open(source: Uint8Array, mode: ImageJpegMode, precision: ImageJpegPrecision) {
    this.control().check()
    if (this.disposed) throw new ExecutionCancelled()
    if (source.byteLength > IMAGE_JPEG_MAX_SOURCE) throw new Error('JPEG source exceeds 64 MiB budget')
    if (!this.pending) {
      const pending = Promise.resolve().then(this.load).then((kernel) => {
        if (this.disposed || this.control().cancelled) {
          kernel.dispose()
          throw new ExecutionCancelled()
        }
        this.kernel = kernel
        return kernel
      })
      this.pending = pending
      void pending.catch(() => {
        if (!this.disposed && this.pending === pending) this.pending = undefined
      })
    }
    const kernel = await this.pending
    this.control().check()
    if (this.disposed) throw new ExecutionCancelled()
    return kernel.open(mode, precision)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const pending = this.pending, kernel = this.kernel
    this.pending = undefined
    this.kernel = undefined
    // An already-resolved initialization promise must not keep a retired
    // module's linear memory alive. In-flight completion stays observed.
    void pending?.catch(() => {})
    kernel?.dispose()
  }
}
