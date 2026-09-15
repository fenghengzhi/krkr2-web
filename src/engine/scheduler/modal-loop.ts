import {
  isScriptObject,
  type HostContext,
  type HostReply,
  type ScriptObject,
  type ScriptValue,
} from '../script/runtime.ts'
import { ExecutionControl } from './control.ts'
import {
  ModalScopes,
  type ModalOutcome,
  type ModalScopeInfo,
  type ModalScopeOptions,
  type ModalValue,
} from './modal-scopes.ts'

export interface ModalLoopDependencies {
  /** Readiness only; it must neither take work nor enter the VM. */
  hasWork(): boolean
  /** A continuation for the existing event pump, including its frame tail. */
  dispatch(): HostReply
  /** Prepare the current scope's close query/result without taking an event or entering the VM. */
  beforeWait?(token: number): void
  /** Host presentation/state bookkeeping only. */
  changed(): void
}

const empty = (): HostReply => ({ kind: 'value', value: undefined })

/** One TJS stack owns every nested scope. JavaScript only waits and selects work. */
export class ModalLoop {
  private readonly scopes = new ModalScopes()
  private readonly invoked = new Set<number>()
  private readonly outcomes = new Map<number, ModalOutcome>()
  private pump?: ScriptObject
  private disposed = false

  constructor(
    private readonly objects: HostContext,
    private readonly control: ExecutionControl,
    private readonly deps: ModalLoopDependencies,
  ) {}

  get activeToken(): number | undefined {
    return this.scopes.top
  }
  get depth(): number {
    return this.scopes.depth
  }
  get pendingWaits(): number {
    return this.scopes.pendingWaits
  }
  info(token: number): ModalScopeInfo | undefined {
    return this.scopes.info(token)
  }
  /** Blocking lasts until the corresponding native/TJS modal frame unwinds. */
  get modalWindowId(): number | undefined {
    for (let token = this.scopes.top; token !== undefined;) {
      const scope = this.scopes.info(token)!
      if (scope.kind === 'window') return scope.windowId ?? scope.ownerId
      token = scope.parentToken
    }
    return undefined
  }

  open(options: ModalScopeOptions): number {
    this.control.check()
    if (this.disposed || !this.pump) throw new Error('Modal dispatcher is unavailable')
    const token = this.scopes.open({
      ...options,
      cleanup: () => {
        this.invoked.delete(token)
        this.outcomes.delete(token)
        const errors: unknown[] = []
        try {
          options.cleanup?.()
        } catch (error) {
          errors.push(error)
        }
        try {
          this.deps.changed()
        } catch (error) {
          errors.push(error)
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, 'Modal scope cleanup failed')
      },
    })
    try {
      this.deps.changed()
    } catch (error) {
      // Failure to publish a newly blocked scope must not leave an invisible
      // modal frame behind. Preserve both errors if cleanup also fails.
      try {
        this.scopes.release(token)
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Modal opening and cleanup failed')
      }
      throw error
    }
    return token
  }

  invoke(token: number): HostReply {
    this.control.check()
    if (!this.pump || this.disposed || !this.scopes.info(token))
      throw new Error('Modal scope has ended')
    if (this.scopes.top !== token || this.invoked.has(token))
      throw new Error('Modal continuation must enter the current scope exactly once')
    this.invoked.add(token)
    return { kind: 'invoke', callback: this.pump, args: [BigInt(token)] }
  }

  finish(token: number, value?: ModalValue): boolean {
    return this.scopes.finish(token, value)
  }
  cancel(token: number, reason?: string): boolean {
    return this.scopes.cancel(token, reason)
  }
  cancelOwner(kind: ModalScopeInfo['kind'], ownerId: number, reason: string): void {
    // Walk a snapshot: ending an ancestor also cancels its descendants, but
    // their records remain until each matching TJS frame unwinds in LIFO order.
    const matching: number[] = []
    for (let token = this.scopes.top; token !== undefined;) {
      const scope = this.scopes.info(token)!
      if (scope.kind === kind && scope.ownerId === ownerId) matching.push(token)
      token = scope.parentToken
    }
    for (const token of matching) this.scopes.cancel(token, reason)
  }
  release(token: number): void {
    this.scopes.release(token)
  }
  notify(): void {
    this.scopes.notify()
  }
  setPaused(paused: boolean): void {
    this.scopes.setPaused(paused)
  }

  async host(operation: string, args: ScriptValue[]): Promise<HostReply> {
    if (operation === 'Modal.end') {
      this.release(this.token(args[0]))
      return empty()
    }
    this.control.check()
    if (this.disposed) throw new Error('Modal dispatcher is unavailable')
    if (operation === 'Modal.bind') {
      if (!isScriptObject(args[0])) throw new Error('Modal pump must be callable')
      const retained = this.objects.retain(args[0]),
        previous = this.pump
      this.pump = retained
      if (previous) this.objects.release(previous)
      return empty()
    }
    const token = this.token(args[0]),
      scope = this.scopes.info(token)
    if (!scope || !this.invoked.has(token)) throw new Error('Modal continuation is not active')
    if (operation === 'Modal.wait') {
      const outcome = await this.scopes.wait(token, () => {
        // The scope installed its wake latch and checked top/paused/terminal
        // state before this hook; it rechecks those facts after the hook too.
        this.deps.beforeWait?.(token)
        return this.deps.hasWork()
      })
      this.control.check()
      if (this.disposed || this.scopes.info(token) !== scope || !this.invoked.has(token))
        throw new Error('Modal scope has ended')
      if (outcome.kind === 'work') return { kind: 'value', value: 1n }
      this.outcomes.set(token, outcome)
      return { kind: 'value', value: 0n }
    }
    if (operation === 'Modal.dispatch')
      return this.scopes.canDispatch(token) ? this.deps.dispatch() : empty()
    if (operation === 'Modal.result') {
      const outcome = this.outcomes.get(token)
      if (!outcome) throw new Error('Modal result is not ready')
      return {
        kind: 'value',
        value:
          outcome.kind === 'completed'
            ? typeof outcome.value === 'boolean'
              ? outcome.value
                ? 1n
                : 0n
              : outcome.value
            : scope.kind === 'menu'
              ? 0n
              : undefined,
      }
    }
    throw new Error(`Unsupported modal operation: ${operation}`)
  }

  private token(value: ScriptValue): number {
    if (
      (typeof value !== 'bigint' && typeof value !== 'number') ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) <= 0
    )
      throw new Error('Invalid modal scope token')
    return Number(value)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const pump = this.pump
    this.pump = undefined
    const errors: unknown[] = []
    try {
      this.scopes.stop()
    } catch (error) {
      errors.push(error)
    }
    this.invoked.clear()
    this.outcomes.clear()
    try {
      if (pump) this.objects.release(pump)
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Modal dispatcher cleanup failed')
  }
}
