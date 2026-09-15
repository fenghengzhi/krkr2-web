/** Completion results never retain a script object or host object handle. */
export type ModalValue = undefined | null | boolean | string | number | bigint

export interface ModalScopeInfo {
  readonly token: number
  readonly parentToken: number | undefined
  readonly kind: 'window' | 'menu'
  readonly ownerId: number
  readonly windowId: number | undefined
}

export interface ModalScopeOptions {
  kind: ModalScopeInfo['kind']
  ownerId: number
  windowId?: number
  /** Synchronous host cleanup only; it must not execute script or return a Promise. */
  cleanup?: () => void
}

export type ModalOutcome =
  | { readonly kind: 'completed'; readonly value: ModalValue }
  | { readonly kind: 'cancelled'; readonly reason: string }

export type ModalWake = ModalOutcome | { readonly kind: 'work'; readonly token: number }

interface Scope {
  readonly info: ModalScopeInfo
  cleanup?: () => void
  outcome?: ModalOutcome
  released: boolean
  waiting: boolean
  wake?: () => void
}

/** Host-only state for a future cooperative TJS pump. No VM execution occurs here. */
export class ModalScopes {
  private readonly scopes = new Map<number, Scope>()
  private readonly stack: Scope[] = []
  private readonly maxDepth: number
  private next = 1
  private paused = false
  private ended = false

