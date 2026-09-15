import type {
  FrameLayer,
  Renderer,
  RendererReadiness,
  RendererStatus,
} from '../engine/ports/graphics.ts'
import { WindowRendererRegistry } from '../backends/render/window-renderers.ts'
import { WebGLRenderer } from '../backends/render/webgl2/renderer.ts'
import {
  hasWindowSurfaceIdentity,
  type WindowSurfaceIdentity,
  type WindowSurfaceReply,
  type WindowSurfaceRequest,
} from '../protocol/surfaces.ts'

export interface WorkerWindowSurfacesOptions {
  maxWindows?: number
  /** A factory owns any partial GPU resources it creates before throwing. */
  createRenderer?(canvas: OffscreenCanvas, identity: WindowSurfaceIdentity): Renderer
}

interface PendingFrame {
  layers: FrameLayer[]
  width: number
  height: number
}

class DeferredWindowRenderer implements Renderer {
  private renderer?: Renderer
  private unsubscribe?: () => void
  private frame?: PendingFrame
  private received = false
  private disposed = false
  private flushing = false
  private initialPending = true
  private readonly listeners = new Set<(status: RendererStatus) => void>()
  private status: RendererStatus = { state: 'restoring', generation: 0, pending: true }
  private backendStatus: RendererStatus = { state: 'restoring', generation: 0 }
  private signature = ''
  readonly identity: WindowSurfaceIdentity

  constructor(
    identity: WindowSurfaceIdentity,
    private readonly send: (message: WindowSurfaceRequest) => void,
    private readonly create: NonNullable<WorkerWindowSurfacesOptions['createRenderer']>,
    private readonly retire: () => void,
  ) {
    this.identity = { ...identity }
  }

  request(): void {
    if (this.disposed) return
    this.received = false
    this.publish({ state: 'restoring', generation: 0 })
    if (this.disposed) return
    try {
      this.send({ type: 'request', ...this.identity })
    } catch (error) {
      this.fail(error)
    }
  }

  receive(message: WindowSurfaceReply): void {
    if (this.disposed || this.received || message.surfaceEpoch !== this.identity.surfaceEpoch)
      return
    this.received = true
    if (message.type === 'failed') {
      this.fail(new Error(message.message))
      return
    }
    let renderer: Renderer | undefined
    try {
      renderer = this.create(message.canvas, { ...this.identity })
      if (this.disposed) {
        renderer.dispose()
        return
      }
      this.renderer = renderer
      if (renderer.subscribe) {
        const unsubscribe = renderer.subscribe((status) => {
          if (this.disposed || this.renderer !== renderer) return
          this.publish(status)
          if (status.state === 'restoring') this.flush()
        })
        if (this.disposed || this.renderer !== renderer) unsubscribe()
        else this.unsubscribe = unsubscribe
      } else this.publish({ state: 'restoring', generation: 0 })
      this.flush()
    } catch (error) {
      try {
        this.releaseRenderer()
      } catch (cleanupError) {
        error = new AggregateError([error, cleanupError], 'Window renderer setup failed')
      }
      this.fail(error)
    }
  }

  private publish(status: RendererStatus): void {
    if (this.disposed) return
    this.backendStatus = { ...status }
    if (status.state === 'lost' || status.state === 'failed') this.initialPending = false
    const pending = this.initialPending && status.state === 'restoring'
    const signature = JSON.stringify([
      this.identity.surfaceEpoch,
      status.state,
      status.generation,
      status.message ?? null,
      pending,
    ])
    if (this.signature === signature) return
    this.signature = signature
    const next: RendererStatus = {
      state: status.state,
      generation: this.status.generation + 1,
      ...(status.message === undefined ? {} : { message: status.message }),
      ...(pending ? { pending: true } : {}),
    }
    this.status = next
    for (const listener of [...this.listeners]) {
      if (this.disposed || this.status !== next) break
      if (this.listeners.has(listener)) listener({ ...next })
    }
  }

