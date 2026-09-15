import { WindowState } from './window.ts'
import type {
  HostContext,
  HostReply,
  ScriptObject,
  ScriptRuntime,
  ScriptWeakObject,
} from '../script/runtime.ts'

export interface WindowRecord {
  readonly id: number
  readonly state: WindowState
  readonly owner: ScriptWeakObject
  readonly cleanup: ScriptObject
  closing: boolean
  finished: boolean
  resizePending: boolean
  menu: number
  inputActive?: boolean
}

/** Registration, main-window identity and input activation have separate lifetimes. */
export class WindowService {
  private next = 1
  private records = new Map<number, WindowRecord>()
  private current?: WindowRecord
  private primary?: WindowRecord
  private disposed = false
  constructor(
    private readonly objects: ScriptRuntime,
    private readonly created: (window: WindowRecord) => void,
    private readonly beginning: (window: WindowRecord) => Promise<void>,
    private readonly finished: (window: WindowRecord) => void,
  ) {}
  get active(): WindowRecord | undefined {
    return this.current
  }
  get mainId(): number {
    return this.primary?.id ?? 0
  }
  registered(): WindowRecord[] {
    return [...this.records.values()].filter((window) => !window.closing && !window.finished)
  }
  /** Creation order is independent of activation, stacking and property writes. */
  keyTrapper(allowed: (window: WindowRecord) => boolean): WindowRecord | undefined {
    return this.registered()
      .reverse()
      .find((window) => window.state.visible && window.state.trapKey && allowed(window))
  }
  activate(id: number): WindowRecord | undefined {
    const previous = this.current
    if (id === 0) this.current = undefined
    else {
      const window = this.get(id)
      if (window.closing || window.finished) throw new Error('Window has been invalidated')
      this.current = window
    }
    return previous
  }
  /** Class-level query: registration is weak and independent of visibility.
   * Native invalidation unregisters before any asynchronous resource cleanup. */
  get main(): ScriptWeakObject | null {
    const window = this.primary
    return window && !window.closing && !window.finished ? window.owner : null
  }
  get count(): number {
    return this.records.size
  }
  get closing(): number {
    return [...this.records.values()].filter((window) => window.closing).length
  }
  get(id: number): WindowRecord {
    const window = this.records.get(id)
    if (!window) throw new Error('Window has been invalidated')
    return window
  }
  create(owner: ScriptObject, cleanup: ScriptObject, context: HostContext): WindowRecord {
    if (this.disposed) throw new Error('Window service is disposed')
    const id = this.next++,
      retained = context.retain(cleanup),
      previous = this.current,
      first = !this.primary && this.registered().length === 0
    let weak: ScriptWeakObject | undefined
    try {
      weak = this.objects.observe(owner, () => this.retire(id))
      const window: WindowRecord = {
        id,
        owner: weak,
        cleanup: retained,
        state: new WindowState(),
        closing: false,
        finished: false,
        resizePending: false,
        menu: 0,
      }
      this.objects.registerNativeLifetime(owner, 'Window.invalidate', id)
      this.records.set(id, window)
      if (first) this.primary = window
      if (!this.current) this.current = window
      this.created(window)
      return window
    } catch (error) {
      this.records.delete(id)
      if (this.current?.id === id)
        this.current =
          previous &&
          this.records.get(previous.id) === previous &&
          !previous.closing &&
          !previous.finished
            ? previous
            : this.registered()
                .reverse()
                .find((candidate) => candidate.state.visible && candidate.state.focusable)
      if (this.primary?.id === id) this.primary = undefined
      if (weak) this.objects.unobserve(weak)
      context.release(retained)
      throw error
    }
  }
  async invalidate(id: number, owner: ScriptObject): Promise<HostReply> {
    const window = this.records.get(id)
    if (!window || window.finished) return { kind: 'value', value: undefined }
    window.closing = true
    this.unregister(window)
    await this.beginning(window)
    return { kind: 'invoke', callback: window.cleanup, args: [owner, BigInt(id)] }
  }
  finish(id: number): void {
    const window = this.records.get(id)
    if (!window || window.finished) return
    window.finished = true
    window.closing = true
    window.resizePending = false
    this.unregister(window)
    window.state.set('visible', 0)
    this.finished(window)
  }
  private unregister(window: WindowRecord): void {
    if (this.primary === window) this.primary = undefined
    if (this.current === window)
      this.current = this.registered()
        .reverse()
        .find((candidate) => candidate.state.visible && candidate.state.focusable)
  }
  private retire(id: number): void {
    const window = this.records.get(id)
    if (!window) return
    try {
      this.finish(id)
    } finally {
      this.records.delete(id)
      this.objects.unobserve(window.owner)
      this.objects.release(window.cleanup)
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    let primary: unknown,
      failed = false
    for (const id of this.records.keys()) {
      try {
        this.retire(id)
      } catch (error) {
        if (!failed) primary = error
        failed = true
      }
    }
    if (failed) throw primary
  }
}
