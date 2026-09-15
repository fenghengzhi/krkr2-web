import type { FrameLayer, Renderer, RendererStatus } from '../../engine/ports/graphics.ts'

export interface WindowRendererRegistryOptions {
  /** Maximum simultaneously registered surfaces, including ones being constructed. */
  maxWindows?: number
  /** Observer exceptions are diagnostics; they never become graphics failures. */
  onObserverError?: (error: unknown) => void
}

interface WindowRenderer {
  renderer?: Renderer
  unsubscribe?: () => void
  opening: boolean
  status: RendererStatus
}

const severity: Record<RendererStatus['state'], number> = {
  ready: 0,
  restoring: 1,
  lost: 2,
  failed: 3,
}

function throwErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, message)
}

/**
 * One renderer owns one Window's texture cache and drawing surface. The factory
 * can return a transport proxy while its surface attaches asynchronously; it
 * must clean its own partial resources if it throws before returning a renderer.
 * Window IDs cannot be reused after retirement. Context restoration belongs to
 * the existing renderer, rather than opening that Window a second time.
 */
export class WindowRendererRegistry implements Renderer {
  private readonly windows = new Map<number, WindowRenderer>()
  private readonly retired = new Set<number>()
  private readonly ownedRenderers = new WeakSet<Renderer>()
  private readonly listeners = new Set<(status: RendererStatus) => void>()
  private readonly maxWindows: number
  private readonly onObserverError?: (error: unknown) => void
  private disposed = false
  private signature = '[]'
  private status: RendererStatus = { state: 'ready', generation: 0 }

  constructor(
    private readonly create: (windowId: number) => Renderer,
    options: WindowRendererRegistryOptions = {},
  ) {
    if (
      options.maxWindows !== undefined &&
      (!Number.isSafeInteger(options.maxWindows) || options.maxWindows < 1)
    )
      throw new RangeError('The renderer budget must be a positive safe integer')
    this.maxWindows = options.maxWindows ?? Infinity
    this.onObserverError = options.onObserverError
  }

  openWindow(windowId: number): void {
    if (!Number.isSafeInteger(windowId) || windowId < 1)
      throw new RangeError('Window renderer IDs must be positive safe integers')
    if (this.disposed) throw new Error('The window renderer registry is disposed')
    if (this.retired.has(windowId)) throw new Error(`Window renderer ${windowId} is retired`)
    if (this.windows.has(windowId)) return
    if (this.windows.size >= this.maxWindows)
      throw new Error(`The window renderer budget of ${this.maxWindows} is exhausted`)

    const entry: WindowRenderer = {
      opening: true,
      status: { state: 'restoring', generation: 0 },
    }
    // Reserve the identity and budget before calling a potentially reentrant factory.
    this.windows.set(windowId, entry)
    try {
      const renderer = this.create(windowId)
      if (renderer === this || this.ownedRenderers.has(renderer))
        throw new Error('Each Window must own a fresh renderer instance')
      this.ownedRenderers.add(renderer)
      entry.renderer = renderer
      if (!this.current(windowId, entry)) {
        this.release(entry)
        return
      }
      if (entry.renderer.subscribe) {
        const unsubscribe = entry.renderer.subscribe((status) => {
          if (!this.current(windowId, entry)) return
          entry.status = { ...status }
          if (!entry.opening) this.publish()
        })
        if (!this.current(windowId, entry)) {
          // close/dispose may have run before subscribe returned its cleanup.
          unsubscribe()
          return
        }
        entry.unsubscribe = unsubscribe
      } else entry.status = { state: 'ready', generation: 0 }
      entry.opening = false
    } catch (error) {
      if (this.current(windowId, entry)) this.windows.delete(windowId)
      this.retired.add(windowId)
      const errors = [error]
      try {
        this.release(entry)
      } catch (cleanupError) {
        errors.push(cleanupError)
      }
      try {
        this.publish()
      } catch (notificationError) {
        errors.push(notificationError)
      }
      throwErrors(errors, `Could not create window renderer ${windowId}`)
    }
    this.publish()
  }

  closeWindow(windowId: number): void {
    if (this.disposed || !Number.isSafeInteger(windowId) || windowId < 1) return
    // Also reject a late open for an identity closed before its surface arrived.
    this.retired.add(windowId)
    const entry = this.windows.get(windowId)
    if (!entry) return
    this.windows.delete(windowId)
    const errors: unknown[] = []
    try {
      this.release(entry)
    } catch (error) {
      errors.push(error)
    }
    try {
      this.publish()
    } catch (error) {
      errors.push(error)
    }
    throwErrors(errors, `Could not close window renderer ${windowId}`)
  }

