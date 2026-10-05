import type { WindowMoveMessage, WindowMoveRequest } from '../ports/window-move.ts'
import type { HostReply } from '../script/runtime.ts'
import type { ModalLoop } from '../scheduler/modal-loop.ts'
import type { WindowRecord } from './windows.ts'

export interface WindowMoveActions {
  window(id: number): WindowRecord | undefined
  position(window: WindowRecord, left: number, top: number): void
  changed(request: WindowMoveRequest | null): void
}
interface Move {
  readonly window: WindowRecord
  readonly identity: string
  readonly request: WindowMoveRequest
  token?: number
  sequence: number
  ended: boolean
  committed: boolean
  error?: string
}

/** WindowForm.BeginMove enters DefWindowProc synchronously. Its TJS caller
 * therefore uses the existing modal pump rather than a second VM entry or a
 * bare Promise that would freeze timers. No Layer capture is released here:
 * Win32 ReleaseCapture does not itself call LayerManager.ReleaseCapture. */
export class WindowMoves {
  private current?: Move
  private nextRequest = 1
  private presented: number | undefined
  constructor(private readonly loop: ModalLoop, private readonly actions: WindowMoveActions,
    private readonly supported: boolean) {}

  begin(windowId: number, identity: string): HostReply {
    const window = this.actions.window(windowId)
    if (!window || window.closing || window.finished) throw new Error('Window has been invalidated')
    if (window.state.fullScreen) throw new Error('Window.beginMove is unavailable in fullscreen')
    if (!this.supported) throw new Error('Window moving presentation is unavailable')
    if (!identity) throw new Error('Invalid Window move request identity')
    if (this.current) throw new Error('A Window move is already active')
    if (!Number.isSafeInteger(this.nextRequest + 1)) throw new Error('Window move request identities exhausted')
    const record: Move = { window, identity, sequence: 0, ended: false, committed: false,
      request: Object.freeze({ requestId: this.nextRequest++, windowId,
        left: window.state.left, top: window.state.top }) }
    this.current = record
    const cleanup = () => {
      if (this.current !== record) return
      this.current = undefined
      const errors: unknown[] = []
      if (!record.committed && !this.loop.stopped && this.live(record)) {
        try { this.actions.position(window, record.request.left, record.request.top) }
        catch (error) { errors.push(error) }
      }
      try { if (this.presented === record.request.requestId) this.publish(null) }
      catch (error) { errors.push(error) }
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, 'Window move cleanup failed')
    }
    try {
      record.token = this.loop.open({ kind: 'window-move', ownerId: windowId, windowId, cleanup })
      if (this.current !== record || !this.live(record) || !this.loop.info(record.token))
        throw new Error('Window move opening has ended')
      this.present()
      return this.loop.invoke(record.token)
    } catch (error) {
      try {
        if (record.token === undefined) cleanup()
        else this.abort(windowId, identity)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Window move opening and cleanup failed')
      }
      throw error
    }
  }
  private live(record: Move): boolean {
    return !record.window.closing && !record.window.finished &&
      this.actions.window(record.window.id) === record.window
  }
  private publish(request: WindowMoveRequest | null): void {
    const id = request?.requestId
    if (this.presented === id) return
    this.presented = id
    this.actions.changed(request)
  }
  /** A child modal owns focus/capture. Retire the old drag immediately but
   * finish its parent only when that child's TJS frame has unwound. */
  present(): void {
    const record = this.current
    if (!record || record.token === undefined) return
    if (this.loop.activeToken !== record.token) record.ended = true
    this.publish(record.ended ? null : record.request)
  }
  beforeWait(token: number): void {
    const record = this.current
    if (!record || record.token !== token || this.loop.activeToken !== token || !record.ended) return
    this.loop.finish(token, record.error)
  }
  receive(message: WindowMoveMessage): boolean {
    if (!message || !Number.isSafeInteger(message.requestId) || message.requestId <= 0 ||
        !Number.isSafeInteger(message.windowId) || message.windowId <= 0 ||
        !Number.isSafeInteger(message.sequence) || message.sequence <= 0)
      throw new Error('Invalid Window move reply identity')
    const record = this.current
    if (!record || record.request.requestId !== message.requestId || record.window.id !== message.windowId ||
        message.sequence <= record.sequence || record.ended || !this.live(record) ||
        record.token !== this.loop.activeToken) return false
    if (message.type === 'update' || message.type === 'commit') {
      if (![message.left, message.top].every((value) => Number.isSafeInteger(value) && value >= -0x80000000 && value <= 0x7fffffff))
        throw new Error('Invalid Window move position')
    } else if (message.type === 'error') {
      if (typeof message.message !== 'string' || !message.message || message.message.length > 4096)
        throw new Error('Invalid Window move error')
    } else if (message.type !== 'cancel') throw new Error('Unknown Window move reply')
    record.sequence = message.sequence
    if (message.type === 'update' || message.type === 'commit') {
      this.actions.position(record.window, message.left, message.top)
      // Presentation may synchronously retire this interaction or deliver a
      // newer reply. Never overwrite that later authority after returning.
      if (this.current !== record || record.ended || record.sequence !== message.sequence || !this.live(record)) return true
    }
    if (message.type !== 'update') {
      record.ended = true
      record.committed = message.type === 'commit'
      if (message.type === 'error') record.error = message.message
      try { this.publish(null) } finally { this.loop.notify() }
    }
    return true
  }
  cancel(windowId?: number): void {
    const record = this.current
    if (!record || record.ended || (windowId !== undefined && record.window.id !== windowId)) return
    record.ended = true
    record.committed = false
    try { this.publish(null) } finally { this.loop.notify() }
  }
  invalidate(windowId: number): void {
    const record = this.current
    if (!record || record.window.id !== windowId) return
    record.ended = true
    try { this.publish(null) }
    finally { if (record.token !== undefined) this.loop.cancel(record.token, 'window-invalidated') }
  }
  abort(windowId: number, identity: string): boolean {
    const record = this.current
    if (!record || record.window.id !== windowId || record.identity !== identity) return false
    record.ended = true
    const errors: unknown[] = []
    try { this.publish(null) } catch (error) { errors.push(error) }
    try {
      if (record.token !== undefined) {
        this.loop.cancel(record.token, 'window-move-aborted')
        if (this.loop.activeToken === record.token) this.loop.release(record.token)
      }
    } catch (error) { errors.push(error) }
    this.loop.notify()
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Window move abort cleanup failed')
    return true
  }
}