  private fail(error: unknown): void {
    this.publish({
      state: 'failed',
      generation: 0,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  present(layers: FrameLayer[], width: number, height: number): boolean {
    if (this.disposed) return false
    this.frame = { layers, width, height }
    return this.flush()
  }

  private flush(): boolean {
    const renderer = this.renderer
    if (
      this.disposed ||
      this.flushing ||
      !renderer ||
      this.status.state === 'failed' ||
      this.status.state === 'lost'
    )
      return false
    this.flushing = true
    try {
      // Complete initial setup without waiting for the VM's first composition.
      // On recovery this direct replay can also resume a paused VM.
      const frame = this.frame ?? { layers: [], width: 1, height: 1 }
      const result = renderer.present(
        frame.layers,
        frame.width,
        frame.height,
        this.identity.windowId,
      )
      if (this.disposed || this.renderer !== renderer) return false
      if (result !== false) {
        const initial = this.initialPending
        this.initialPending = false
        if (!renderer.subscribe) this.publish({ state: 'ready', generation: 0 })
        else if (initial) this.publish(this.backendStatus)
      }
      return result !== false
    } catch (error) {
      this.fail(error)
      return false
    } finally {
      this.flushing = false
    }
  }

  retry(): void {
    if (this.disposed || this.status.state === 'ready') return
    if (this.renderer) {
      try {
        if (!this.renderer.subscribe) this.publish({ state: 'restoring', generation: 0 })
        if (this.disposed) return
        this.renderer.retry?.()
        this.flush()
      } catch (error) {
        this.fail(error)
      }
      return
    }
    // Pending requests are already in flight. A failed attempt requires a fresh
    // DOM canvas because transferControlToOffscreen cannot be called twice.
    if (this.status.state !== 'failed') return
    try {
      this.send({ type: 'detach', ...this.identity })
      if (this.identity.surfaceEpoch === Number.MAX_SAFE_INTEGER)
        throw new Error('Window surface epoch is exhausted')
      this.identity.surfaceEpoch++
      this.request()
    } catch (error) {
      this.fail(error)
    }
  }

  subscribe(listener: (status: RendererStatus) => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    try {
      listener({ ...this.status })
    } catch (error) {
      this.listeners.delete(listener)
      throw error
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  private releaseRenderer(): void {
    const unsubscribe = this.unsubscribe,
      renderer = this.renderer
    this.unsubscribe = undefined
    this.renderer = undefined
    const errors: unknown[] = []
    try {
      unsubscribe?.()
    } catch (error) {
      errors.push(error)
    }
    try {
      renderer?.dispose()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Window renderer cleanup failed')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.retire()
    this.frame = undefined
    this.listeners.clear()
    const errors: unknown[] = []
    try {
      this.releaseRenderer()
    } catch (error) {
      errors.push(error)
    }
    try {
      this.send({ type: 'detach', ...this.identity })
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Window surface retirement failed')
  }
}

/** Direct MessagePort replies can attach graphics while TJS awaits or is paused. */
export class WorkerWindowSurfaces implements Renderer {
  private readonly windows = new Map<number, DeferredWindowRenderer>()
  private readonly renderers: WindowRendererRegistry
  private readonly owned = new WeakSet<Renderer>()
  private disposed = false

  constructor(
    private readonly port: MessagePort,
    private readonly generation: number,
    options: WorkerWindowSurfacesOptions = {},
  ) {
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new RangeError('Surface session generation must be a positive safe integer')
    const create = options.createRenderer ?? ((canvas) => new WebGLRenderer(canvas))
    this.renderers = new WindowRendererRegistry((windowId) => {
      const renderer = new DeferredWindowRenderer(
        { generation, windowId, surfaceEpoch: 1 },
        (message) => this.port.postMessage(message),
        (canvas, identity) => {
          const backend = create(canvas, identity)
          if (backend === this || this.owned.has(backend))
            throw new Error('Each Window surface must own a fresh renderer')
          this.owned.add(backend)
          return backend
        },
        () => {
          if (this.windows.get(windowId) === renderer) this.windows.delete(windowId)
        },
      )
      this.windows.set(windowId, renderer)
      renderer.request()
      return renderer
    }, options)
    port.addEventListener('message', this.receive)
    port.start()
  }

  private readonly receive = ({ data }: MessageEvent<unknown>): void => {
    if (this.disposed || !hasWindowSurfaceIdentity(data) || data.generation !== this.generation)
      return
    const message = data as WindowSurfaceReply
    if (message.type !== 'attach' && message.type !== 'failed') return
    if (message.type === 'failed' && typeof message.message !== 'string') return
    this.windows.get(message.windowId)?.receive(message)
  }

  openWindow(windowId: number): void {
    this.renderers.openWindow(windowId)
  }

  closeWindow(windowId: number): void {
    this.renderers.closeWindow(windowId)
  }

  waitWindowReady(windowId: number): RendererReadiness {
    return this.renderers.waitWindowReady(windowId)
  }

  present(layers: FrameLayer[], width: number, height: number, windowId = 0): void | boolean {
    return this.renderers.present(layers, width, height, windowId)
  }

  subscribe(listener: (status: RendererStatus) => void): () => void {
    return this.renderers.subscribe(listener)
  }

  getStatus(windowId: number): RendererStatus | undefined {
    return this.renderers.getStatus(windowId)
  }

  getStatuses(): ReadonlyMap<number, RendererStatus> {
    return this.renderers.getStatuses()
  }

  retry(windowId?: number): void {
    this.renderers.retry(windowId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.port.removeEventListener('message', this.receive)
    try {
      this.renderers.dispose()
    } finally {
      this.windows.clear()
      this.port.close()
    }
  }
}
