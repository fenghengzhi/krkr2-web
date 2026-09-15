import type { HostReply } from '../script/runtime.ts'
import type { ModalLoop } from '../scheduler/modal-loop.ts'
import type { MenuRecord } from './menu-items.ts'
import type { MenuPopupHandle, MenuTree } from './menus.ts'

interface MenuModal {
  readonly item: MenuRecord
  readonly identity: string
  readonly handle: MenuPopupHandle
  readonly flags: number
  token?: number
  selected: number
  ready: boolean
  returning: boolean
  aborted: boolean
}

/** The TJS caller owns its objects; these records retain only host metadata. */
export class MenuModals {
  private readonly records = new Map<string, MenuModal>()

  constructor(
    private readonly tree: MenuTree,
    private readonly loop: ModalLoop,
    private readonly notifySelection: (view: number) => void,
  ) {}

  get count(): number {
    return this.records.size
  }

  show(item: MenuRecord, identity: string, flags: number, x: number, y: number): HostReply {
    if (!identity || this.records.has(identity)) throw new Error('Invalid popup request identity')
    const handle = this.tree.beginPopup(item.view, flags, x, y)
    if (!handle) return { kind: 'value', value: 0n }
    const record: MenuModal = {
      item,
      identity,
      handle,
      flags,
      selected: 0,
      ready: false,
      returning: false,
      aborted: false,
    }
    this.records.set(identity, record)
    // A settled menu may still have a Window or another menu above it. Only
    // its own wait boundary is allowed to finish that modal frame.
    void handle.result.then((selected) => {
      if (this.records.get(identity) !== record || record.aborted) return
      record.selected = selected
      record.ready = true
      this.loop.notify()
    })
    const cleanup = () => {
      if (this.records.get(identity) !== record) return
      this.records.delete(identity)
      this.tree.releasePopup(handle.popup)
      // This only enqueues input. The modal TJS function first returns to its
      // caller; a subsequent event-pump boundary may then invoke onClick.
      if (
        record.returning &&
        !record.aborted &&
        !this.loop.stopped &&
        record.selected &&
        !(flags & 0x180)
      )
        this.notifySelection(record.selected)
    }
    try {
      record.token = this.loop.open({
        kind: 'menu',
        ownerId: item.id,
        windowId: handle.popup.windowId,
        cleanup,
      })
      if (record.aborted || this.records.get(identity) !== record || !this.loop.info(record.token))
        throw new Error('Popup opening has ended')
      return this.loop.invoke(record.token)
    } catch (error) {
      try {
        if (record.token === undefined) cleanup()
        else this.abort(identity)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Popup opening and cleanup failed')
      }
      throw error
    }
  }

  beforeWait(token: number): void {
    if (this.loop.activeToken !== token) return
    const record = [...this.records.values()].find((entry) => entry.token === token)
    if (!record || !record.ready || record.aborted) return
    const { handle, flags } = record
    // Ordinary selection and explicit dismissal use a BOOL. A Window/lifecycle
    // cancellation is distinguished from the observed Win32 Esc dismissal.
    const result =
      handle.outcome === 'unavailable' ? 0 : flags & 0x100 ? (handle.selectedCommand ?? 0) : 1
    record.returning = this.loop.finish(token, BigInt(result))
  }

  /** Also handles a native release failure before the returned pump is entered. */
  abort(identity: string): boolean {
    const record = this.records.get(identity)
    if (!record) return false
    record.aborted = true
    this.tree.dismiss(record.handle.popup.windowId, record.handle.popup.requestId, 'unavailable')
    if (record.token !== undefined) {
      this.loop.cancel(record.token, 'popup-opening-aborted')
      if (this.loop.activeToken === record.token) this.loop.release(record.token)
    }
    this.loop.notify()
    return true
  }
}
