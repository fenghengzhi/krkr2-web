import { LayerTree } from '../scene/layers.ts'
import type { WindowView } from '../scene/window.ts'
import { shiftButtons, type InputPacket, type InputView } from '../ports/input.ts'
export interface LayerRef {
  layer: number
}
export type InputValue = string | number | boolean | null | undefined | LayerRef
export interface InputCall {
  target: number
  method: string
  args: InputValue[]
}
export type InputOperation = Generator<InputCall, InputValue, unknown>
const ref = (layer: number): LayerRef => ({ layer })
export class InputController {
  epoch = 0
  focused = 0
  modal: number[] = []
  capture = 0
  hover = 0
  point = { x: -1, y: -1 }
  shift = 0
  private mouseAt = { x: -1, y: -1 }
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
  constructor(
    readonly layers: LayerTree,
    private readonly window: () => WindowView,
    private readonly windowId?: () => number,
  ) {}
  root(): number {
    return (
      this.layers
        .ids()
        .find(
          (id) =>
            this.layers.get(id).primary &&
            (!this.windowId || this.layers.get(id).windowId === this.windowId()),
        ) ?? 0
    )
  }
  attached(id: number): boolean {
    return this.layers.has(id) && this.layers.contains(this.root(), id)
  }
  visible(id: number): boolean {
    if (!this.attached(id)) return false
    for (let item = this.layers.get(id); ; item = this.layers.get(item.parent)) {
      if (!item.visible) return false
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
  *focus(id: number, forward = true): InputOperation {
    if (id && !this.focusable(id)) return false
    if (id) {
      const source = id
      this.choice.set(source, id)
      yield { target: source, method: 'onBeforeFocus', args: [ref(id), ref(this.focused), forward] }
      id = this.choice.get(source) ?? 0
    }
    if ((id && !this.focusable(id)) || id === this.focused) return false
    if (this.focusLock) throw new Error('Cannot change focus during onFocus or onBlur')
    this.focusLock = true
    const previous = this.focused
    this.focused = id
    try {
      if (this.layers.has(previous)) yield { target: previous, method: 'onBlur', args: [ref(id)] }
      if (this.layers.has(this.focused))
        yield { target: this.focused, method: 'onFocus', args: [ref(previous), forward] }
    } finally {
      this.focusLock = false
    }
    return true
  }
  *moveFocus(forward: boolean): InputOperation {
    const next = this.focused
      ? ((yield* this.search(this.focused, forward)) as LayerRef).layer
      : this.first()
    if (next) yield* this.focus(next, forward)
    return ref(next)
  }
  private saveEnabled(): void {
    if (this.enabledDepth++ === 0)
      this.enabledBefore = new Map(this.layers.ids().map((id) => [id, this.enabled(id)]))
  }
  private *notifyEnabled(): InputOperation {
    if (--this.enabledDepth === 0) {
      const before = this.enabledBefore
      this.enabledBefore = new Map()
      for (const id of this.order())
        if (before.has(id) && before.get(id) !== this.enabled(id))
          yield {
            target: id,
            method: this.enabled(id) ? 'onNodeEnabled' : 'onNodeDisabled',
            args: [],
          }
    }
    return undefined
  }
  *setMode(id: number): InputOperation {
    if (!this.attached(id)) return
    this.saveEnabled()
    try {
      const current = this.modal.at(-1)
      if (current && this.layers.contains(current, id))
        throw new Error('Cannot set mode to the current modal layer or its descendant')
      this.layers.set(id, 'visible', 1)
      if (!this.visible(id) || !this.enabled(id, false))
        throw new Error('Cannot set mode to a disabled or hidden layer tree')
      yield* this.focus(this.first(id), true)
      if (this.attached(id)) this.modal.push(id)
      yield* this.recheckPointer()
    } finally {
      yield* this.notifyEnabled()
    }
  }
  *removeMode(id: number, tree = false): InputOperation {
    if (!this.modal.some((item) => (tree ? this.layers.contains(id, item) : item === id))) return
    this.saveEnabled()
    try {
      for (const item of [...this.modal])
        if (tree ? this.layers.contains(id, item) : item === id) {
          const next = ((yield* this.search(id, true)) as LayerRef).layer
          yield* this.focus(next, true)
          const index = this.modal.indexOf(item)
          if (index >= 0) this.modal.splice(index, 1)
        }
      yield* this.recheckPointer()
    } finally {
      yield* this.notifyEnabled()
    }
  }
  *change(action: () => void, afterAction?: () => InputOperation): InputOperation {
    this.saveEnabled()
    try {
      action()
      if (afterAction) yield* afterAction()
      for (const id of this.choice.keys()) if (!this.layers.has(id)) this.choice.delete(id)
      for (const id of this.hitChoice.keys()) if (!this.layers.has(id)) this.hitChoice.delete(id)
      this.modal = this.modal.filter((id) => this.visible(id) && this.enabled(id, false))
      if (this.focused && !this.focusable(this.focused)) {
        const next = ((yield* this.search(this.focused, true)) as LayerRef).layer
        yield* this.focus(next, true)
      }
      if (this.capture && (!this.visible(this.capture) || !this.enabled(this.capture)))
        this.release()
      for (const [id, layer] of this.touchCapture)
        if (!this.visible(layer) || !this.enabled(layer)) this.touchCapture.delete(id)
      yield* this.recheckPointer()
    } finally {
      yield* this.notifyEnabled()
    }
    return undefined
  }
  release(touch?: number): void {
    if (touch !== undefined) {
      this.releasedTouches.add(touch)
      this.touchCapture.delete(touch)
    } else {
      this.released = true
      this.capture = 0
    }
  }
  private primary(x = this.point.x, y = this.point.y) {
    const view = this.window(),
      zoom = view.zoomNumer / view.zoomDenom
    return { x: (x - view.layerLeft) / zoom, y: (y - view.layerTop) / zoom }
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
    this.hitDepth++
    try {
      for (const candidate of this.layers.hitCandidates(x, y, root, excludeSelf)) {
        const { id } = candidate
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
    const p = this.layers.localPoint(id, x, y)
    return [Math.floor(p.x), Math.floor(p.y)]
  }
  private *target(x: number, y: number): Generator<InputCall, number, unknown> {
    return this.capture && this.attached(this.capture) ? this.capture : yield* this.hit(x, y)
  }
  private *mouseMove(x: number, y: number, shift: number, force = false): InputOperation {
    this.mouseDepth++
    try {
      const changed = force || x !== this.mouseAt.x || y !== this.mouseAt.y
      this.mouseAt = { x, y }
      this.point = { x, y }
      this.shift = shift
      const p = this.primary()
      let target = yield* this.target(p.x, p.y)
      if (this.hover !== target) {
        const previous = this.hover
        this.hover = 0
        if (this.layers.has(previous)) yield { target: previous, method: 'onMouseLeave', args: [] }
        target = yield* this.target(p.x, p.y)
        if (target) {
          yield { target, method: 'onMouseEnter', args: [] }
          const next = yield* this.target(p.x, p.y)
          if (target !== next) {
            if (this.layers.has(target)) yield { target, method: 'onMouseLeave', args: [] }
            target = next
            if (target) yield { target, method: 'onMouseEnter', args: [] }
          }
        }
        this.hover = this.attached(target) ? target : 0
      }
      if (this.hover && changed)
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
      yield* this.mouseMove(this.point.x, this.point.y, this.shift)
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
    this.touchCapture.clear()
    this.releasedTouches.clear()
    this.keys.clear()
    this.shift = 0
    this.hover = 0
    this.point = this.mouseAt = { x: -1, y: -1 }
    this.hitChoice.clear()
  }
  *packet(packet: InputPacket): InputOperation {
    const epoch = this.epoch,
      operation = this.dispatchPacket(packet)
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
      for (let guard = 0; !next.done && guard < 4096; guard++) next = operation.next()
    }
  }
  private *dispatchPacket(packet: InputPacket): InputOperation {
    if (packet.type === 'activate') {
      yield { target: 0, method: 'onActivate', args: [] }
      return
    }
    if (packet.type === 'cancel' || packet.type === 'deactivate') {
      this.release()
      this.touchCapture.clear()
      if (this.layers.has(this.hover))
        yield { target: this.hover, method: 'onMouseLeave', args: [] }
      this.hover = 0
      if (packet.type === 'deactivate') yield { target: 0, method: 'onDeactivate', args: [] }
      return
    }
    if (!this.window().visible) return
    if (packet.type === 'leave') {
      yield { target: 0, method: 'onMouseLeave', args: [] }
      if (!this.capture) yield* this.mouseMove(-1, -1, 0)
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
        args: [packet.shift, packet.delta, packet.x, packet.y],
      }
      const p = this.primary()
      if (this.focused)
        yield {
          target: this.focused,
          method: 'onMouseWheel',
          args: [packet.shift, packet.delta, Math.floor(p.x), Math.floor(p.y)],
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
      const p = this.primary(packet.x, packet.y),
        target = this.touchCapture.get(packet.id) ?? (yield* this.hit(p.x, p.y))
      if (packet.type === 'touchDown') {
        this.touchCapture.delete(packet.id)
        this.releasedTouches.delete(packet.id)
      }
      if (target) {
        const local = this.layers.localPoint(target, p.x, p.y),
          zoom = this.window().zoomNumer / this.window().zoomDenom
        yield {
          target,
          method,
          args: [local.x, local.y, packet.width / zoom, packet.height / zoom, packet.id],
        }
        if (
          packet.type === 'touchDown' &&
          !this.releasedTouches.has(packet.id) &&
          this.attached(target)
        )
          this.touchCapture.set(packet.id, target)
      }
      if (packet.type === 'touchUp') {
        this.touchCapture.delete(packet.id)
        this.releasedTouches.delete(packet.id)
      }
      return
    }
    if (!('clicks' in packet)) return
    this.point = { x: packet.x, y: packet.y }
    if (packet.type === 'move') {
      yield { target: 0, method: 'onMouseMove', args: [packet.x, packet.y, packet.shift] }
      yield* this.mouseMove(packet.x, packet.y, packet.shift)
      return
    }
    if (packet.type === 'down') {
      yield {
        target: 0,
        method: 'onMouseDown',
        args: [packet.x, packet.y, packet.button, packet.shift],
      }
      yield* this.mouseMove(packet.x, packet.y, packet.shift)
      const p = this.primary(),
        target = yield* this.target(p.x, p.y)
      this.released = false
      if (target) {
        yield {
          target,
          method: 'onMouseDown',
          args: [...this.local(target, p.x, p.y), packet.button, packet.shift],
        }
        if (!this.released && this.visible(target) && this.enabled(target)) this.capture = target
      } else this.release()
      return
    }
    if (packet.clicks > 0) {
      const method = packet.clicks === 2 ? 'onDoubleClick' : 'onClick'
      yield { target: 0, method, args: [packet.x, packet.y] }
      const p = this.primary(),
        hit = yield* this.hit(p.x, p.y)
      if (hit && (packet.clicks === 2 || this.capture === hit))
        yield { target: hit, method, args: this.local(hit, p.x, p.y) }
    }
    yield {
      target: 0,
      method: 'onMouseUp',
      args: [packet.x, packet.y, packet.button, packet.shift],
    }
    const p = this.primary(),
      target = yield* this.target(p.x, p.y)
    if (this.layers.has(target))
      yield {
        target,
        method: 'onMouseUp',
        args: [...this.local(target, p.x, p.y), packet.button, packet.shift],
      }
    if (!(packet.shift & shiftButtons)) {
      this.release()
      yield* this.mouseMove(packet.x, packet.y, packet.shift)
    }
  }
  view(): InputView {
    const layer = this.layers.has(this.hover) ? this.layers.get(this.hover) : undefined,
      focus = this.layers.has(this.focused) ? this.layers.get(this.focused) : undefined
    let hint = layer?.hint ?? '',
      source = layer
    while (!hint && source?.showParentHint && source.parent) {
      source = this.layers.get(source.parent)
      hint = source.hint
    }
    const local = focus ? this.layers.localPoint(focus.id, 0, 0) : { x: 0, y: 0 },
      window = this.window(),
      zoom = window.zoomNumer / window.zoomDenom
    return {
      cursor: layer?.cursor ?? 0,
      hint,
      focused: this.focused,
      attentionX: window.layerLeft + ((focus?.attentionLeft ?? 0) - local.x) * zoom,
      attentionY: window.layerTop + ((focus?.attentionTop ?? 0) - local.y) * zoom,
      imeMode: focus?.imeMode ?? 0,
    }
  }
  clear(): void {
    this.modal = []
    this.capture = this.hover = this.focused = 0
    this.choice.clear()
    this.hitChoice.clear()
    this.touchCapture.clear()
    this.keys.clear()
  }
}
