import type { SystemDialogRequest } from '../ports/system-dialogs.ts'
import type { HostReply } from '../script/runtime.ts'
import type { ModalLoop } from '../scheduler/modal-loop.ts'
import type { StorageSelectorDirectory, StorageSelectorPresentation } from '../ports/storage-selector.ts'

export interface SystemDialogSnapshot {
  readonly request: SystemDialogRequest | null
  readonly pendingIds: readonly number[]
}

export interface SystemDialogActions {
  /** Host presentation only; this must not execute script. */
  changed(snapshot: SystemDialogSnapshot): void
  /** Host input/focus bookkeeping after the scope opens, before its pump enters. */
  enter?(id: number, kind: SystemDialogRequest['kind']): void
}

interface Dialog {
  readonly identity: string
  readonly request: SystemDialogRequest
  token?: number
  ready: boolean
  aborted: boolean
  value?: string
  readonly choose?: (value: string) => string | Promise<string>
  readonly browse?: (directory: string) => Promise<StorageSelectorDirectory>
  readonly waiters: Set<() => void>
  choosing?: boolean
  browsing?: boolean
  abandoned?: boolean
}

/** The suspended caller owns its TJS objects. Records retain only host data and
 * validation callbacks; they never own a ScriptObject or execute script. */
export class SystemDialogs {
  private readonly records = new Map<string, Dialog>()
  private next = 1
  private published: SystemDialogSnapshot = Object.freeze({
    request: null,
    pendingIds: Object.freeze([]),
  })
  private publicationFailed = false
  private releasingAbandoned = false

  constructor(
    private readonly loop: ModalLoop,
    private readonly actions: SystemDialogActions,
  ) {}

  get count(): number {
    return this.records.size
  }

  show(
    identity: string,
    kind: 'inform' | 'input-string',
    caption: string,
    text: string,
    value: string,
  ): HostReply {
    if (
      !['inform', 'input-string'].includes(kind) ||
      typeof caption !== 'string' ||
      typeof text !== 'string' ||
      typeof value !== 'string'
    )
      throw new Error('Invalid system dialog request')
    return this.open(identity, (id) => Object.freeze({ id, kind, caption, text, value }))
  }

  showStorageSelector(
    identity: number,
    caption: string,
    selector: StorageSelectorPresentation,
    choose: (value: string) => string | Promise<string>,
    browse?: (directory: string) => Promise<StorageSelectorDirectory>,
  ): HostReply {
    if (!Number.isSafeInteger(identity) || identity <= 0)
      throw new Error('Invalid native storage selector identity')
    return this.open(
      `storage-selector:${identity}`,
      (id) =>
        Object.freeze({
          id,
          kind: 'storage-selector',
          caption,
          text: selector.save ? '选择游戏内的存档位置。' : '选择已载入游戏或浏览器存档中的文件。',
          value: '',
          selector,
        }),
      choose,
      browse,
    )
  }

  private open(
    identity: string,
    request: (id: number) => SystemDialogRequest,
    choose?: (value: string) => string | Promise<string>,
    browse?: (directory: string) => Promise<StorageSelectorDirectory>,
  ): HostReply {
    if (typeof identity !== 'string' || !identity || this.records.has(identity))
      throw new Error('Invalid system dialog request identity')
    if (!Number.isSafeInteger(this.next)) throw new Error('System dialog request IDs exhausted')
    const record: Dialog = {
      identity,
      request: request(this.next++),
      ready: false,
      aborted: false,
      choose,
      browse,
      waiters: new Set(),
    }
    this.records.set(identity, record)
    const cleanup = () => {
      if (this.loop.stopped) {
        for (const current of this.records.values()) this.cancelWaiters(current)
        this.records.clear()
      } else if (this.records.get(identity) === record) {
        this.cancelWaiters(record)
        this.records.delete(identity)
      }
      // ModalLoop publishes only after this cleanup. On Stop every request
      // identity is removed before the first external publication can reenter.
    }
    try {
      record.token = this.loop.open({
        kind: 'system-dialog',
        ownerId: record.request.id,
        cleanup,
      })
      this.assertOpening(record)
      this.actions.enter?.(record.request.id, record.request.kind)
      this.assertOpening(record)
      return this.loop.invoke(record.token)
    } catch (error) {
      try {
        if (this.records.get(identity) === record) {
          if (this.scopeToken(record) === undefined) cleanup()
          else this.abort(identity)
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'System dialog opening and cleanup failed')
      }
      throw error
    }
  }

