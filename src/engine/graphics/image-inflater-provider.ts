import type { ImageInflaterKernel, ImageInflaterProvider } from '../ports/image-inflater.ts'
import { ExecutionCancelled, type ExecutionControl } from '../scheduler/control.ts'

/** One lazily loaded image kernel per Session. Pending initialization remains
 * observed after retirement, and its late resources are closed immediately. */
export class LazyImageInflaterProvider implements ImageInflaterProvider {
  private pending?: Promise<ImageInflaterKernel>
  private kernel?: ImageInflaterKernel
  private disposed = false
  constructor(private readonly load: () => Promise<ImageInflaterKernel>,
    private readonly control: () => ExecutionControl) {}
  async open(_source: Uint8Array, _expectedLength: number) {
    this.control().check()
    if (this.disposed) throw new ExecutionCancelled()
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
    const pending = this.pending
    const kernel = await pending
    this.control().check()
    if (this.disposed) throw new ExecutionCancelled()
    return kernel.open()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.kernel?.dispose()
    this.kernel = undefined
    // Do not replace a still-pending load's own failure with a synthetic one.
    void this.pending?.catch(() => {})
  }
}
