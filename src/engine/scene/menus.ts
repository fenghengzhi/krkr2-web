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
  popup?: { id: number; x: number; y: number; flags: number }
}

export class MenuTree {
  has(id: number): boolean {
    return this.nodes.has(id)
  }
  private nodes = new Map<number, MenuNode>()
  private nextId = 1
  private root = 0
  private popup?: { id: number; x: number; y: number; flags: number; resolve(value: number): void }
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
  setRoot(id: number): void {
    this.get(id)
    this.root = id
    this.revision++
  }
  hideRoot(): void {
    this.dismiss()
    this.root = 0
    this.revision++
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
    if (id === this.root) throw new Error('Cannot reparent the window menu')
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
    if (this.root === id) this.root = 0
    this.revision++
  }
  /** Release one platform node. Script-owned descendants have independent
   * lifetimes and are detached until their own native invalidation runs. */
  detach(id: number): void {
    const item = this.get(id)
    if (this.popup) {
      for (let node = this.get(this.popup.id); ; node = this.get(node.parent)) {
        if (node.id === id) {
          this.dismiss()
          break
        }
        if (!node.parent) break
      }
    }
    if (item.parent) this.remove(item.parent, id)
    for (const child of item.children) this.get(child).parent = 0
    this.nodes.delete(id)
    if (this.root === id) this.root = 0
    this.revision++
  }
  selectable(id: number): boolean {
    const item = this.nodes.get(id)
    if (!item || item.caption === '-' || item.children.length) return false
    for (let current = item; ; current = this.get(current.parent)) {
      if (!current.visible || !current.enabled) return false
      if (!current.parent) return current.id === this.root
    }
  }
  openPopup(id: number, flags: number, x: number, y: number): Promise<number> {
    this.dismiss()
    let item = this.get(id)
    if (id === this.root || !item.visible) throw new Error('This menu cannot be shown as a popup')
    while (item.parent) item = this.get(item.parent)
    if (item.id !== this.root) throw new Error('Popup menus must be attached to Window.menu')
    this.revision++
    return new Promise((resolve) => {
      this.popup = { id, flags, x, y, resolve }
    })
  }
  choose(id: number): boolean {
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
  dismiss(): void {
    const popup = this.popup
    this.popup = undefined
    if (popup) {
      this.revision++
      popup.resolve(0)
    }
  }
  snapshot(): MenuSnapshot {
    const visit = (id: number): MenuView => {
      const { parent: _parent, group: _group, children, ...item } = this.get(id)
      return { ...item, children: children.map(visit) }
    }
    return {
      root: this.root ? visit(this.root) : undefined,
      popup: this.popup && {
        id: this.popup.id,
        x: this.popup.x,
        y: this.popup.y,
        flags: this.popup.flags,
      },
    }
  }
  clear(): void {
    this.dismiss()
    this.nodes.clear()
    this.root = 0
    this.revision++
  }
}