  private assertOpening(record: Dialog): void {
    if (
      record.aborted ||
      this.records.get(record.identity) !== record ||
      record.token === undefined ||
      !this.loop.isPending(record.token)
    )
      throw new Error('System dialog opening has ended')
  }

  /** Publish again whenever the shared modal stack changes. */
  present(): void {
    // A Window/Menu child can be the first scope cleaned up by Stop. Revoke
    // every dialog identity before that child's stack-change publication too.
    if (this.loop.stopped) {
      for (const record of this.records.values()) this.cancelWaiters(record)
      this.records.clear()
    }
    this.releaseAbandoned()
    const top = this.loop.activeToken,
      active = [...this.records.values()].find(
        (record) => this.scopeToken(record) === top && top !== undefined,
      ),
      snapshot: SystemDialogSnapshot = Object.freeze({
        request:
          active &&
          !active.ready &&
          !active.aborted &&
          top !== undefined &&
          this.loop.isPending(top)
            ? active.request
            : null,
        pendingIds: Object.freeze([...this.records.values()].map((record) => record.request.id)),
      }),
      previous = this.published
    if (
      !this.publicationFailed &&
      snapshot.request === previous.request &&
      snapshot.pendingIds.length === previous.pendingIds.length &&
      snapshot.pendingIds.every((id, index) => id === previous.pendingIds[index])
    )
      return
    // Install before calling outward: a publication can synchronously Stop,
    // abort, or publish again. Never overwrite that newer nested snapshot.
    this.published = snapshot
    this.publicationFailed = false
    try {
      this.actions.changed(snapshot)
    } catch (error) {
      // The receiver may already have changed the UI before throwing. Its
      // failed snapshot must still be followed by cleanup, or retried later.
      if (this.published === snapshot) this.publicationFailed = true
      throw error
    }
  }

  /** A UI response chooses a primitive result; only its own wait may end the modal frame. */
  respond(id: number, value: string | null, available: () => boolean = () => true): boolean | Promise<boolean> {
    if (!Number.isSafeInteger(id) || id <= 0 || (value !== null && typeof value !== 'string'))
      return false
    const record = [...this.records.values()].find((entry) => entry.request.id === id),
      token = record && this.scopeToken(record)
    if (
      !record ||
      record.ready ||
      record.aborted ||
      token === undefined ||
      !this.loop.isPending(token) ||
      token !== this.loop.activeToken
    )
      return false
    if (value !== null && record.choosing) return false
    // A selector validates the current namespace before accepting a response.
    // A failed choice leaves the same modal request available for correction.
    const selected =
      value === null
        ? undefined
        : (record.choose?.(value) ?? (record.request.kind === 'input-string' ? value : undefined))
    if (selected instanceof Promise) {
      record.choosing = true
      return this.wait(record, selected).then((result) => {
        if (!result || !available() || !this.active(record)) return false
        return this.accept(record, result.value)
      }, (error: unknown) => {
        if (!available() || !this.active(record)) return false
        throw error
      }).finally(() => { record.choosing = false })
    }
    return this.accept(record, selected)
  }

  private accept(record: Dialog, value: string | undefined): boolean {
    record.ready = true
    record.value = value
    this.cancelWaiters(record)
    try {
      this.present()
    } finally {
      this.loop.notify()
    }
    return true
  }

  /** Direct host RPC while the script is suspended in this exact selector.
   * Directory reads never enter the VM or retire its modal scope. */
  async browse(id: number, directory: string, available: () => boolean = () => true): Promise<StorageSelectorDirectory | null> {
    if (!Number.isSafeInteger(id) || id <= 0 || typeof directory !== 'string' || directory.length > 4096)
      throw new Error('Invalid file selector directory request')
    const record = [...this.records.values()].find((entry) => entry.request.id === id)
    if (!record || !record.browse || !this.active(record) || !available()) return null
    if (record.browsing) throw new Error('File selector directory read is already running')
    record.browsing = true
    try {
      const result = await this.wait(record, record.browse(directory))
      return result && available() && this.active(record) ? result.value : null
    } catch (error) {
      if (!available() || !this.active(record)) return null
      throw error
    } finally { record.browsing = false }
  }

