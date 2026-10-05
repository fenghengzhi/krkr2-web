import type { WindowGeometry, WindowGeometryRequest, WindowGeometryScroll } from '../engine/ports/window-geometry.ts'
import { validateWindowGeometry } from '../engine/scene/window-geometry.ts'
import type { WindowGeometryMessage } from '../protocol/window-geometry.ts'

export interface GeometryPresentation {
  get(windowId: number): { surfaceEpoch: number } | undefined
  measureGeometry?(request: WindowGeometryRequest, surfaceEpoch: number, signal: AbortSignal): Promise<WindowGeometry>
  subscribeGeometryScroll?(listener: (observation: WindowGeometryScroll) => void): () => void
}
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0

/** This channel remains responsive while the VM awaits real DOM geometry. */
export class GeometryChannel {
  private closed = false
  private suspended = false
  private lastRequest = 0
  private readonly retired = new Set<number>()
  private readonly pending = new Map<number, { request: WindowGeometryRequest; epoch: number; abort: AbortController }>()
  private readonly unsubscribe: () => void
  constructor(private readonly port: MessagePort, private readonly generation: number,
    private readonly host: GeometryPresentation, private readonly onError: (error: unknown) => void) {
    if (!positive(generation)) throw new RangeError('Invalid Window geometry generation')
    port.addEventListener('message', this.message)
    port.addEventListener('messageerror', this.failed)
    port.start()
    this.unsubscribe = host.subscribeGeometryScroll?.((observation) => {
      if (this.closed || this.suspended || host.get(observation.windowId)?.surfaceEpoch !== observation.surfaceEpoch) return
      try { this.send({ type: 'scroll', generation, observation: { ...observation } }) }
      catch (error) { this.onError(error) }
    }) ?? (() => {})
  }
  private readonly message = (event: MessageEvent<unknown>) => {
    try { this.receive(event.data) } catch (error) { this.onError(error) }
  }
  private receive(data: unknown): void {
    const message = data as Partial<WindowGeometryMessage> | undefined
    if (this.closed || !message || message.generation !== this.generation) return
    if (message.type === 'close') { this.close(false); return }
    if (message.type === 'retire' && positive(message.windowId)) {
      this.retired.add(message.windowId); this.detach(message.windowId, false); return
    }
    if (this.suspended || message.type !== 'request') return
    const request = message.request
    if (!request || !positive(request.requestId) || !positive(request.windowId) ||
        !Number.isSafeInteger(request.revision)) return
    if (!positive(request.revision) || !request.view || !request.menus || !request.primary ||
        !request.innerRequest || typeof request.resetScroll !== 'boolean' ||
        !['create', 'outer', 'inner', 'chrome', 'content'].includes(request.operation)) {
      this.reject(request, 'Invalid Window geometry request'); return
    }
    if (request.requestId <= this.lastRequest) {
      this.reject(request, 'Window geometry request is stale'); return
    }
    this.lastRequest = request.requestId
    const epoch = this.retired.has(request.windowId) ? undefined : this.host.get(request.windowId)?.surfaceEpoch
    if (!epoch || !this.host.measureGeometry || this.pending.size >= 256) {
      this.reject(request, 'Window geometry presentation is unavailable'); return
    }
    const operation = { request, epoch, abort: new AbortController() }
    this.pending.set(request.requestId, operation)
    void (async () => {
      let publishing = false
      try {
        const geometry = validateWindowGeometry(request,
          await this.host.measureGeometry!(request, epoch, operation.abort.signal))
        if (this.pending.get(request.requestId) !== operation || this.suspended || this.closed) return
        if (geometry.platform !== 'dom' || geometry.surfaceEpoch !== epoch ||
            this.host.get(request.windowId)?.surfaceEpoch !== epoch)
          throw new Error('Window geometry surface changed during measurement')
        publishing = true
        this.send({ type: 'reply', generation: this.generation, requestId: request.requestId,
          windowId: request.windowId, revision: request.revision, ok: true, geometry })
      } catch (error) {
        if (publishing) throw error
        if (this.pending.get(request.requestId) === operation && !this.suspended && !this.closed)
          this.reject(request, error instanceof Error ? error.message : String(error))
      } finally {
        if (this.pending.get(request.requestId) === operation) this.pending.delete(request.requestId)
      }
    })().catch(this.onError)
  }
  private reject(request: WindowGeometryRequest, error: string): void {
    this.send({ type: 'reply', generation: this.generation, requestId: request.requestId,
      windowId: request.windowId, revision: request.revision, ok: false, error: error.slice(0, 4096) })
  }
  private readonly failed = () => { try { this.close() } catch (error) { this.onError(error) } }
  private send(message: WindowGeometryMessage): void {
    try { this.port.postMessage(message) }
    catch (error) {
      try { this.close() }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Window geometry send and cleanup failed') }
      throw error
    }
  }
  detach(windowId: number, notify = true): void {
    for (const [id, operation] of this.pending) {
      if (operation.request.windowId !== windowId) continue
      this.pending.delete(id)
      operation.abort.abort()
      if (notify && !this.suspended && !this.closed) this.reject(operation.request, 'Window geometry surface retired')
    }
  }
  /** Stop owns VM cancellation; abort local work without racing its control RPC. */
  suspend(): void {
    this.suspended = true
    for (const operation of this.pending.values()) operation.abort.abort()
    this.pending.clear()
  }
  close(notify = true): void {
    if (this.closed) return
    this.closed = true
    this.retired.clear()
    const errors: unknown[] = []
    for (const action of [() => this.suspend(), () => this.unsubscribe(),
      () => this.port.removeEventListener('message', this.message),
      () => this.port.removeEventListener('messageerror', this.failed),
      () => { if (notify) this.port.postMessage({ type: 'close', generation: this.generation } satisfies WindowGeometryMessage) },
      () => this.port.close()]) {
      try { action() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Window geometry channel cleanup failed')
  }
}
