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
}

/** Native window lifetime is separate from the currently displayed window. */
export class WindowService {
  private next = 1
  private records = new Map<number, WindowRecord>()
  private current?: WindowRecord
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
  /** Class-level query: registration is weak and independent of visibility.
   * Native invalidation unregisters before any asynchronous resource cleanup. */
  get main(): ScriptWeakObject | null {
    const window = this.current
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
    if (this.current) throw new Error('Multiple active Window instances are not yet supported')
    const id = this.next++,
      retained = context.retain(cleanup)
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
      this.current = window
      this.created(window)
      return window
    } catch (error) {
      this.records.delete(id)
      if (this.current?.id === id) this.current = undefined
      if (weak) this.objects.unobserve(weak)
      context.release(retained)
      throw error
    }
  }
  async invalidate(id: number, owner: ScriptObject): Promise<HostReply> {
    const window = this.records.get(id)
    if (!window || window.finished) return { kind: 'value', value: undefined }
    window.closing = true
    if (this.current === window) this.current = undefined
    await this.beginning(window)
    return { kind: 'invoke', callback: window.cleanup, args: [owner, BigInt(id)] }
  }
  finish(id: number): void {
    const window = this.records.get(id)
    if (!window || window.finished) return
    window.finished = true
    window.closing = true
    window.resizePending = false
    if (this.current === window) this.current = undefined
    window.state.set('visible', 0)
    this.finished(window)
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
