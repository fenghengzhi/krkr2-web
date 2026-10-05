import type { FrameLayer, Renderer, RendererStatus } from '../../../engine/ports/graphics.ts'
import { WebGLRenderer } from './renderer.ts'

/** One GPU context per Session, with independently committed Window bitmaps.
 * Chromium limits a worker to four live WebGL contexts. Output canvases never
 * acquire WebGL and retain their own last frame when another Window draws. */
export class WindowGpuPool {
  private readonly outputs = new Set<WindowBitmapRenderer>()
  private status: RendererStatus = { state: 'restoring', generation: 0 }
  private unsubscribe?: () => void
  private transition = 0
  private drawing = false
  private retrying = false
  private disposed = false

  constructor(
    private readonly canvas: OffscreenCanvas = new OffscreenCanvas(1, 1),
    private readonly renderer: Renderer = new WebGLRenderer(canvas),
  ) {
    this.unsubscribe = renderer.subscribe?.((status) => this.changed(status))
  }

  attach(canvas: OffscreenCanvas): Renderer {
    if (this.disposed) throw new Error('Window GPU pool is disposed')
    const output = new WindowBitmapRenderer(this, canvas)
    this.outputs.add(output)
    output.update(this.status.state === 'ready' ? 'restoring' : this.status.state, this.status.message)
    return output
  }

  private changed(status: RendererStatus): void {
    if (this.disposed) return
    this.status = { ...status }
    // A successful scratch draw is not a successful commit to any output yet.
    if (status.state === 'ready') return
    const transition = ++this.transition, outputs = [...this.outputs]
    // Invalidate every output before a subscriber can reenter and replay one.
    for (const output of outputs) output.update(status.state, status.message)
    for (const output of outputs) {
      if (this.disposed || this.transition !== transition) break
      if (this.outputs.has(output)) output.notify()
    }
  }

  present(output: WindowBitmapRenderer, layers: FrameLayer[], width: number, height: number): boolean {
    if (this.disposed || !this.outputs.has(output) || this.drawing || !this.drawable()) return false
    let bitmap: ImageBitmap | undefined
    let failed = false
    this.drawing = true
    try {
      if (this.renderer.present(layers, width, height) === false || this.disposed || !this.outputs.has(output))
        return false
      bitmap = this.canvas.transferToImageBitmap()
      const owned = bitmap
      // Both commit variants consume/close their bitmap, including failures.
      bitmap = undefined
      output.commit(owned, width, height)
    } catch (error) {
      failed = true
      if (!this.disposed && this.outputs.has(output) && this.status.state !== 'lost')
        output.update('failed', error instanceof Error ? error.message : String(error))
      return false
    } finally {
      bitmap?.close()
      this.drawing = false
      // Publish only after releasing the drawing guard. A ready notification
      // may synchronously request another Window's frame.
      if (failed && !this.disposed && this.outputs.has(output)) output.notify()
    }
    if (this.disposed || !this.outputs.has(output)) return false
    output.update('ready')
    output.notify()
    return !this.disposed && this.outputs.has(output) && output.ready
  }

  private drawable(): boolean { return this.status.state === 'ready' || this.status.state === 'restoring' }

  retry(output: WindowBitmapRenderer): void {
    if (this.disposed || !this.outputs.has(output)) return
    if ((this.status.state === 'lost' || this.status.state === 'failed') && !this.retrying) {
      // Registry.retry visits every failed output in this turn. A shared GPU
      // failure must cause one rebuild attempt, even when that attempt fails.
      this.retrying = true
      queueMicrotask(() => { this.retrying = false })
      this.renderer.retry?.()
    }
    if (this.status.state === 'ready' || this.status.state === 'restoring') {
      output.update('restoring')
      output.notify()
    }
  }

  retire(output: WindowBitmapRenderer): void { this.outputs.delete(output) }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const errors: unknown[] = []
    for (const output of [...this.outputs]) {
      try { output.dispose() } catch (error) { errors.push(error) }
    }
    try { this.unsubscribe?.() } catch (error) { errors.push(error) }
    this.unsubscribe = undefined
    try { this.renderer.dispose() } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Shared Window GPU cleanup failed')
  }
}

class WindowBitmapRenderer implements Renderer {
  private readonly bitmap: ImageBitmapRenderingContext | null
  private readonly context: OffscreenCanvasRenderingContext2D | null
  private readonly listeners = new Set<(status: RendererStatus) => void>()
  private status: RendererStatus = { state: 'restoring', generation: 0 }
  private notified = -1
  private disposed = false
  get ready(): boolean { return !this.disposed && this.status.state === 'ready' }

  constructor(private readonly pool: WindowGpuPool, private readonly canvas: OffscreenCanvas) {
    this.bitmap = canvas.getContext('bitmaprenderer')
    this.context = this.bitmap ? null : canvas.getContext('2d', { alpha: false })
    if (!this.bitmap && !this.context) throw new Error('Window bitmap presentation is unavailable')
  }

  update(state: RendererStatus['state'], message?: string): void {
    if (this.disposed || (state === this.status.state && message === this.status.message)) return
    this.status = { state, generation: this.status.generation + 1, ...(message === undefined ? {} : { message }) }
  }
  notify(): void {
    if (this.disposed || this.notified === this.status.generation) return
    const status = this.status
    this.notified = status.generation
    for (const listener of [...this.listeners]) {
      if (this.disposed || this.status !== status) break
      if (this.listeners.has(listener)) listener({ ...status })
    }
  }
  subscribe(listener: (status: RendererStatus) => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    try { listener({ ...this.status }) }
    catch (error) { this.listeners.delete(listener); throw error }
    return () => { this.listeners.delete(listener) }
  }
  commit(bitmap: ImageBitmap, width: number, height: number): void {
    // transferFromImageBitmap consumes the source. The 2D path borrows it only
    // until the synchronous copy returns, and closes it even on draw failure.
    let consumed = false
    try {
      if (this.canvas.width !== width) this.canvas.width = width
      if (this.canvas.height !== height) this.canvas.height = height
      if (this.bitmap) {
        this.bitmap.transferFromImageBitmap(bitmap)
        consumed = true
      } else {
        const context = this.context!
        context.imageSmoothingEnabled = false
        context.globalCompositeOperation = 'copy'
        context.drawImage(bitmap, 0, 0)
      }
    } finally { if (!consumed) bitmap.close() }
  }
  present(layers: FrameLayer[], width: number, height: number): boolean {
    if (this.disposed || this.status.state === 'failed' || this.status.state === 'lost') return false
    return this.pool.present(this, layers, width, height)
  }
  retry(): void { if (!this.disposed) this.pool.retry(this) }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.pool.retire(this)
    this.canvas.width = 0
    this.canvas.height = 0
  }
}
