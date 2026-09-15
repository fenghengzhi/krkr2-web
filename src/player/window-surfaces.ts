import {
  hasWindowSurfaceIdentity,
  windowSurfaceIdentity,
  type WindowSurfaceIdentity,
  type WindowSurfaceReply,
  type WindowSurfaceRequest,
} from '../protocol/surfaces.ts'

export interface BrowserWindowSurfaceHost {
  attach(windowId: number, surfaceEpoch: number): HTMLCanvasElement | undefined
  detach(windowId: number, surfaceEpoch: number): void
}

export interface BrowserWindowSurfacesOptions {
  onAttach?(canvas: HTMLCanvasElement, identity: WindowSurfaceIdentity): void
  /** Runs before host.detach, while the input/video DOM is still present. */
  onDetach?(canvas: HTMLCanvasElement, identity: WindowSurfaceIdentity): void
}

interface BrowserSurface {
  identity: WindowSurfaceIdentity
  canvas?: HTMLCanvasElement
}

/** Owns the page half of dynamic surfaces, including their input/DOM lifetime. */
export class BrowserWindowSurfaces {
  private readonly surfaces = new Map<number, BrowserSurface>()
  private readonly epochs = new Map<number, { epoch: number }>()
  private readonly transferred = new WeakSet<HTMLCanvasElement>()
  private disposed = false

  constructor(
    private readonly port: MessagePort,
    private readonly generation: number,
    private readonly host: BrowserWindowSurfaceHost,
    private readonly options: BrowserWindowSurfacesOptions = {},
  ) {
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new RangeError('Surface session generation must be a positive safe integer')
    port.addEventListener('message', this.receive)
    port.start()
  }

  private readonly receive = ({ data }: MessageEvent<unknown>): void => {
    if (this.disposed || !hasWindowSurfaceIdentity(data) || data.generation !== this.generation)
      return
    const message = data as WindowSurfaceRequest
    if (message.type !== 'request' && message.type !== 'detach') return
    const latest = this.epochs.get(message.windowId)?.epoch ?? 0
    if (message.type === 'request' ? message.surfaceEpoch <= latest : message.surfaceEpoch < latest)
      return
    const operation = { epoch: message.surfaceEpoch }
    this.epochs.set(message.windowId, operation)
    const previous = this.surfaces.get(message.windowId)
    try {
      if (previous) this.release(previous)
      if (
        message.type === 'detach' ||
        this.disposed ||
        this.epochs.get(message.windowId) !== operation
      )
        return
      const entry: BrowserSurface = { identity: windowSurfaceIdentity(message) }
      this.surfaces.set(message.windowId, entry)
      try {
        const canvas = this.host.attach(message.windowId, message.surfaceEpoch)
        if (!this.current(entry)) return
        if (!canvas) throw new Error('The Window host did not provide a canvas')
        entry.canvas = canvas
        this.options.onAttach?.(canvas, { ...entry.identity })
        if (!this.current(entry)) return
        if (this.transferred.has(canvas))
          throw new Error('A Window canvas cannot be transferred more than once')
        // Even a throwing transfer attempt consumes this canvas for our host.
        this.transferred.add(canvas)
        const offscreen = canvas.transferControlToOffscreen()
        if (!this.current(entry)) return
        this.port.postMessage(
          { type: 'attach', ...entry.identity, canvas: offscreen } satisfies WindowSurfaceReply,
          [offscreen],
        )
      } catch (error) {
        const errors = [error]
        try {
          this.release(entry)
        } catch (cleanupError) {
          errors.push(cleanupError)
        }
        throw errors.length === 1
          ? error
          : new AggregateError(errors, 'Window surface setup failed')
      }
    } catch (error) {
      if (!this.disposed)
        this.port.postMessage({
          type: 'failed',
          ...windowSurfaceIdentity(message),
          message: error instanceof Error ? error.message : String(error),
        } satisfies WindowSurfaceReply)
    }
  }

  private current(entry: BrowserSurface): boolean {
    return !this.disposed && this.surfaces.get(entry.identity.windowId) === entry
  }

  private release(entry: BrowserSurface): void {
    if (this.surfaces.get(entry.identity.windowId) !== entry) return
    this.surfaces.delete(entry.identity.windowId)
    const errors: unknown[] = []
    try {
      if (entry.canvas) this.options.onDetach?.(entry.canvas, { ...entry.identity })
    } catch (error) {
      errors.push(error)
    }
    try {
      this.host.detach(entry.identity.windowId, entry.identity.surfaceEpoch)
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Window surface cleanup failed')
  }

  get(
    windowId: number,
  ): { canvas: HTMLCanvasElement; identity: WindowSurfaceIdentity } | undefined {
    const entry = this.surfaces.get(windowId)
    return entry?.canvas && { canvas: entry.canvas, identity: { ...entry.identity } }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.port.removeEventListener('message', this.receive)
    const errors: unknown[] = []
    for (const entry of [...this.surfaces.values()])
      try {
        this.release(entry)
      } catch (error) {
        errors.push(error)
      }
    this.epochs.clear()
    this.port.close()
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Window surfaces cleanup failed')
  }
}
