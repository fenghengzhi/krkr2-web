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
  private roots = new Map<number, number>()
  private nextPopup = 1
  private popup?: MenuPopup & { resolve(value: number): void }
  revision = 0
  create(caption: string): number {
    if (this.nodes.size >= 4096) throw new Error('Menu item budget exceeded')
    const id = this.nextId++
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
    this.dismiss(windowId)
    this.roots.set(windowId, id)
    this.revision++
  }
  hideRoot(windowId = 0): void {
    this.dismiss(windowId)
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
    parent.children.splice(index, 0, id)
    item.parent = parentId
    this.set(id, 'checked', Number(item.checked))
  }
  remove(parentId: number, id: number): void {
    const parent = this.get(parentId),
      item = this.get(id)
    const index = parent.children.indexOf(id)
    if (index < 0) throw new Error('MenuItem is not a child of this parent')
    if (this.popup && this.contains(id, this.popup.id)) this.dismiss()
    parent.children.splice(index, 1)
    item.parent = 0
    this.revision++
  }
  destroy(id: number): void {
    const item = this.get(id)
    if (item.parent) this.remove(item.parent, id)
    for (const child of [...item.children]) this.destroy(child)
    if (this.popup?.id === id) this.dismiss()
    this.nodes.delete(id)
    this.forgetRoot(id)
    this.revision++
  }
  /** Release one platform node. Script-owned descendants have independent
   * lifetimes and are detached until their own native invalidation runs. */
  detach(id: number): void {
    const item = this.get(id)
    if (this.popup && this.contains(id, this.popup.id)) this.dismiss()
    if (item.parent) this.remove(item.parent, id)
    for (const child of item.children) this.get(child).parent = 0
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
  openPopup(id: number, flags: number, x: number, y: number): Promise<number> {
    this.dismiss()
    const item = this.get(id),
      windowId = this.windowId(id)
    if ([...this.roots.values()].includes(id) || !item.visible)
      throw new Error('This menu cannot be shown as a popup')
    if (windowId === undefined) throw new Error('Popup menus must be attached to Window.menu')
    const requestId = this.nextPopup++
    this.revision++
    return new Promise((resolve) => {
      this.popup = { id, flags, x, y, windowId, requestId, resolve }
    })
  }
  choose(id: number, windowId?: number, requestId?: number): boolean {
    if (windowId !== undefined && this.windowId(id) !== windowId) return false
    if (requestId !== undefined && this.popup?.requestId !== requestId) return false
    if (!this.selectable(id)) return false
    if (!this.popup) return true
    let item = this.get(id)
    while (item.id !== this.popup.id && item.parent) item = this.get(item.parent)
    if (item.id !== this.popup.id) return false
    const popup = this.popup
    this.popup = undefined
    this.revision++
    popup.resolve(id)
    return false // popup's suspended TJS caller dispatches the selection
  }
  get hasPopup(): boolean {
    return !!this.popup
  }
  dismiss(windowId?: number, requestId?: number): void {
    const popup = this.popup
    if (windowId !== undefined && popup?.windowId !== windowId) return
    if (requestId !== undefined && popup?.requestId !== requestId) return
    this.popup = undefined
    if (popup) {
      this.revision++
      popup.resolve(0)
    }
  }
  snapshot(windowId = 0): MenuSnapshot {
    const visit = (id: number): MenuView => {
      const { parent: _parent, group: _group, children, ...item } = this.get(id)
      return { ...item, children: children.map(visit) }
    }
    const root = this.roots.get(windowId)
    return {
      root: root ? visit(root) : undefined,
      popup:
        this.popup?.windowId === windowId
          ? {
              id: this.popup.id,
              windowId: this.popup.windowId,
              requestId: this.popup.requestId,
              x: this.popup.x,
              y: this.popup.y,
              flags: this.popup.flags,
            }
          : undefined,
    }
  }
  snapshots(): WindowMenus[] {
    return [...this.roots.keys()].map((windowId) => ({ windowId, menus: this.snapshot(windowId) }))
  }
  clear(): void {
    this.dismiss()
    this.nodes.clear()
    this.roots.clear()
    this.revision++
  }
}
