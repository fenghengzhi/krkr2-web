import type { SystemDialogRequest } from '../ports/system-dialogs.ts'
import type { HostReply } from '../script/runtime.ts'
import type { ModalLoop } from '../scheduler/modal-loop.ts'

export interface SystemDialogSnapshot {
  readonly request: SystemDialogRequest | null
  readonly pendingIds: readonly number[]
}

export interface SystemDialogActions {
  /** Host presentation only; this must not execute script. */
  changed(snapshot: SystemDialogSnapshot): void
  /** Host input/focus bookkeeping after the scope opens, before its pump enters. */
  enter?(id: number): void
}

interface Dialog {
  readonly identity: string
  readonly request: SystemDialogRequest
  token?: number
  ready: boolean
  aborted: boolean
  value?: string
}

/** The suspended caller owns its TJS objects; dialog records contain primitives only. */
export class SystemDialogs {
  private readonly records = new Map<string, Dialog>()
  private next = 1
  private published: SystemDialogSnapshot = Object.freeze({
    request: null,
    pendingIds: Object.freeze([]),
  })
  private publicationFailed = false

  constructor(
    private readonly loop: ModalLoop,
    private readonly actions: SystemDialogActions,
  ) {}

  get count(): number {
    return this.records.size
  }

  show(
    identity: string,
    kind: SystemDialogRequest['kind'],
    caption: string,
    text: string,
    value: string,
  ): HostReply {
    if (typeof identity !== 'string' || !identity || this.records.has(identity))
      throw new Error('Invalid system dialog request identity')
    if (
      !['inform', 'input-string'].includes(kind) ||
      typeof caption !== 'string' ||
      typeof text !== 'string' ||
      typeof value !== 'string'
    )
      throw new Error('Invalid system dialog request')
    if (!Number.isSafeInteger(this.next)) throw new Error('System dialog request IDs exhausted')
    const record: Dialog = {
      identity,
      request: Object.freeze({ id: this.next++, kind, caption, text, value }),
      ready: false,
      aborted: false,
    }
    this.records.set(identity, record)
    const cleanup = () => {
      if (this.loop.stopped) this.records.clear()
      else if (this.records.get(identity) === record) this.records.delete(identity)
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
      this.actions.enter?.(record.request.id)
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
    if (this.loop.stopped) this.records.clear()
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
  respond(id: number, value: string | null): boolean {
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
    record.ready = true
    record.value = record.request.kind === 'input-string' && value !== null ? value : undefined
    try {
      this.present()
    } finally {
      this.loop.notify()
    }
    return true
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