  constructor(options: { maxDepth?: number } = {}) {
    const depth = options.maxDepth ?? 16
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 64)
      throw new Error('Modal scope depth must be between 1 and 64')
    this.maxDepth = depth
  }

  get top(): number | undefined {
    return this.stack.at(-1)?.info.token
  }
  get depth(): number {
    return this.stack.length
  }
  get pendingWaits(): number {
    return [...this.scopes.values()].filter((scope) => scope.waiting).length
  }
  get stopped(): boolean {
    return this.ended
  }
  info(token: number): ModalScopeInfo | undefined {
    return this.scopes.get(token)?.info
  }

  open(options: ModalScopeOptions): number {
    if (this.ended) throw new Error('Modal scopes have stopped')
    if (this.stack.length >= this.maxDepth) throw new Error('Modal scope nesting limit exceeded')
    if (
      !['window', 'menu'].includes(options.kind) ||
      !this.validId(options.ownerId) ||
      (options.windowId !== undefined && !this.validId(options.windowId))
    )
      throw new Error('Invalid modal scope identity')
    const parent = this.stack.at(-1)
    if (parent?.outcome) throw new Error('Cannot open a child of an ended modal scope')
    if (!Number.isSafeInteger(this.next)) throw new Error('Modal scope tokens exhausted')
    const token = this.next++
    const scope: Scope = {
      info: Object.freeze({
        token,
        parentToken: parent?.info.token,
        kind: options.kind,
        ownerId: options.ownerId,
        windowId: options.windowId,
      }),
      cleanup: options.cleanup,
      released: false,
      waiting: false,
    }
    this.scopes.set(token, scope)
    this.stack.push(scope)
    // A parent may already be asleep when an external host event opens a child.
    if (parent) this.signal(parent)
    return token
  }

  private validId(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0
  }

  /** Recheck immediately before taking work; a previous work hint may be stale. */
  canDispatch(token: number): boolean {
    const scope = this.scopes.get(token)
    return !!scope && !this.paused && !scope.outcome && this.stack.at(-1) === scope
  }

  finish(token: number, value: ModalValue = undefined): boolean {
    if (
      value !== null &&
      !['undefined', 'boolean', 'string', 'number', 'bigint'].includes(typeof value)
    )
      throw new Error('Modal results must be primitive values')
    return this.end(token, Object.freeze({ kind: 'completed', value }))
  }

  cancel(token: number, reason = 'cancelled'): boolean {
    if (typeof reason !== 'string') throw new Error('Modal cancellation reason must be a string')
    return this.end(token, Object.freeze({ kind: 'cancelled', reason }))
  }

  private end(token: number, outcome: ModalOutcome): boolean {
    const scope = this.scopes.get(token)
    if (!scope || scope.outcome) return false
    scope.outcome = outcome
    const index = this.stack.indexOf(scope)
    // Keep frames until their callers unwind. A parent cannot resume ahead of a
    // child, even when an external event terminates that parent first.
    for (let i = index + 1; i < this.stack.length; i++) {
      const child = this.stack[i]!
      child.outcome ??= Object.freeze({ kind: 'cancelled', reason: 'ancestor-ended' })
    }
    for (let i = this.stack.length - 1; i >= index; i--) this.signal(this.stack[i]!)
    return true
  }

  /** Normal unwinding is strictly LIFO. Removal precedes potentially throwing cleanup. */
  release(token: number): boolean {
    const scope = this.scopes.get(token)
    if (!scope) return false
    if (this.stack.at(-1) !== scope) throw new Error('Release modal scopes in LIFO order')
    this.stack.pop()
    this.scopes.delete(token)
    this.detach(scope, 'released')
    try {
      this.cleanup(scope)
    } finally {
      const parent = this.stack.at(-1)
      if (parent) this.signal(parent)
    }
    return true
  }

  /** Terminal shutdown does not depend on TJS catch/end handlers running. */
  stop(reason = 'stopped'): void {
    if (this.ended) return
    if (typeof reason !== 'string') throw new Error('Modal cancellation reason must be a string')
    this.ended = true
    const removed = this.stack.splice(0).reverse()
    this.scopes.clear()
    // Detach every identity and wake every waiter before any cleanup can throw
    // or reenter. Already recorded outcomes keep their first result.
    for (const scope of removed) this.detach(scope, reason)
    const errors: unknown[] = []
    for (const scope of removed) {
      try {
        this.cleanup(scope)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Modal scope cleanup failed')
  }

  private detach(scope: Scope, reason: string): void {
    scope.released = true
    scope.outcome ??= Object.freeze({ kind: 'cancelled', reason })
    this.signal(scope)
  }

  private cleanup(scope: Scope): void {
    const cleanup = scope.cleanup
    scope.cleanup = undefined
    cleanup?.()
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    const scope = this.stack.at(-1)
    if (scope) this.signal(scope)
  }

  /** Work producers notify after changing readiness. No polling clock is allocated. */
  notify(): void {
    if (this.paused) return
    const scope = this.stack.at(-1)
    if (scope) this.signal(scope)
  }

  private signal(scope: Scope): void {
    const wake = scope.wake
    scope.wake = undefined
    wake?.()
  }

  /**
   * Wait for a terminal result or a work hint. Only the active top scope may
   * inspect readiness; this callback must not take a job or execute script.
   * A future Modal.dispatch must call canDispatch again before taking work.
   */
  async wait(token: number, ready: () => boolean): Promise<ModalWake> {
    const scope = this.scopes.get(token)
    if (!scope) throw new Error('Modal scope is no longer active')
    if (scope.waiting) throw new Error('Modal scope already has a pending wait')
    scope.waiting = true
    try {
      for (;;) {
        // Install the latch before inspecting state. A readiness callback can
        // synchronously notify, finish, pause, release, or open a nested scope.
        const notification = new Promise<void>((resolve) => {
          scope.wake = resolve
        })
        if (scope.released) return scope.outcome!
        if (this.stack.at(-1) === scope) {
          if (scope.outcome) return scope.outcome
          if (!this.paused) {
            const available = ready()
            // A terminal result wins over a simultaneously announced task.
            if (scope.released) return scope.outcome!
            if (this.stack.at(-1) === scope) {
              if (scope.outcome) return scope.outcome
              if (!this.paused && available) return { kind: 'work', token }
            }
          }
        }
        await notification
      }
    } finally {
      scope.waiting = false
      scope.wake = undefined
    }
  }
}
