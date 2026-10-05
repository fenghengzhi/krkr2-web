import { LayerTree } from '../scene/layers.ts'
import type { WindowView } from '../scene/window.ts'
import {
  deviceInt,
  drawDeviceGeometry,
  fromPrimary,
  paintBoxPoint,
  toPrimary,
  type DevicePoint,
} from '../scene/draw-device.ts'
import {
  shiftButtons,
  type InputAttention,
  type InputPacket,
  type InputView,
} from '../ports/input.ts'
import type { ScriptObject, ScriptValue } from '../script/runtime.ts'
export interface LayerRef {
  layer: number
}
export type InputValue = string | number | boolean | null | undefined | LayerRef
export interface InputCall {
  kind?: 'call'
  target: number
  method: string
  args: InputValue[]
}
export interface InputOwnershipStep {
  kind: 'ownership'
  key: string
  layer: number
  /** Copy an existing VM-owned reference after native invalidation retired
   * its tree/weak registration. This does not create a host-side retain. */
  sourceKey?: string
  /** Resolve this operation's destruction-only identity in the VM. Acquisition
   * is committed only after the pump acknowledges a non-null assigned value. */
  identity?: boolean
}
export interface InputInvocation {
  kind: 'invoke'
  callback: ScriptObject
  args: ScriptValue[]
  /** Cleanup helpers must still run while the outer operation is unwinding. */
  unwind?: boolean
}
export type InputStep = InputCall | InputOwnershipStep | InputInvocation
export type InputOperation = Generator<InputStep, InputValue, unknown>
const ref = (layer: number): LayerRef => ({ layer })
export class InputController {
  epoch = 0
  /** Focus/modal leases survive a transient packet reset, but never a manager clear. */
  ownershipEpoch = 0
  focused = 0
  /** Monotonic logical focus identity, including changes within one script entry. */
  focusRevision = 0
  modal: number[] = []
  capture = 0
  hover = 0
  point = { x: -1, y: -1 }
  shift = 0
  // Native manager notifications hit-test the last delivered primary integer
  // sample, independently of later Window transforms or physical observations.
  private lastMousePrimary = { x: -1, y: -1 }
  private currentCursor = 0
  private currentHint = ''
  private notifyingHintOrCursor = false
  private mouseDepth = 0
  private hitDepth = 0
  private hitChoice = new Map<number, boolean>()
  keys = new Set<number>()
  private focusLock = false
  private choice = new Map<number, number>()
  private released = false
  private touchCapture = new Map<number, number>()
  private releasedTouches = new Set<number>()
  private enabledDepth = 0
  private enabledBefore = new Map<number, boolean>()
  private rawEnabledBefore = new Map<number, boolean>()
  private enabledTraversal = false
  // Numeric bookkeeping never owns a script object. The corresponding values
  // live in the Input pump's private Dictionary and change only at VM yields.
  private owners = new Map<string, number>()
  private pendingOwnership: InputOwnershipStep[] = []
  private detaching = new Set<number>()
  // This is a primary-coordinate sample, not a live tree projection. Native
  // ancestor/geometry changes do not refresh the manager's attention point.
  // All identities and font fields are values, without script ownership.
  private attention: InputAttention | null = null
  constructor(
    readonly layers: LayerTree,
    private readonly window: () => WindowView,
    private readonly windowId?: () => number,
  ) {}
  get sourceWindowId(): number {
    return this.windowId?.() ?? 0
  }
  private manager(id: number): number {
    return this.layers.has(id) ? this.layers.get(id).managerId : 0
  }
  private ownerManager(role: string, id: number): number {
    for (const [key, owner] of this.owners)
      if (owner === id && key.endsWith(`:${role}`)) return Number(key.split(':')[0])
    return this.manager(id)
  }
  private ownership(role: string, id: number, manager: number, sourceKey?: string): InputOwnershipStep {
    const key = `${manager}:${role}`
    if (id) this.owners.set(key, id)
    else this.owners.delete(key)
    return { kind: 'ownership', key, layer: id, ...(sourceKey ? { sourceKey } : {}) }
  }
  private *own(role: string, id: number, manager: number, sourceKey?: string): InputOperation {
    yield this.ownership(role, id, manager, sourceKey)
    return undefined
  }
  private *captureIdentity(id: number, manager: number): InputOperation {
    let committed = false
    try {
      const acquired = yield { ...this.ownership('capture', id, manager), identity: true }
      if (acquired === true) {
        this.capture = id
        committed = true
      }
    } finally {
      // An expired identity, a failed VM assignment, or cancellation before its
      // acknowledgement must not leave either side holding a partial capture.
      if (!committed) yield* this.dropOwner('capture', id)
    }
    return undefined
  }
  private *dropOwner(role: string, id?: number): InputOperation {
    for (const [key, owner] of [...this.owners]) {
      if (key.endsWith(`:${role}`) && (id === undefined || owner === id)) {
        this.owners.delete(key)
        yield { kind: 'ownership', key, layer: 0 }
      }
    }
    return undefined
  }
  private releaseOwners(role: string, id?: number): void {
    for (const [key, owner] of this.owners) {
      if (key.endsWith(`:${role}`) && (id === undefined || owner === id)) {
        this.owners.delete(key)
        this.pendingOwnership.push({ kind: 'ownership', key, layer: 0 })
      }
    }
  }
  takeOwnership(): InputOwnershipStep | undefined {
    return this.pendingOwnership.shift()
  }
  get ownershipPending(): boolean {
    return this.pendingOwnership.length !== 0
  }
  *synchronize(): InputOperation {
    return undefined
  }
  root(): number {
    let root = 0, firstManager = Infinity
    for (const id of this.layers.ids()) {
      const layer = this.layers.get(id)
      if (layer.primary && layer.managerId < firstManager &&
        (!this.windowId || layer.windowId === this.windowId())) {
        root = id
        firstManager = layer.managerId
      }
    }
    return root
  }
  attached(id: number): boolean {
    return this.layers.has(id) && this.layers.contains(this.root(), id)
  }
  visible(id: number): boolean {
    if (!this.attached(id)) return false
    for (let item = this.layers.get(id); ; item = this.layers.get(item.parent)) {
      if (!item.visible || this.detaching.has(item.id)) return false
      if (!item.parent) return true
    }
  }
  enabled(id: number, modal = true): boolean {
    if (!this.layers.has(id)) return false
    if (
      modal &&
      this.attached(id) &&
      this.modal.length &&
      !this.layers.contains(this.modal.at(-1)!, id)
    )
      return false
    for (let item = this.layers.get(id); ; item = this.layers.get(item.parent)) {
      if (!item.enabled) return false
      if (!item.parent) return true
    }
  }
  focusable(id: number): boolean {
    return this.visible(id) && this.enabled(id) && this.layers.get(id).focusable
  }
  order(root = this.root()): number[] {
    const result: number[] = []
    const visit = (id: number) => {
      if (!this.layers.has(id)) return
      result.push(id)
      for (const child of this.layers.get(id).children) visit(child)
    }
    if (root) visit(root)
    return result
  }
  first(root = this.root(), ignoreChain = false): number {
    return (
      this.order(root).find(
        (id) => this.focusable(id) && (ignoreChain || this.layers.get(id).joinFocusChain),
      ) ?? 0
    )
  }
  choose(id: number, target: number): void {
    if (target && !this.layers.has(target)) throw new Error('Focus target is invalid')
    this.choice.set(id, target)
  }
  *search(id: number, forward: boolean): InputOperation {
    const order = this.order(),
      start = order.indexOf(id),
      direction = forward ? 1 : -1
    let found = 0
    for (let n = 1; n <= order.length; n++) {
      const candidate = order[(start + n * direction + order.length * 2) % order.length]!
      if (this.focusable(candidate) && this.layers.get(candidate).joinFocusChain) {
        found = candidate
        break
      }
    }
    if (this.layers.has(id)) {
      this.choice.set(id, found)
      yield {
        target: id,
        method: forward ? 'onSearchNextFocusable' : 'onSearchPrevFocusable',
        args: [ref(found)],
      }
      found = this.choice.get(id) ?? 0
    }
    return ref(found)
  }
  *focus(
    id: number,
    forward = true,
    epoch = this.epoch,
    ownershipEpoch = this.ownershipEpoch,
  ): InputOperation {
    if (epoch !== this.epoch) return false
    if (id && !this.focusable(id)) return false
    if (id) {
      const source = id
      this.choice.set(source, id)
      yield { target: source, method: 'onBeforeFocus', args: [ref(id), ref(this.focused), forward] }
      if (epoch !== this.epoch) return false
      id = this.choice.get(source) ?? 0
    }
    if ((id && !this.focusable(id)) || id === this.focused) return false
    if (this.focusLock) throw new Error('Cannot change focus during onFocus or onBlur')
    this.focusLock = true
    const previous = this.focused,
      previousManager = this.ownerManager('focus', previous),
      manager = this.manager(id) || previousManager
    this.focused = id
    this.focusRevision++
    try {
      if (this.layers.has(previous)) yield { target: previous, method: 'onBlur', args: [ref(id)] }
      if (epoch !== this.epoch) return false
      if (this.layers.has(this.focused))
        yield { target: this.focused, method: 'onFocus', args: [ref(previous), forward] }
    } finally {
      try {
        // Native SetFocusTo retains the new focus and releases the old focus
        // after both callbacks, including the exceptional exit.
        if (ownershipEpoch === this.ownershipEpoch) {
          yield* this.own('focus', this.focused, manager)
          if (previousManager && previousManager !== manager)
            yield* this.own('focus', 0, previousManager)
        }
      } finally {
        this.focusLock = false
      }
    }
    if (epoch === this.epoch && ownershipEpoch === this.ownershipEpoch) this.sampleAttention()
    return true
  }
  /** Only the focused Layer's notification refreshes the native manager. */
  attentionChanged(from: number): void {
    if (from !== 0 && from === this.focused) this.sampleAttention()
  }
  private sampleAttention(): void {
    this.attention = null
    if (!this.focused || !this.attached(this.focused)) return
    const focus = this.layers.get(this.focused)
    for (let point = focus; ; point = this.layers.get(point.parent)) {
      if (point.useAttention) {
        let x = point.attentionLeft,
          y = point.attentionTop,
          ancestor = point
        // Attention is a Layer display point: image offsets and clip do not
        // participate, and the primary rectangle itself is never added.
        while (!ancestor.primary) {
          x += ancestor.left
          y += ancestor.top
          if (!ancestor.parent) break
          ancestor = this.layers.get(ancestor.parent)
        }
        this.attention = {
          x,
          y,
          focusLayerId: focus.id,
          pointLayerId: point.id,
          font: focus.bitmap ? { ...focus.attentionFont } : null,
        }
        return
      }
      if (!point.parent) return
    }
  }
  *moveFocus(forward: boolean): InputOperation {
    const next = this.focused
      ? ((yield* this.search(this.focused, forward)) as LayerRef).layer
      : this.first()
    if (next) yield* this.focus(next, forward)
    return ref(next)
  }
  private saveEnabled(traverse = false): void {
    if (this.enabledDepth++ === 0) {
      this.enabledBefore = new Map(this.layers.ids().map((id) => [id, this.enabled(id)]))
      this.rawEnabledBefore = new Map(
        this.layers.ids().map((id) => [id, this.layers.get(id).enabled]),
      )
      this.enabledTraversal = false
    }
    this.enabledTraversal ||= traverse
  }
  private *notifyEnabledTree(
    id: number,
    before: ReadonlyMap<number, boolean>,
    seen = new Set<number>(),
  ): InputOperation {
    if (!this.layers.has(id) || seen.has(id)) return undefined
    seen.add(id)
    if (before.has(id) && before.get(id) !== this.enabled(id))
      yield {
        target: id,
        method: this.enabled(id) ? 'onNodeEnabled' : 'onNodeDisabled',
        args: [],
      }
    if (!this.layers.has(id)) return undefined
    // Native FOR_EACH_CHILD snapshots registrations after this node's callback;
    // removals of later entries are skipped and additions during iteration wait.
    for (const child of [...this.layers.get(id).children])
      if (this.layers.has(child) && this.layers.get(child).parent === id)
        yield* this.notifyEnabledTree(child, before, seen)
    // FOR_EACH_CHILD_END invalidates even an empty leaf's children snapshot.
    if (this.layers.has(id)) this.layers.invalidateChildren(id)
    return undefined
  }
  private *notifyEnabled(): InputOperation {
    if (--this.enabledDepth === 0) {
      const before = this.enabledBefore,
        raw = this.rawEnabledBefore,
        traverse = this.enabledTraversal
      this.enabledBefore = new Map()
      this.rawEnabledBefore = new Map()
      this.enabledTraversal = false
      // Input.change also wraps position/image mutations. Only native enabled
      // or modal work should dirty all caches through this recursive traversal.
      if (
        traverse ||
        this.order().some(
          (id) =>
            before.has(id) &&
            (before.get(id) !== this.enabled(id) || raw.get(id) !== this.layers.get(id).enabled),
        )
      )
        yield* this.notifyEnabledTree(this.root(), before)
    }
    return undefined
  }
  *setMode(id: number): InputOperation {
    if (!this.attached(id)) return
    this.saveEnabled(true)
    try {
      const current = this.modal.at(-1)
      if (current && this.layers.contains(current, id))
        throw new Error('Cannot set mode to the current modal layer or its descendant')
      this.layers.set(id, 'visible', 1)
      if (!this.visible(id) || !this.enabled(id, false))
        throw new Error('Cannot set mode to a disabled or hidden layer tree')
      yield* this.focus(this.first(id), true)
      if (this.attached(id)) {
        yield* this.own(`modal:${id}`, id, this.manager(id))
        this.modal.push(id)
      }
      yield* this.recheckPointer()
    } finally {
      yield* this.notifyEnabled()
    }
  }
  *removeMode(id: number, tree = false): InputOperation {
    if (!this.modal.some((item) => (tree ? this.layers.contains(id, item) : item === id))) return
    const ownershipEpoch = this.ownershipEpoch
    this.saveEnabled(true)
    try {
      for (const item of [...this.modal])
        if (tree ? this.layers.contains(id, item) : item === id) {
          // The modal strong reference is dropped before focus callbacks.
          yield* this.dropOwner(`modal:${item}`, item)
          if (ownershipEpoch !== this.ownershipEpoch) return undefined
          const next = ((yield* this.search(id, true)) as LayerRef).layer
          if (ownershipEpoch !== this.ownershipEpoch) return undefined
          yield* this.focus(next, true)
          if (ownershipEpoch !== this.ownershipEpoch) return undefined
          const index = this.modal.indexOf(item)
          if (index >= 0) this.modal.splice(index, 1)
        }
      yield* this.recheckPointer()
    } finally {
      yield* this.notifyEnabled()
    }
  }
  *change(action: () => void, afterAction?: () => InputOperation): InputOperation {
    const ownershipEpoch = this.ownershipEpoch
    this.saveEnabled()
    try {
      action()
      if (afterAction) yield* afterAction()
      if (ownershipEpoch !== this.ownershipEpoch) return undefined
      for (const id of this.choice.keys()) if (!this.layers.has(id)) this.choice.delete(id)
      for (const id of this.hitChoice.keys()) if (!this.layers.has(id)) this.hitChoice.delete(id)
      for (const id of [...this.modal])
        if (!this.visible(id) || !this.enabled(id, false)) {
          yield* this.removeMode(id)
          if (ownershipEpoch !== this.ownershipEpoch) return undefined
        }
      if (this.focused && !this.focusable(this.focused)) {
        const next = ((yield* this.search(this.focused, true)) as LayerRef).layer
        if (ownershipEpoch !== this.ownershipEpoch) return undefined
        yield* this.focus(next, true)
        if (ownershipEpoch !== this.ownershipEpoch) return undefined
      }
      if (this.capture && this.layers.has(this.capture) &&
        (!this.visible(this.capture) || !this.enabled(this.capture)))
        this.release()
      for (const [id, layer] of this.touchCapture)
        if (!this.visible(layer) || !this.enabled(layer)) this.release(id)
      yield* this.recheckPointer()
    } finally {
      yield* this.notifyEnabled()
    }
    return undefined
  }
  private *leaveHover(root?: number): InputOperation {
    const previous = this.hover
    if (!previous || (root !== undefined && !this.layers.contains(root, previous))) return
    this.hover = 0
    try {
      if (this.layers.has(previous)) yield { target: previous, method: 'onMouseLeave', args: [] }
    } finally {
      yield* this.dropOwner('hover', previous)
    }
    return undefined
  }
  /** Run manager cleanup while the old ancestry is still available. Explicit
   * native invalidation differs from ordinary Part: non-primary SeverChild
   * blurs the tree but does not release mouse capture in the KRKR2 source. */
  *detach(id: number, action: () => void, nativeInvalidation = false): InputOperation {
    if (!this.layers.has(id)) {
      action()
      return undefined
    }
    const primary = this.layers.get(id).primary,
      affectedFocus = this.layers.contains(id, this.focused),
      affectedCapture = this.layers.contains(id, this.capture)
    this.detaching.add(id)
    try {
      if (primary) {
        if (affectedFocus) yield* this.focus(0)
        if (affectedCapture) this.release()
        yield* this.leaveHover(id)
        yield* this.removeMode(id, true)
      } else {
        yield* this.removeMode(id, true)
        yield* this.leaveHover(id)
        if (this.layers.contains(id, this.focused)) {
          const next = ((yield* this.search(id, true)) as LayerRef).layer
          yield* this.focus(next, true)
        }
        if (!nativeInvalidation && affectedCapture) this.release()
      }
      for (const [touch, layer] of this.touchCapture)
        if (this.layers.contains(id, layer)) this.release(touch)
      action()
    } finally {
      this.detaching.delete(id)
    }
    return undefined
  }
  release(touch?: number): void {
    if (touch !== undefined) {
      this.releasedTouches.add(touch)
      this.releaseOwners(`touch:${touch}`)
      this.touchCapture.delete(touch)
    } else {
      this.released = true
      this.capture = 0
      this.releaseOwners('capture')
    }
  }
  private *releaseMouseCapture(): InputOperation {
    this.released = true
    this.capture = 0
    // Finish the old VM reference release while the manager slot is empty.
    // Its finalizer can reenter input or retire the Window before acquisition.
    yield* this.dropOwner('capture')
    return undefined
  }
  private drawing() {
    const root = this.root()
    if (!root) return undefined
    const { width, height } = this.layers.get(root)
    return { width, height, geometry: drawDeviceGeometry(this.window(), width, height) }
  }
  private primary(point: DevicePoint): DevicePoint | undefined {
    const drawing = this.drawing()
    return drawing && toPrimary(point, drawing.geometry, drawing.width, drawing.height)
  }
  chooseHit(id: number, hit: boolean): void {
    this.hitChoice.set(id, hit)
  }
  private *hit(
    x: number,
    y: number,
    root?: number,
    excludeSelf = false,
    getDisabled = false,
  ): Generator<InputCall, number, unknown> {
    const epoch = this.epoch
    this.hitDepth++
    try {
      for (const candidate of this.layers.hitCandidates(x, y, root, excludeSelf)) {
        const { id } = candidate
        if (!this.layers.has(id)) continue
        if ([...this.detaching].some((ancestor) => this.layers.contains(ancestor, id))) continue
        // A native pointer packet searches only the displayed window. An
        // explicit Layer.getLayerAt still searches the requested subtree.
        if (root === undefined && this.windowId && this.layers.get(id).windowId !== this.windowId())
          continue
        this.hitChoice.set(id, true)
        yield {
          target: id,
          method: 'onHitTest',
          args: [Math.floor(candidate.x), Math.floor(candidate.y), true],
        }
        if (epoch !== this.epoch) return 0
        if (!this.layers.has(id) || !this.hitChoice.get(id)) continue
        return getDisabled || this.enabled(id) ? id : 0
      }
      return 0
    } finally {
      this.hitDepth--
    }
  }
  *getLayerAt(
    root: number,
    x: number,
    y: number,
    excludeSelf: boolean,
    getDisabled: boolean,
  ): InputOperation {
    this.layers.get(root)
    return ref(yield* this.hit(x, y, root, excludeSelf, getDisabled))
  }
  private local(id: number, x: number, y: number): number[] {
    let layer = this.layers.get(id), px = BigInt(deviceInt(x)), py = BigInt(deviceInt(y))
    while (!layer.primary) {
      px = BigInt.asIntN(32, px - BigInt(layer.left))
      py = BigInt.asIntN(32, py - BigInt(layer.top))
      if (!layer.parent) break
      layer = this.layers.get(layer.parent)
    }
    return [Number(px), Number(py)]
  }
  private *target(x: number, y: number): Generator<InputCall, number, unknown> {
    // Native invalidation may detach a still-owned captured Layer. Shutdown
    // suppresses its callbacks; it must not redirect the event underneath it.
    return this.capture || (yield* this.hit(x, y))
  }
  private activeCursor(id: number): number {
    let layer = this.layers.get(id)
    while (layer.cursor === 0 && layer.parent) layer = this.layers.get(layer.parent)
    return layer.cursor
  }
  private activeHint(id: number): string {
    let layer = this.layers.get(id)
    // showParentHint chooses the parent even when this Layer's own hint is
    // nonempty. An explicit hint setter disables that inheritance.
    while (layer.showParentHint && layer.parent) layer = this.layers.get(layer.parent)
    return layer.hint
  }
  private *notifyHintOrCursor(
    id: number,
    value: { cursor: number } | { hint: string },
  ): InputOperation {
    if (this.notifyingHintOrCursor || !this.attached(id)) return undefined
    const epoch = this.epoch
    this.notifyingHintOrCursor = true
    try {
      const target = this.capture ||
        (yield* this.hit(this.lastMousePrimary.x, this.lastMousePrimary.y))
      if (epoch !== this.epoch || target !== id) return undefined
      // The native setter samples its value before Notify calls onHitTest.
      // Reentrant setters mutate properties but cannot replace this sample.
      if ('cursor' in value) this.currentCursor = value.cursor
      else this.currentHint = value.hint
    } finally {
      this.notifyingHintOrCursor = false
    }
    return undefined
  }
  *setCursor(id: number, value: number): InputOperation {
    this.layers.set(id, 'cursor', value)
    yield* this.notifyHintOrCursor(id, { cursor: this.activeCursor(id) })
    return undefined
  }
  *setHint(id: number, value: string): InputOperation {
    this.layers.set(id, 'hint', value)
    yield* this.notifyHintOrCursor(id, { hint: value })
    return undefined
  }
  private *mouseMove(p: { x: number; y: number }, shift: number): InputOperation {
    const epoch = this.epoch
    this.mouseDepth++
    try {
      const changed = p.x !== this.lastMousePrimary.x || p.y !== this.lastMousePrimary.y
      this.shift = shift
      this.lastMousePrimary = { ...p }
      let target = yield* this.target(p.x, p.y)
      if (epoch !== this.epoch) return undefined
      if (this.hover !== target) {
        const previous = this.hover
        if (this.layers.has(previous)) yield { target: previous, method: 'onMouseLeave', args: [] }
        if (epoch !== this.epoch) return undefined
        target = yield* this.target(p.x, p.y)
        if (epoch !== this.epoch) return undefined
        if (target) {
          this.notifyingHintOrCursor = true
          try {
            yield { target, method: 'onMouseEnter', args: [] }
            if (epoch !== this.epoch) return undefined
            const next = yield* this.target(p.x, p.y)
            if (epoch !== this.epoch) return undefined
            if (target !== next) {
              if (this.layers.has(target)) yield { target, method: 'onMouseLeave', args: [] }
              if (epoch !== this.epoch) return undefined
              target = next
              if (target) yield { target, method: 'onMouseEnter', args: [] }
              if (epoch !== this.epoch) return undefined
            }
            // Commit only after enter and its one recheck complete. Rendering
            // and same-target moves must never re-sample the parent chain.
            if (target && this.attached(target)) {
              const cursor = this.activeCursor(target), hint = this.activeHint(target)
              this.currentCursor = cursor
              this.currentHint = hint
            }
          } finally {
            this.notifyingHintOrCursor = false
          }
        }
        if (!target) {
          this.currentCursor = 0
          this.currentHint = ''
        }
        // Keep the previous hover owned across leave/enter and hit rechecks.
        // Clear it before Release so finalizers observe an empty old slot.
        this.hover = 0
        yield* this.dropOwner('hover', previous)
        if (epoch !== this.epoch) return undefined
        if (this.layers.has(target)) {
          this.hover = target
          yield* this.own('hover', target, this.manager(target))
        } else if (target && target === this.capture) {
          // Explicit invalidate retires the tree before the manager's strong
          // capture reference. Native hover acquires that same invalid object.
          const manager = this.ownerManager('capture', target)
          this.hover = target
          yield* this.own('hover', target, manager, `${manager}:capture`)
        }
      }
      if (this.hover && this.layers.has(this.hover) && changed)
        yield {
          target: this.hover,
          method: 'onMouseMove',
          args: [...this.local(this.hover, p.x, p.y), shift],
        }
    } finally {
      this.mouseDepth--
    }
    return undefined
  }
  private *recheckPointer(): InputOperation {
    if (!this.mouseDepth && !this.hitDepth)
      // A native ForceMouseRecheck reuses LastMouseMove primary coordinates.
      // Both hit testing and notifications retain that sample after a later
      // Window transform. Native rechecks also use zero modifier flags.
      yield* this.mouseMove(this.lastMousePrimary, 0)
    return undefined
  }
  *defaultKey(id: number, kind: string, key: string | number, shift = 0): InputOperation {
    const plain = !(shift & 7),
      parent = this.layers.has(id) ? this.layers.get(id).parent : 0
    if (kind === 'down') {
      if (plain && [9, 39, 40].includes(Number(key))) yield* this.moveFocus(true)
      else if ((key === 9 && shift & 1 && !(shift & 6)) || key === 37 || key === 38)
        yield* this.moveFocus(false)
      else if (plain && (key === 13 || key === 27) && parent && this.enabled(parent))
        yield { target: parent, method: 'onKeyDown', args: [key, shift, true] }
    } else if (kind === 'up') {
      if (plain && (key === 13 || key === 27) && parent && this.enabled(parent))
        yield { target: parent, method: 'onKeyUp', args: [key, shift, true] }
    } else if ((key === '\r' || key === '\u001b') && parent && this.enabled(parent))
      yield { target: parent, method: 'onKeyPress', args: [key, true] }
    return undefined
  }
  observe(packet: InputPacket): void {
    if (packet.type === 'keyDown') this.keys.add(packet.key)
    if (packet.type === 'keyUp') this.keys.delete(packet.key)
    if ('shift' in packet) {
      this.shift = packet.shift
      for (const [key, mask] of [
        [16, 1],
        [17, 4],
        [18, 2],
        [1, 8],
        [2, 16],
        [4, 32],
      ])
        packet.shift & mask! ? this.keys.add(key!) : this.keys.delete(key!)
    }
    if (packet.type === 'cancel' || packet.type === 'deactivate') this.keys.clear()
  }
  resetTransient(): void {
    this.epoch++
    this.clearTransient()
  }
  private clearTransient(): void {
    this.release()
    for (const id of this.touchCapture.keys()) this.releaseOwners(`touch:${id}`)
    this.touchCapture.clear()
    this.releasedTouches.clear()
    this.keys.clear()
    this.shift = 0
    this.hover = 0
    this.releaseOwners('hover')
    this.point = { x: -1, y: -1 }
    this.hitChoice.clear()
  }
  *packet(packet: InputPacket, epoch = this.epoch): InputOperation {
    if (epoch !== this.epoch) return undefined
    const operation = this.dispatchPacket(packet)
    try {
      let next = operation.next()
      while (!next.done) {
        const value = yield next.value
        if (epoch !== this.epoch) {
          this.clearTransient()
          return undefined
        }
        next = operation.next(value)
      }
      return next.value
    } finally {
      let next = operation.return(undefined)
      for (let guard = 0; !next.done && guard < 4096; guard++) {
        if (next.value.kind === 'ownership' || (next.value.kind === 'invoke' && next.value.unwind))
          yield next.value
        next = operation.next()
      }
    }
  }
  private *dispatchPacket(packet: InputPacket): InputOperation {
    // The Window receives the PaintBox integer point captured at admission.
    // Retain it across callbacks; only the destination size is sampled later.
    const mousePoint = packet.type === 'down' || packet.type === 'up' ||
      packet.type === 'move' || packet.type === 'wheel' || packet.type === 'click'
      ? packet.paintBoxPoint
        ? { ...packet.paintBoxPoint }
        : paintBoxPoint(this.window(), packet.x, packet.y)
      : undefined
    if (packet.type === 'activate') {
      yield { target: 0, method: 'onActivate', args: [] }
      return
    }
    if (packet.type === 'cancel' || packet.type === 'deactivate') {
      this.release()
      for (const id of this.touchCapture.keys()) this.releaseOwners(`touch:${id}`)
      this.touchCapture.clear()
      yield* this.leaveHover()
      if (packet.type === 'deactivate') yield { target: 0, method: 'onDeactivate', args: [] }
      return
    }
    if (!this.window().visible) return
    if (packet.type === 'leave') {
      yield { target: 0, method: 'onMouseLeave', args: [] }
      if (!this.capture) yield* this.mouseMove({ x: -1, y: -1 }, 0)
      return
    }
    if (packet.type === 'text') {
      for (let i = 0; i < packet.text.length; i++) {
        const key = packet.text[i]!
        yield { target: 0, method: 'onKeyPress', args: [key] }
        if (this.focused) yield { target: this.focused, method: 'onKeyPress', args: [key, true] }
        else yield* this.defaultKey(this.root(), 'text', key)
      }
      return
    }
    if (packet.type === 'keyDown' || packet.type === 'keyUp') {
      const method = packet.type === 'keyDown' ? 'onKeyDown' : 'onKeyUp'
      yield { target: 0, method, args: [packet.key, packet.shift] }
      if (this.focused)
        yield { target: this.focused, method, args: [packet.key, packet.shift, true] }
      else
        yield* this.defaultKey(
          this.root(),
          packet.type === 'keyDown' ? 'down' : 'up',
          packet.key,
          packet.shift,
        )
      return
    }
    if (packet.type === 'wheel') {
      this.point = { x: packet.x, y: packet.y }
      yield {
        target: 0,
        method: 'onMouseWheel',
        args: [packet.shift, packet.delta, mousePoint!.x, mousePoint!.y],
      }
      const p = this.primary(mousePoint!)
      if (p && this.focused)
        yield {
          target: this.focused,
          method: 'onMouseWheel',
          args: [packet.shift, packet.delta, p.x, p.y],
        }
      return
    }
    if (packet.type === 'touchDown' || packet.type === 'touchMove' || packet.type === 'touchUp') {
      const method =
        packet.type === 'touchDown'
          ? 'onTouchDown'
          : packet.type === 'touchUp'
            ? 'onTouchUp'
            : 'onTouchMove'
      yield {
        target: 0,
        method,
        args: [packet.x, packet.y, packet.width, packet.height, packet.id],
      }
      const drawing = this.drawing()
      if (!drawing) return
      const { geometry, width, height } = drawing,
        scaleX = geometry.width ? width / geometry.width : 0,
        scaleY = geometry.height ? height / geometry.height : 0,
        p = { x: (packet.x - geometry.x) * scaleX, y: (packet.y - geometry.y) * scaleY },
        target = this.touchCapture.get(packet.id) ?? (yield* this.hit(p.x, p.y))
      if (packet.type === 'touchDown') {
        yield* this.dropOwner(`touch:${packet.id}`)
        this.touchCapture.delete(packet.id)
        this.releasedTouches.delete(packet.id)
      }
      if (target) {
        const local = this.layers.localPoint(target, p.x, p.y)
        yield {
          target,
          method,
          args: [local.x, local.y, packet.width * scaleX, packet.height * scaleY, packet.id],
        }
        if (
          packet.type === 'touchDown' &&
          !this.releasedTouches.has(packet.id) &&
          this.attached(target)
        ) {
          // Touch capture is a Web extension; it uses the same explicit lease
          // mechanism without claiming a counterpart in KRKR2's mouse manager.
          yield* this.own(`touch:${packet.id}`, target, this.manager(target))
          this.touchCapture.set(packet.id, target)
        }
      }
      if (packet.type === 'touchUp') {
        this.touchCapture.delete(packet.id)
        yield* this.dropOwner(`touch:${packet.id}`)
        this.releasedTouches.delete(packet.id)
      }
      return
    }
    if (!('clicks' in packet)) return
    if (packet.type !== 'click') this.point = { x: packet.x, y: packet.y }
    if (packet.type === 'move') {
      yield {
        target: 0,
        method: 'onMouseMove',
        args: [mousePoint!.x, mousePoint!.y, packet.shift],
      }
      const p = this.primary(mousePoint!)
      if (p) yield* this.mouseMove(p, packet.shift)
      return
    }
    if (packet.type === 'down') {
      yield {
        target: 0,
        method: 'onMouseDown',
        args: [mousePoint!.x, mousePoint!.y, packet.button, packet.shift],
      }
      const p = this.primary(mousePoint!)
      if (!p) return
      const target = yield* this.target(p.x, p.y)
      this.released = false
      if (target) {
        const manager = this.ownerManager('capture', target)
        if (this.layers.has(target))
          yield {
            target,
            method: 'onMouseDown',
            args: [...this.local(target, p.x, p.y), packet.button, packet.shift],
          }
        const noCapture = this.released,
          epoch = this.epoch,
          ownershipEpoch = this.ownershipEpoch
        if (this.capture !== target) {
          yield* this.releaseMouseCapture()
          if (epoch !== this.epoch || ownershipEpoch !== this.ownershipEpoch) return undefined
          if (!noCapture) {
            if (this.layers.has(target)) {
              this.capture = target
              yield* this.own('capture', target, this.manager(target))
            } else yield* this.captureIdentity(target, manager)
          }
        }
        // Native PrimaryMouseDown hides the hint after the callback and
        // capture acquisition. A throwing callback never reaches this write.
        this.currentHint = ''
      } else yield* this.releaseMouseCapture()
      return
    }
    if (packet.clicks > 0) {
      const method = packet.clicks === 2 ? 'onDoubleClick' : 'onClick'
      yield { target: 0, method, args: [mousePoint!.x, mousePoint!.y] }
      const p = this.primary(mousePoint!),
        hit = p ? (yield* this.hit(p.x, p.y)) : 0
      if (hit && (packet.clicks === 2 || this.capture === hit))
        yield { target: hit, method, args: this.local(hit, p!.x, p!.y) }
    }
    if (packet.type === 'click') return
    yield {
      target: 0,
      method: 'onMouseUp',
      args: [mousePoint!.x, mousePoint!.y, packet.button, packet.shift],
    }
    const p = this.primary(mousePoint!)
    if (!p) return
    const target = yield* this.target(p.x, p.y)
    if (target) {
      if (this.layers.has(target))
        yield {
          target,
          method: 'onMouseUp',
          args: [...this.local(target, p.x, p.y), packet.button, packet.shift],
        }
      if (!(packet.shift & shiftButtons)) {
        const epoch = this.epoch, ownershipEpoch = this.ownershipEpoch
        yield* this.releaseMouseCapture()
        if (epoch !== this.epoch || ownershipEpoch !== this.ownershipEpoch) return undefined
        yield* this.mouseMove(p, packet.shift)
      }
    }
  }
  view(): InputView {
    const focus = this.layers.has(this.focused) ? this.layers.get(this.focused) : undefined
    // A view may discard retired samples, but never search ancestry or refresh
    // a still-live one. This also covers exceptional invalidation cleanup.
    if (
      this.attention &&
      (!focus ||
        !this.attached(focus.id) ||
        !this.attached(this.attention.focusLayerId) ||
        !this.attached(this.attention.pointLayerId))
    )
      this.attention = null
    const drawing = this.drawing(),
      attention = this.attention && drawing
        ? {
            ...this.attention,
            ...fromPrimary(this.attention, drawing.geometry, drawing.width, drawing.height),
            font: this.attention.font ? { ...this.attention.font } : null,
          }
        : null
    return {
      cursor: this.currentCursor,
      hint: this.currentHint,
      focused: this.focused,
      attention,
      attentionX: attention?.x ?? 0,
      attentionY: attention?.y ?? 0,
      imeMode: focus?.imeMode ?? 0,
    }
  }
  clear(): void {
    // A different displayed manager must not resume old packet/focus work.
    // Its initial cursor location and focus lock are independent as well.
    this.epoch++
    this.ownershipEpoch++
    for (const key of this.owners.keys())
      this.pendingOwnership.push({ kind: 'ownership', key, layer: 0 })
    this.owners.clear()
    this.modal = []
    this.capture = this.hover = this.focused = 0
    this.currentCursor = 0
    this.currentHint = ''
    this.notifyingHintOrCursor = false
    this.lastMousePrimary = { x: -1, y: -1 }
    this.focusRevision++
    this.attention = null
    this.focusLock = false
    this.released = true
    this.point = { x: -1, y: -1 }
    this.shift = 0
    this.choice.clear()
    this.hitChoice.clear()
    this.touchCapture.clear()
    this.releasedTouches.clear()
    this.keys.clear()
  }
  /** Terminal shutdown only: no script execution or finalizer ordering claim. */
  dispose(): void {
    this.clear()
    this.pendingOwnership = []
    this.detaching.clear()
  }
}
