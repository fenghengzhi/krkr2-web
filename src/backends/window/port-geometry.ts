import type { WindowGeometry, WindowGeometryPort, WindowGeometryRequest, WindowGeometryScroll } from '../../engine/ports/window-geometry.ts'
import { copyWindowGeometry } from '../../engine/scene/window-geometry.ts'
import type { WindowGeometryMessage } from '../../protocol/window-geometry.ts'

export class PortWindowGeometry implements WindowGeometryPort {
  private closed = false
  private readonly pending = new Map<number, {
    request: WindowGeometryRequest
    resolve(value: WindowGeometry): void
    reject(error: unknown): void
  }>()
  private readonly listeners = new Set<(observation: WindowGeometryScroll) => void>()
  private readonly retired = new Set<number>()
  constructor(private readonly port: MessagePort, private readonly generation: number) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid geometry generation')
    port.addEventListener('message', this.message)
    port.addEventListener('messageerror', this.messageError)
    port.start()
  }
  measure(request: WindowGeometryRequest): Promise<WindowGeometry> {
    if (this.closed || this.retired.has(request.windowId)) return Promise.reject(new Error('Window geometry is retired'))
    if (this.pending.has(request.requestId)) return Promise.reject(new Error('Duplicate geometry request'))
    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, { request, resolve, reject })
      try { this.port.postMessage({ type: 'request', generation: this.generation, request } satisfies WindowGeometryMessage) }
      catch (error) { this.pending.delete(request.requestId); reject(error) }
    })
  }
  subscribe(listener: (observation: WindowGeometryScroll) => void): () => void {
    if (this.closed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private readonly message = ({ data }: MessageEvent<unknown>): void => {
    if (this.closed || !data || typeof data !== 'object') return
    const message = data as Partial<WindowGeometryMessage>
    if (message.generation !== this.generation) return
    if (message.type === 'close') { this.close(false); return }
    if (message.type === 'scroll') {
      const observation = message.observation
      if (!observation || this.retired.has(observation.windowId)) return
      // The Engine validates identity, revision, bounds and physical sequence.
      for (const listener of [...this.listeners]) {
        if (this.closed) break
        if (this.listeners.has(listener)) listener({ ...observation })
      }
      return
    }
    if (message.type !== 'reply' || !Number.isSafeInteger(message.requestId)) return
    const pending = this.pending.get(message.requestId!)
    if (!pending) return
    if (message.windowId !== pending.request.windowId || message.revision !== pending.request.revision) return
    this.pending.delete(message.requestId!)
    try {
      if (message.ok === true && message.geometry) pending.resolve(copyWindowGeometry(message.geometry))
      else pending.reject(new Error(message.ok === false && typeof message.error === 'string'
        ? message.error : 'Invalid geometry response'))
    } catch (error) { pending.reject(error) }
  }
  private readonly messageError = (): void => { this.close(true) }
  retire(windowId: number): void {
    if (this.closed || this.retired.has(windowId)) return
    this.retired.add(windowId)
    for (const [id, pending] of this.pending) if (pending.request.windowId === windowId) {
      this.pending.delete(id)
      pending.reject(new Error('Window geometry is retired'))
    }
    this.port.postMessage({ type: 'retire', generation: this.generation, windowId } satisfies WindowGeometryMessage)
  }
  dispose(): void { this.close(true) }
  private close(notify: boolean): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error('Window geometry host closed'))
    this.pending.clear(); this.listeners.clear(); this.retired.clear()
    this.port.removeEventListener('message', this.message)
    this.port.removeEventListener('messageerror', this.messageError)
    const errors: unknown[] = []
    try { if (notify) this.port.postMessage({ type: 'close', generation: this.generation } satisfies WindowGeometryMessage) }
    catch (error) { errors.push(error) }
    try { this.port.close() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Window geometry transport cleanup failed')
  }
}
