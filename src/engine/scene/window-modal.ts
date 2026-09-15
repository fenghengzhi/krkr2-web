import type { HostReply } from '../script/runtime.ts'
import { ModalLoop } from '../scheduler/modal-loop.ts'
import type { WindowRecord, WindowService } from './windows.ts'

export interface WindowModalActions {
  /** Clear old input, show and activate this Window using host state only. */
  enter(window: WindowRecord): void
  /** Hide a surviving Window and restore a still-eligible previous Window. */
  leave(window: WindowRecord, previousWindowId: number): void
  /** Enqueue onCloseQuery through the normal, weak Window event path. */
  query(window: WindowRecord, onNotEntered: () => void): void
}

interface WindowModal {
  readonly window: WindowRecord
  readonly requestIdentity: string
  readonly completion: Promise<void>
  readonly complete: () => void
  readonly fail: (error: unknown) => void
  token?: number
  aborted: boolean
  closeRequested: boolean
  queryPending: boolean
  queryGeneration: number
  accepted: boolean
}

/** Window modal state is independent of visibility and of the active Window. */
export class WindowModals {
  private readonly tokens = new Map<number, WindowModal>()

  constructor(
    private readonly windows: WindowService,
    private readonly loop: ModalLoop,
    private readonly actions: WindowModalActions,
  ) {}

  get count(): number {
    return this.tokens.size
  }
  has(windowId: number): boolean {
    return this.tokens.has(windowId)
  }
  /** Only an accepted answer makes host close completion wait for modal unwind. */
  acceptedCompletion(windowId: number): Promise<void> | undefined {
    const record = this.tokens.get(windowId)
    return record?.accepted ? record.completion : undefined
  }
  blocked(windowId: number): boolean {
    const modal = this.loop.modalWindowId
    return modal !== undefined && modal !== windowId
  }

  show(windowId: number, requestIdentity: string): HostReply {
    if (typeof requestIdentity !== 'string' || !requestIdentity)
      throw new Error('A modal Window requires a request identity')
    const window = this.windows.get(windowId)
    if (window.closing || window.finished) throw new Error('Window has been invalidated')
    if (this.tokens.has(windowId)) throw new Error('Window is already modal')
    if (window.state.visible) throw new Error('A modal Window must be hidden before showModal')
    if (window.state.fullScreen) throw new Error('A fullscreen Window cannot be shown modally')
    const previousWindowId = this.windows.active?.id ?? 0
    let complete!: () => void, fail!: (error: unknown) => void
    const completion = new Promise<void>((resolve, reject) => {
      complete = resolve
      fail = reject
    })
    // Opening/cleanup can fail before any close caller asks for this Promise.
    // Keep the original rejecting Promise while observing that unclaimed path.
    void completion.catch(() => {})
    const record: WindowModal = {
      window,
      requestIdentity,
      completion,
      complete,
      fail,
      aborted: false,
      closeRequested: false,
      queryPending: false,
      queryGeneration: 0,
      accepted: false,
    }
    // Reserve before publishing the new scope; host observers may reenter.
    this.tokens.set(windowId, record)
    try {
      record.token = this.loop.open({
        kind: 'window',
        ownerId: windowId,
        windowId,
        cleanup: () => {
          // A later invocation must survive cleanup of an earlier record.
          try {
            if (this.tokens.get(windowId) === record) {
              this.tokens.delete(windowId)
              this.actions.leave(window, previousWindowId)
            }
          } catch (error) {
            record.fail(error)
            throw error
          }
          record.complete()
        },
      })
      this.checkOpening(windowId, record)
      this.actions.enter(window)
      this.checkOpening(windowId, record)
      return this.loop.invoke(record.token)
    } catch (error) {
      try {
        if (this.tokens.get(windowId) === record) this.abort(windowId, requestIdentity)
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Modal Window opening and cleanup failed')
      } finally {
        // When opening itself throws, no token may have been returned. A
        // registered scope runs its cleanup; a pre-registration failure does not.
        if (record.token === undefined && this.tokens.get(windowId) === record) {
          this.tokens.delete(windowId)
          record.fail(error)
        }
      }
      throw error
    }
  }

  private checkOpening(windowId: number, record: WindowModal): void {
    if (
      record.aborted ||
      this.tokens.get(windowId) !== record ||
      record.token === undefined ||
      !this.loop.info(record.token)
    )
      throw new Error('Modal Window opening has ended')
    if (record.window.closing || record.window.finished)
      throw new Error('Window has been invalidated')
  }

  /** A failed new call must never tear down an earlier showModal invocation. */
  abort(windowId: number, requestIdentity: string): boolean {
    const record = this.tokens.get(windowId)
    if (!record || record.requestIdentity !== requestIdentity) return false
    record.aborted = true
    if (record.token !== undefined) {
      this.loop.cancel(record.token, 'modal-opening-aborted')
      // A matching TJS frame normally is topmost. If a descendant is still
      // unwinding, preserve its LIFO cleanup rather than removing its parent.
      if (this.loop.activeToken === record.token) this.loop.release(record.token)
    }
    this.loop.notify()
    return true
  }

  /** A modal Close records a request; only its own loop may prepare the query. */
  requestClose(windowId: number): boolean {
    const record = this.tokens.get(windowId)
    if (!record || record.aborted) return false
    if (!record.queryPending) {
      record.closeRequested = true
      // TForm::Close's mrCancel write is the VCL-based timing inference used
      // here: a new Close may replace an accepted but not yet consumed result.
      record.accepted = false
      this.loop.notify()
    }
    return true
  }

  /** A base onCloseQuery answer can arrive later, or without an active query. */
  respond(windowId: number, canClose: boolean): boolean {
    const record = this.tokens.get(windowId)
    if (!record || record.aborted) return false
    record.queryPending = false
    if (canClose) {
      record.accepted = true
      record.closeRequested = false
    }
    // Original OnCloseQueryCalled(false) only clears Closing, not ModalResult;
    // it cannot retract a preceding accepted result.
    this.loop.notify()
    return true
  }

  beforeWait(token: number): void {
    if (this.loop.activeToken !== token) return
    const record = [...this.tokens.values()].find((entry) => entry.token === token)
    if (!record || record.aborted) return
    if (record.accepted) {
      this.loop.finish(token)
      return
    }
    if (!record.closeRequested || record.queryPending) return
    record.closeRequested = false
    record.queryPending = true
    const generation = ++record.queryGeneration
    const onNotEntered = () => {
      if (
        this.tokens.get(record.window.id) !== record ||
        record.aborted ||
        !record.queryPending ||
        record.queryGeneration !== generation
      )
        return
      record.queryPending = false
      record.closeRequested = true
      this.loop.notify()
    }
    try {
      this.actions.query(record.window, onNotEntered)
    } catch (error) {
      // Synchronous admission failure did not create a pending query. Preserve
      // the request for the caller's retry while keeping any reentrant answer.
      onNotEntered()
      throw error
    }
  }

  /** Explicit invalidation is distinct from temporarily hiding a Window. */
  invalidate(windowId: number): void {
    const record = this.tokens.get(windowId)
    if (!record) return
    record.aborted = true
    if (record.token !== undefined) this.loop.cancel(record.token, 'window-invalidated')
  }
}
