import {
  isScriptObject,
  scriptList,
  type HostReply,
  type ScriptObject,
  type ScriptRuntime,
  type ScriptValue,
  type ScriptWeakObject,
} from '../script/runtime.ts'
import { LayerTree } from './layers.ts'
import type { WindowRecord, WindowService } from './windows.ts'

export interface LayerRecord {
  readonly id: number
  readonly owner: ScriptWeakObject
  readonly state: ScriptWeakObject
  readonly window: WindowRecord
  closing: boolean
  finished: boolean
  managerDetached: boolean
}
interface FontRecord {
  readonly id: number
  readonly owner: ScriptWeakObject
  readonly layer: LayerRecord
}

/** A native Layer owns action/font/cache state, but its basic tree edges are raw
 * observations. Input and transition services own their additional references. */
export class LayerService {
  private records = new Map<number, LayerRecord>()
  private fonts = new Map<number, FontRecord>()
  private managers = new Map<number, WindowRecord>()
  private nextFont = 1
  private cleanup?: ScriptObject
  constructor(
    private readonly objects: ScriptRuntime,
    private readonly tree: LayerTree,
    private readonly windows: WindowService,
    private readonly beginning: (layer: LayerRecord) => void,
    private readonly retired: (layer: LayerRecord) => void,
  ) {}
  get count(): number {
    return this.records.size
  }
  get closing(): number {
    return [...this.records.values()].filter((layer) => layer.closing).length
  }
  get fontCount(): number {
    return this.fonts.size
  }
  bind(cleanup: ScriptObject): void {
    if (this.cleanup) throw new Error('Layer cleanup is already bound')
    this.cleanup = this.objects.retain(cleanup)
  }
  get(id: number): LayerRecord {
    const layer = this.records.get(id)
    if (!layer || layer.finished) throw new Error('Layer has been invalidated')
    return layer
  }
  cast(value: ScriptValue): LayerRecord {
    if (!isScriptObject(value)) throw new Error('Expected a Layer instance')
    const id = this.objects.nativeLifetimeIdentifier(value, 'Layer.invalidate')
    if (id === undefined) throw new Error('Expected a Layer instance')
    return this.get(id)
  }
  owner(id: number): ScriptWeakObject | undefined {
    return this.records.get(id)?.owner
  }
  eventOwner(id: number): ScriptWeakObject | undefined {
    const layer = this.records.get(id)
    return layer && !layer.closing ? layer.owner : undefined
  }
  isClosing(id: number): boolean {
    return this.records.get(id)?.closing ?? true
  }
  create(
    owner: ScriptObject,
    windowValue: ScriptValue,
    parentValue: ScriptValue,
    state: ScriptObject,
  ): number {
    const existing = this.objects.nativeLifetimeIdentifier(owner, 'Layer.invalidate')
    if (existing !== undefined) return existing
    if (!isScriptObject(windowValue)) throw new Error('Expected a Window instance')
    const windowId = this.objects.nativeLifetimeIdentifier(windowValue, 'Window.invalidate')
    if (windowId === undefined) throw new Error('Expected a Window instance')
    const actionWindow = this.windows.get(windowId)
    if (actionWindow.finished || actionWindow.closing)
      throw new Error('Window has been invalidated')
    const parent = parentValue === null ? undefined : this.cast(parentValue)
    if (parent?.closing || parent?.managerDetached)
      throw new Error('Cannot attach to an invalidating Layer')
    const id = this.tree.create(parent?.id ?? 0, actionWindow.id)
    let weak: ScriptWeakObject | undefined, privateState: ScriptWeakObject | undefined
    try {
      weak = this.objects.observe(owner, () => this.finish(id))
      privateState = this.objects.observe(state, () => {})
      const layer: LayerRecord = {
        id,
        owner: weak,
        state: privateState,
        window: parent ? this.managers.get(this.tree.get(parent.id).managerId)! : actionWindow,
        closing: false,
        finished: false,
        managerDetached: false,
      }
      this.objects.registerNativeLifetime(owner, 'Layer.invalidate', id, state)
      this.records.set(id, layer)
      if (!parent) this.managers.set(id, actionWindow)
      return id
    } catch (error) {
      if (weak) this.objects.unobserve(weak)
      if (privateState) this.objects.unobserve(privateState)
      this.tree.destroy(id)
      throw error
    }
  }
  relation(id: number, name: string): ScriptValue {
    const layer = this.get(id),
      node = this.tree.get(id)
    if (name === 'parent') return this.owner(node.parent) ?? null
    if (name === 'window') {
      if (layer.managerDetached) return null
      const window = this.managers.get(node.managerId) ?? layer.window
      return !window.finished ? window.owner : null
    }
    throw new Error('Unsupported Layer relation')
  }
  children(id: number): ScriptValue {
    this.get(id)
    return scriptList(this.tree.get(id).children.map((child) => this.owner(child) ?? null))
  }
  parent(id: number, value: ScriptValue): number {
    const layer = this.get(id),
      parent = value === null ? undefined : this.cast(value)
    if (layer.closing || layer.managerDetached || parent?.closing || parent?.managerDetached)
      throw new Error('Cannot reparent an invalidating Layer')
    this.tree.validateParent(id, parent?.id ?? 0)
    return parent?.id ?? 0
  }
  invalidate(id: number, owner: ScriptObject): HostReply {
    const layer = this.records.get(id)
    if (!layer || layer.finished) return { kind: 'value', value: undefined }
    if (!this.cleanup) throw new Error('Layer cleanup is not bound')
    layer.closing = true
    this.beginning(layer)
    return { kind: 'invoke', callback: this.cleanup, args: [owner, BigInt(id), layer.state] }
  }
  abort(id: number): void {
    const layer = this.records.get(id)
    if (layer) layer.closing = false
  }
  detachManager(id: number): void {
    this.get(id).managerDetached = true
  }
  finish(id: number): void {
    const layer = this.records.get(id)
    if (!layer) return
    const manager = this.tree.has(id) ? this.tree.get(id).managerId : undefined
    layer.finished = true
    this.records.delete(id)
    this.retired(layer)
    if (this.tree.has(id)) this.tree.destroy(id)
    if (
      manager !== undefined &&
      !this.tree.ids().some((id) => this.tree.get(id).managerId === manager)
    )
      this.managers.delete(manager)
    this.objects.unobserve(layer.owner)
    this.objects.unobserve(layer.state)
  }
  bindFont(owner: ScriptObject, layerValue: ScriptValue): void {
    if (this.objects.nativeLifetimeIdentifier(owner, 'Font.invalidate') !== undefined) return
    const layer = this.cast(layerValue),
      id = this.nextFont++
    const weak = this.objects.observe(owner, () => this.finishFont(id))
    try {
      this.objects.registerNativeLifetime(owner, 'Font.invalidate', id)
      this.fonts.set(id, { id, owner: weak, layer })
    } catch (error) {
      this.objects.unobserve(weak)
      throw error
    }
  }
  fontState(owner: ScriptValue): ScriptWeakObject {
    if (!isScriptObject(owner)) throw new Error('Expected a Font instance')
    const id = this.objects.nativeLifetimeIdentifier(owner, 'Font.invalidate')
    const font = id === undefined ? undefined : this.fonts.get(id)
    if (!font || font.layer.finished) throw new Error('Font has no live Layer')
    return font.layer.state
  }
  finishFont(id: number): void {
    const font = this.fonts.get(id)
    if (!font) return
    this.fonts.delete(id)
    this.objects.unobserve(font.owner)
  }
  dispose(): void {
    for (const id of this.records.keys()) this.finish(id)
    for (const id of this.fonts.keys()) this.finishFont(id)
    if (this.cleanup) this.objects.release(this.cleanup)
    this.cleanup = undefined
    this.managers.clear()
  }
}