  private current(windowId: number, entry: WindowRenderer): boolean {
    return !this.disposed && this.windows.get(windowId) === entry
  }

  private release(entry: WindowRenderer): void {
    const unsubscribe = entry.unsubscribe,
      renderer = entry.renderer
    entry.unsubscribe = undefined
    entry.renderer = undefined
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
    throwErrors(errors, 'Could not release window renderer resources')
  }

  /** Missing/zero IDs represent no surface, never an implicit current Window. */
  present(layers: FrameLayer[], width: number, height: number, windowId = 0): void | boolean {
    const entry = this.windows.get(windowId)
    if (this.disposed || !entry?.renderer || entry.opening || !this.drawable(entry)) return false
    try {
      const result = entry.renderer.present(layers, width, height, windowId)
      return this.current(windowId, entry) && this.drawable(entry) ? result : false
    } catch (error) {
      this.fail(windowId, entry, error)
      return false
    }
  }

  private drawable(entry: WindowRenderer): boolean {
    return entry.status.state === 'ready' || entry.status.state === 'restoring'
  }

  private fail(windowId: number, entry: WindowRenderer, error: unknown): void {
    if (!this.current(windowId, entry)) return
    entry.status = {
      state: 'failed',
      generation: entry.status.generation,
      message: error instanceof Error ? error.message : String(error),
    }
    this.publish()
  }

  /** Omit the ID to retry all unhealthy surfaces; never recreates a retired one. */
  retry(windowId?: number): void {
    if (this.disposed) return
    const entries = [...this.windows].filter(([id]) => windowId === undefined || id === windowId)
    const errors: unknown[] = []
    for (const [id, entry] of entries) {
      if (!this.current(id, entry) || entry.opening || entry.status.state === 'ready') continue
      try {
        entry.renderer?.retry?.()
      } catch (error) {
        errors.push(error)
        try {
          this.fail(id, entry, error)
        } catch (notificationError) {
          errors.push(notificationError)
        }
      }
    }
    throwErrors(errors, 'Could not retry window renderers')
  }

  getStatus(windowId: number): RendererStatus | undefined {
    const entry = this.windows.get(windowId)
    return entry && { ...entry.status }
  }

  getStatuses(): ReadonlyMap<number, RendererStatus> {
    return new Map([...this.windows].map(([id, entry]) => [id, { ...entry.status }]))
  }

  subscribe(listener: (status: RendererStatus) => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    this.notify(listener, this.status)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(listener: (status: RendererStatus) => void, status: RendererStatus): void {
    try {
      listener({ ...status })
    } catch (error) {
      // Never throw into a backend's status callback: WebGL catches that as a
      // failed draw/rebuild, even when its actual graphics operation succeeded.
      try {
        this.onObserverError?.(error)
      } catch {
        // A failing diagnostic callback must not change graphics or cleanup.
      }
    }
  }

  private publish(): void {
    if (this.disposed) return
    const statuses = [...this.windows]
      .filter(([, entry]) => !entry.opening)
      .map(([id, entry]) => [id, entry.status] as const)
    const signature = JSON.stringify(
      statuses.map(([id, status]) => [
        id,
        status.state,
        status.generation,
        status.message ?? null,
        status.pending === true,
      ]),
    )
    if (signature === this.signature) return
    this.signature = signature
    let state: RendererStatus['state'] = 'ready'
    let pending = true
    const messages: string[] = []
    for (const [id, status] of statuses) {
      if (severity[status.state] > severity[state]) state = status.state
      if (status.state !== 'ready' && (status.state !== 'restoring' || status.pending !== true))
        pending = false
      if (status.state !== 'ready') messages.push(`Window ${id}: ${status.message ?? status.state}`)
    }
    // Backend generations are independent. This is a registry-local revision,
    // including resource changes hidden underneath another Window's failure.
    const status: RendererStatus = {
      state,
      generation: this.status.generation + 1,
      ...(state === 'restoring' && pending ? { pending: true } : {}),
      ...(messages.length ? { message: messages.join('; ') } : {}),
    }
    this.status = status
    for (const listener of [...this.listeners]) {
      // A callback may publish a newer state or dispose the registry itself.
      if (this.disposed || this.status !== status) break
      if (this.listeners.has(listener)) this.notify(listener, status)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    const entries = [...this.windows.values()]
    this.windows.clear()
    this.retired.clear()
    const errors: unknown[] = []
    for (const entry of entries)
      try {
        this.release(entry)
      } catch (error) {
        errors.push(error)
      }
    throwErrors(errors, 'Could not dispose window renderers')
  }
}