  private active(record: Dialog): boolean {
    const token = this.scopeToken(record)
    return this.records.get(record.identity) === record && !record.ready && !record.aborted &&
      token !== undefined && token === this.loop.activeToken && this.loop.isPending(token)
  }

  private cancelWaiters(record: Dialog): void {
    for (const cancel of record.waiters) cancel()
    record.waiters.clear()
  }

  private async wait<T>(record: Dialog, operation: Promise<T>): Promise<{ value: T } | null> {
    let cancel!: () => void
    const cancelled = new Promise<null>((resolve) => { cancel = () => resolve(null) })
    record.waiters.add(cancel)
    try {
      // Both branches stay observed after cancellation; late I/O failures
      // cannot become unhandled rejections or publish into a newer dialog.
      return await Promise.race([operation.then((value) => ({ value })), cancelled])
    } finally { record.waiters.delete(cancel) }
  }

  beforeWait(token: number): void {
    if (this.loop.activeToken !== token) return
    const record = [...this.records.values()].find((entry) => entry.token === token)
    if (record?.ready && !record.aborted) this.loop.finish(token, record.value)
  }

  /** Also releases a request if native argument cleanup fails before invoke enters the pump. */
  abort(identity: string): boolean {
    const record = this.records.get(identity)
    if (!record || record.aborted) return false
    record.aborted = true
    this.cancelWaiters(record)
    const token = this.scopeToken(record)
    try {
      if (token !== undefined) {
        this.loop.cancel(token, 'system-dialog-opening-aborted')
        if (this.loop.activeToken === token) this.loop.release(token)
        else this.present()
      }
    } finally {
      this.loop.notify()
    }
    return true
  }

  /** The native caller can fail before the TJS pump's body/finally is entered.
   * Its unique call identity, rather than the current top scope, owns cleanup. */
  abortStorageSelector(identity: number): boolean {
    if (!Number.isSafeInteger(identity) || identity <= 0)
      throw new Error('Invalid native storage selector identity')
    const key = `storage-selector:${identity}`,
      record = this.records.get(key)
    if (!record) return false
    record.abandoned = true
    const errors: unknown[] = []
    try {
      this.abort(key)
    } catch (error) {
      errors.push(error)
    }
    try {
      this.releaseAbandoned()
    } catch (error) {
      errors.push(error)
    }
    try {
      this.present()
    } catch (error) {
      errors.push(error)
    } finally {
      this.loop.notify()
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Storage selector cleanup failed')
    return true
  }

  private releaseAbandoned(): void {
    if (this.releasingAbandoned) return
    this.releasingAbandoned = true
    const errors: unknown[] = []
    try {
      for (;;) {
        const top = this.loop.activeToken,
          record = [...this.records.values()].find(
            (entry) => entry.abandoned && entry.aborted && this.scopeToken(entry) === top,
          )
        if (!record || top === undefined || this.loop.isPending(top)) break
        // A live child must unwind first. Its normal release publication calls
        // present again, at which point this exact abandoned parent can retire.
        try {
          this.loop.release(top)
        } catch (error) {
          errors.push(error)
        }
      }
    } finally {
      this.releasingAbandoned = false
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Abandoned selector cleanup failed')
  }

  private scopeToken(record: Dialog): number | undefined {
    if (record.token !== undefined) return this.loop.info(record.token)?.token
    // ModalLoop.open publishes synchronously before returning its token. Match
    // that opening scope so a reentrant Stop/abort can still identify it.
    for (let token = this.loop.activeToken; token !== undefined;) {
      const scope = this.loop.info(token)!
      if (scope.kind === 'system-dialog' && scope.ownerId === record.request.id) return token
      token = scope.parentToken
    }
    return undefined
  }
}
