import {
  isScriptObject,
  scriptRecord,
  type HostReply,
  type ScriptObject,
  type ScriptRuntime,
  type ScriptValue,
  type ScriptWeakObject,
} from '../script/runtime.ts'
import { MenuTree } from './menus.ts'
import type { WindowRecord, WindowService } from './windows.ts'

export interface MenuRecord {
  readonly id: number
  readonly view: number
  readonly owner: ScriptWeakObject
  readonly state: ScriptWeakObject
  readonly window?: WindowRecord
  parent?: MenuRecord
  readonly children: Map<number, MenuRecord>
  nextSlot: number
  closing: boolean
  finished: boolean
}

/** Script references belong to the native instance's private state dictionary.
 * These records contain only observations and display/registration metadata. */
export class MenuService {
  private records = new Map<number, MenuRecord>()
  private views = new Map<number, MenuRecord>()
  private next = 1
  private cleanup?: ScriptObject
  constructor(
    private readonly objects: ScriptRuntime,
    private readonly tree: MenuTree,
    private readonly windows: WindowService,
    private readonly cancel: (source: MenuRecord) => void,
  ) {}
  get count(): number {
    return this.records.size
  }
  bind(cleanup: ScriptObject): void {
    if (this.cleanup) throw new Error('Menu cleanup is already bound')
    this.cleanup = this.objects.retain(cleanup)
  }
  create(owner: ScriptObject, state: ScriptObject, captionOrWindow: ScriptValue): number {
    let window: WindowRecord | undefined
    if (typeof captionOrWindow === 'object') {
      if (!isScriptObject(captionOrWindow)) throw new Error('Expected a Window instance')
      const id = this.objects.nativeLifetimeIdentifier(captionOrWindow, 'Window.invalidate')
      if (id === undefined) throw new Error('Expected a Window instance')
      window = this.windows.get(id)
      if (window.finished || window.closing) throw new Error('Window has been invalidated')
    }
    if (this.records.size >= 4096) throw new Error('Menu item budget exceeded')
    const id = this.next++,
      createdView = !window?.menu,
      view = window?.menu || this.tree.create(window ? '' : String(captionOrWindow ?? ''))
    let observation: ScriptWeakObject | undefined, privateState: ScriptWeakObject | undefined
    try {
      observation = this.objects.observe(owner, () => this.finish(id))
      privateState = this.objects.observe(state, () => {})
      const item: MenuRecord = {
        id,
        view,
        owner: observation,
        state: privateState,
        window,
        children: new Map(),
        nextSlot: 0,
        closing: false,
        finished: false,
      }
      this.objects.registerNativeLifetime(owner, 'Menu.invalidate', id, state)
      this.records.set(id, item)
      if (window) {
        window.menu = view
        this.tree.setRoot(view, window.id)
      } else this.views.set(view, item)
      return id
    } catch (error) {
      if (observation) this.objects.unobserve(observation)
      if (privateState) this.objects.unobserve(privateState)
      if (createdView && this.tree.has(view)) this.tree.detach(view)
      throw error
    }
  }
  /** Casting consults the native slot even for an explicitly invalid object. */
  cast(value: ScriptValue): MenuRecord | undefined {
    if (!isScriptObject(value)) throw new Error('Expected a MenuItem instance')
    const id = this.objects.nativeLifetimeIdentifier(value, 'Menu.invalidate')
    if (id === undefined) throw new Error('Expected a MenuItem instance')
    return this.records.get(id)
  }
  get(value: ScriptValue): MenuRecord {
    const item = this.cast(value)
    if (!item || item.finished) throw new Error('MenuItem has been invalidated')
    return item
  }
  byView(id: number): MenuRecord | undefined {
    return this.views.get(id)
  }
  windowByView(id: number): WindowRecord | undefined {
    const windowId = this.tree.windowId(id)
    if (windowId === undefined) return
    return this.windows.registered().find((window) => window.id === windowId)
  }
  state(value: ScriptValue): ScriptWeakObject {
    return this.get(value).state
  }
  relation(value: ScriptValue, relation: string): ScriptValue {
    let item = this.get(value)
    if (relation === 'window')
      return item.window && !item.window.finished ? item.window.owner : null
    if (relation === 'parent')
      return item.parent && !item.parent.finished ? item.parent.owner : null
    if (relation !== 'root') throw new Error('Unknown menu relation')
    while (item.parent && !item.parent.finished) item = item.parent
    return item.owner
  }
  insert(parentValue: ScriptValue, childValue: ScriptValue, index?: number): ScriptValue {
    const parent = this.get(parentValue),
      child = this.cast(childValue)
    if (!child || !this.tree.has(child.view) || !this.tree.has(parent.view)) return null
    if (parent.closing || child.closing) throw new Error('Cannot insert a menu during invalidation')
    if (child.window) throw new Error('Cannot reparent the window menu')
    if (parent.nextSlot >= 65536) throw new Error('Menu registration budget exceeded')
    const oldParent = child.parent,
      oldSlot = oldParent && [...oldParent.children].find(([, value]) => value === child)?.[0]
    this.tree.insert(parent.view, child.view, index ?? this.tree.get(parent.view).children.length)
    // Moving the visual index does not change native registration order/cache.
    if (oldParent === parent) return null
    if (oldParent && oldSlot !== undefined) oldParent.children.delete(oldSlot)
    const slot = parent.nextSlot++
    parent.children.set(slot, child)
    child.parent = parent
    return scriptRecord({
      state: parent.state,
      slot,
      child: child.owner,
      oldState: oldParent?.state ?? null,
      oldSlot: oldSlot ?? -1,
    })
  }
  remove(parentValue: ScriptValue, childValue: ScriptValue): ScriptValue {
    const parent = this.get(parentValue),
      child = this.cast(childValue)
    // Native Remove guards the platform pointer before consulting membership.
    if (!child || !this.tree.has(child.view) || !this.tree.has(parent.view)) return null
    this.tree.remove(parent.view, child.view)
    const slot = [...parent.children].find(([, value]) => value === child)?.[0]
    if (slot === undefined) return null
    parent.children.delete(slot)
    if (child.parent === parent) child.parent = undefined
    return scriptRecord({ state: parent.state, slot })
  }
  index(value: ScriptValue, index?: number): number {
    const item = this.get(value),
      node = this.tree.get(item.view)
    if (!node.parent) {
      if (index !== undefined) throw new Error('MenuItem has no parent')
      return -1
    }
    if (index !== undefined) this.tree.insert(node.parent, item.view, index)
    return this.tree.get(node.parent).children.indexOf(item.view)
  }
  invalidate(id: number, owner: ScriptObject): HostReply {
    const item = this.records.get(id)
    if (!item || item.finished) return { kind: 'value', value: undefined }
    if (!this.cleanup) throw new Error('Menu cleanup is not bound')
    item.closing = true
    this.cancel(item)
    return { kind: 'invoke', callback: this.cleanup, args: [owner, id, item.state, item.nextSlot] }
  }
  abort(id: number): void {
    const item = this.records.get(id)
    if (item) item.closing = false
  }
  releaseSlot(id: number, slot: number): void {
    const item = this.records.get(id),
      child = item?.children.get(slot)
    if (child && child.parent === item) child.parent = undefined
    item?.children.delete(slot)
  }
  finish(id: number): void {
    const item = this.records.get(id)
    if (!item) return
    item.finished = true
    this.records.delete(id)
    this.cancel(item)
    item.parent = undefined
    for (const child of item.children.values()) if (child.parent === item) child.parent = undefined
    item.children.clear()
    if (!item.window) {
      this.views.delete(item.view)
      if (this.tree.has(item.view)) this.tree.detach(item.view)
    }
    this.objects.unobserve(item.owner)
    this.objects.unobserve(item.state)
  }
  disconnectWindow(window: WindowRecord): void {
    for (const item of this.records.values()) {
      if (item.window === window) this.cancel(item)
    }
    if (window.menu && this.tree.has(window.menu)) this.tree.detach(window.menu)
  }
  dispose(): void {
    for (const id of this.records.keys()) this.finish(id)
    if (this.cleanup) this.objects.release(this.cleanup)
    this.cleanup = undefined
  }
}
