export interface MenuView {
  id: number
  caption: string
  enabled: boolean
  visible: boolean
  checked: boolean
  radio: boolean
  shortcut: string
  children: MenuView[]
}
interface MenuNode extends Omit<MenuView, 'children'> {
  parent: number
  group: number
  children: number[]
}
export interface MenuSnapshot {
  root?: MenuView
  popup?: MenuPopup
}
export interface MenuPopupIdentity {
  windowId: number
  requestId: number
}
export interface MenuPopup extends MenuPopupIdentity {
  id: number
  x: number
  y: number
  flags: number
}
export type MenuPopupOutcome = 'pending' | 'selected' | 'dismissed' | 'unavailable'
export interface MenuPopupHandle {
  readonly popup: MenuPopup
  readonly result: Promise<number>
  readonly outcome: MenuPopupOutcome
  readonly selectedCommand: number | undefined
}
interface PopupRecord {
  readonly popup: MenuPopup
  readonly resolve: (value: number) => void
  outcome: MenuPopupOutcome
  selectedCommand?: number
}
export interface WindowMenus {
  windowId: number
  menus: MenuSnapshot
}

export class MenuTree {
  has(id: number): boolean {
    return this.nodes.has(id)
  }
  private nodes = new Map<number, MenuNode>()
  private nextId = 1
  // Web command identifiers have their own reusable Word pool. View identities
  // remain monotonic, so a recycled command never revives an old UI response.
  private commands = new Map<number, number>()
  private usedCommands = new Set<number>()
  private roots = new Map<number, number>()
  private nextPopup = 1
  private popups: PopupRecord[] = []
  revision = 0
  private allocateCommand(id: number): void {
    for (let command = 1; command <= 0xffff; command++) {
      if (this.usedCommands.has(command)) continue
      this.usedCommands.add(command)
      this.commands.set(id, command)
      return
    }
    throw new Error('Menu command budget exceeded')
  }
  private releaseCommand(id: number): void {
    const command = this.commands.get(id)
    if (command === undefined) return
    this.commands.delete(id)
    this.usedCommands.delete(command)
  }
  command(id: number): number {
    this.get(id)
    return this.commands.get(id) ?? 0
  }
  create(caption: string): number {
    if (this.nodes.size >= 4096) throw new Error('Menu item budget exceeded')
    const id = this.nextId++
    this.allocateCommand(id)
    this.nodes.set(id, {
      id,
      caption,
      parent: 0,
      enabled: true,
      visible: true,
      checked: false,
      radio: false,
      group: 0,
      shortcut: '',
      children: [],
    })
    this.revision++
    return id
  }
  get(id: number): MenuNode {
    const item = this.nodes.get(id)
    if (!item) throw new Error('MenuItem has been invalidated')
    return item
  }
  setRoot(id: number, windowId = 0): void {
    if (this.get(id).parent) throw new Error('The window menu cannot have a parent')
    for (const [owner, root] of this.roots)
      if (root === id && owner !== windowId) throw new Error('The menu belongs to another Window')
    if (this.roots.get(windowId) === id) return
    this.dismiss(windowId, undefined, 'unavailable')
    this.roots.set(windowId, id)
    this.releaseCommand(id)
    this.revision++
  }
  hideRoot(windowId = 0): void {
    this.dismiss(windowId, undefined, 'unavailable')
    if (this.roots.delete(windowId)) this.revision++
  }
  /** Display ancestry, rather than the script action owner, determines routing. */
  windowId(id: number): number | undefined {
    let item = this.nodes.get(id)
    if (!item) return
    while (item.parent) item = this.get(item.parent)
    for (const [windowId, root] of this.roots) if (item.id === root) return windowId
  }
  private forgetRoot(id: number): void {
    for (const [windowId, root] of this.roots) if (root === id) this.hideRoot(windowId)
  }
  private contains(parentId: number, id: number): boolean {
    for (let item = this.get(id); ; item = this.get(item.parent)) {
      if (item.id === parentId) return true
      if (!item.parent) return false
    }
  }
  private dismissSubtree(id: number): void {
    for (const popup of [...this.popups].reverse())
      if (popup.outcome === 'pending' && this.contains(id, popup.popup.id))
        this.settle(popup, 0, 'unavailable')
  }
  set(id: number, property: string, value: string | number): void {
    const item = this.get(id)
    if (property === 'caption' || property === 'shortcut') item[property] = String(value)
    else if (
      property === 'checked' ||
      property === 'enabled' ||
      property === 'visible' ||
      property === 'radio'
    )
      item[property] = !!value
    else if (property === 'group') item.group = Number(value)
    else throw new Error(`Unsupported MenuItem property: ${property}`)
    if (item.checked && item.radio && item.parent) {
      for (const siblingId of this.get(item.parent).children) {
        const sibling = this.get(siblingId)
        if (sibling !== item && sibling.radio && sibling.group === item.group)
          sibling.checked = false
      }
    }
    this.revision++
  }
  insert(parentId: number, id: number, index: number): void {
    const item = this.get(id),
      parent = this.get(parentId)
    if (!Number.isInteger(index) || index < 0 || index > parent.children.length)
      throw new Error('Invalid menu insertion index')
    if ([...this.roots.values()].includes(id)) throw new Error('Cannot reparent the window menu')
    let depth = 0
    for (
      let ancestor: MenuNode | undefined = parent;
      ancestor;
      ancestor = ancestor.parent ? this.get(ancestor.parent) : undefined
    ) {
      if (ancestor.id === id) throw new Error('Cyclic menu hierarchy')
      if (++depth > 64) throw new Error('Menu hierarchy exceeds depth budget')
    }
    const descendants: { id: number; depth: number }[] = [{ id, depth }]
    while (descendants.length) {
      const child = descendants.pop()!
      if (child.depth > 64) throw new Error('Menu hierarchy exceeds depth budget')
      for (const id of this.get(child.id).children) descendants.push({ id, depth: child.depth + 1 })
    }
    if (item.parent) this.remove(item.parent, id)
    if (!this.commands.has(id)) this.allocateCommand(id)
    parent.children.splice(index, 0, id)
    item.parent = parentId
    this.set(id, 'checked', Number(item.checked))
  }
  remove(parentId: number, id: number): void {
    const parent = this.get(parentId),
      item = this.get(id)
    const index = parent.children.indexOf(id)
    if (index < 0) throw new Error('MenuItem is not a child of this parent')
    this.dismissSubtree(id)
    parent.children.splice(index, 1)
    item.parent = 0
    this.revision++
  }
  destroy(id: number): void {
    const item = this.get(id)
    this.dismissSubtree(id)
    if (item.parent) this.remove(item.parent, id)
    for (const child of [...item.children]) this.destroy(child)
    this.releaseCommand(id)
    this.nodes.delete(id)
    this.forgetRoot(id)
    this.revision++
  }
  /** Release one platform node. Script-owned descendants have independent
   * lifetimes and are detached until their own native invalidation runs. */
  detach(id: number): void {
    const item = this.get(id)
    this.dismissSubtree(id)
    if (item.parent) this.remove(item.parent, id)
    for (const child of item.children) this.get(child).parent = 0
    this.releaseCommand(id)
    this.nodes.delete(id)
    this.forgetRoot(id)
    this.revision++
  }
  selectable(id: number): boolean {
    const item = this.nodes.get(id)
    if (!item || item.caption === '-' || item.children.length) return false
    for (let current = item; ; current = this.get(current.parent)) {
      if (!current.visible || !current.enabled) return false
      if (!current.parent) return this.windowId(current.id) !== undefined
    }
  }
  /** Native command delivery checks current enabled ancestry, independently of
   * the visible leaf/attachment restrictions used for fresh UI selection. */
  canNotify(id: number): boolean {
    const item = this.nodes.get(id)
    if (!item) return false
    for (let current = item; ; current = this.get(current.parent)) {
      if (!current.enabled) return false
      if (!current.parent) return true
    }
  }
  beginPopup(id: number, flags: number, x: number, y: number): MenuPopupHandle | undefined {
    const item = this.get(id),
      windowId = this.windowId(id)
    if ([...this.roots.values()].includes(id) || !item.visible)
      throw new Error('This menu cannot be shown as a popup')
    if (windowId === undefined) throw new Error('Popup menus must be attached to Window.menu')
    if (this.popups.length && !(flags & 1)) return
    const requestId = this.nextPopup++
    const popup: MenuPopup = Object.freeze({ id, flags, x, y, windowId, requestId })
    let resolve!: (value: number) => void
    const result = new Promise<number>((settle) => {
      resolve = settle
    })
    const record: PopupRecord = { popup, resolve, outcome: 'pending' }
    this.popups.push(record)
    this.revision++
    return {
      popup,
      result,
      get outcome() {
        return record.outcome
      },
      get selectedCommand() {
        return record.selectedCommand
      },
    }
  }
  openPopup(id: number, flags: number, x: number, y: number): Promise<number> {
    const handle = this.beginPopup(id, flags, x, y)
    return handle
      ? handle.result.finally(() => this.releasePopup(handle.popup))
      : Promise.resolve(0)
  }
  releasePopup(identity: MenuPopupIdentity): void {
    const index = this.popups.findIndex(
      ({ popup }) => popup.windowId === identity.windowId && popup.requestId === identity.requestId,
    )
    if (index < 0) return
    if (index !== this.popups.length - 1) throw new Error('Popup scopes must release in LIFO order')
    const popup = this.popups.pop()!
    // A scope may be torn down before the user supplies a result.
    this.settle(popup, 0, 'unavailable')
    this.revision++
  }
  private settle(
    popup: PopupRecord,
    value: number,
    outcome: Exclude<MenuPopupOutcome, 'pending'>,
  ): void {
    if (popup.outcome !== 'pending') return
    popup.outcome = outcome
    this.revision++
    popup.resolve(value)
  }
  choose(id: number, windowId?: number, requestId?: number): boolean {
    const current = this.popups.at(-1)
    if (windowId !== undefined && this.windowId(id) !== windowId) return false
    if (requestId !== undefined && current?.popup.requestId !== requestId) return false
    if (!this.selectable(id)) return false
    if (!current) return true
    if (current.outcome !== 'pending') return false
    if (windowId !== undefined && current.popup.windowId !== windowId) return false
    let item = this.get(id)
    while (item.id !== current.popup.id && item.parent) item = this.get(item.parent)
    if (item.id !== current.popup.id) return false
    current.selectedCommand = this.command(id)
    this.settle(current, id, 'selected')
    return false // The owning popup scope completes the selection.
  }
  get hasPopup(): boolean {
    return this.popups.length !== 0
  }
  dismiss(
    windowId?: number,
    requestId?: number,
    reason: 'dismissed' | 'unavailable' = 'dismissed',
  ): void {
    for (const popup of [...this.popups].reverse()) {
      if (windowId !== undefined && popup.popup.windowId !== windowId) continue
      if (requestId !== undefined && popup.popup.requestId !== requestId) continue
      this.settle(popup, 0, reason)
    }
  }
  snapshot(windowId = 0): MenuSnapshot {
    const visit = (id: number): MenuView => {
      const { parent: _parent, group: _group, children, ...item } = this.get(id)
      return { ...item, children: children.map(visit) }
    }
    const root = this.roots.get(windowId),
      current = this.popups.at(-1),
      popup = current?.outcome === 'pending' ? current.popup : undefined
    return {
      root: root ? visit(root) : undefined,
      popup:
        popup?.windowId === windowId
          ? {
              id: popup.id,
              windowId: popup.windowId,
              requestId: popup.requestId,
              x: popup.x,
              y: popup.y,
              flags: popup.flags,
            }
          : undefined,
    }
  }
  snapshots(): WindowMenus[] {
    return [...this.roots.keys()].map((windowId) => ({ windowId, menus: this.snapshot(windowId) }))
  }
  clear(): void {
    this.dismiss(undefined, undefined, 'unavailable')
    this.popups = []
    this.nodes.clear()
    this.commands.clear()
    this.usedCommands.clear()
    this.roots.clear()
    this.revision++
  }
}
