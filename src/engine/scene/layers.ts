import type { Pixels, Rect } from '../ports/graphics.ts'
import { Bitmap, dimension, intersect, textOpacity } from '../graphics/bitmap.ts'
import { imageTypes, autoFace, neutralColor } from '../graphics/blend.ts'

export interface LayerState {
  windowId: number
  managerId: number
  childrenRevision: number
  id: number
  parent: number
  primary: boolean
  children: number[]
  left: number
  top: number
  width: number
  height: number
  visible: boolean
  opacity: number
  imageLeft: number
  imageTop: number
  bitmap?: Bitmap
  /** Native ClipRect survives deletion of MainImage, without retaining pixels. */
  clipBeforeRelease: Rect
  revision: number
  type: number
  neutralColor: number
  face: number
  holdAlpha: boolean
  imageModified: boolean
  absoluteOrderMode: boolean
  absolute: number
  enabled: boolean
  focusable: boolean
  joinFocusChain: boolean
  hitType: number
  hitThreshold: number
  cursor: number
  name: string
  hint: string
  showParentHint: boolean
  cached: boolean
  callOnPaint: boolean
  attentionLeft: number
  attentionTop: number
  useAttention: boolean
  imeMode: number
}
const MAX_BYTES = 64 * 1024 * 1024
const noImageTypes = new Set([0, 6, 7])
export class LayerTree {
  has(id: number): boolean {
    return this.layers.has(id)
  }
  private layers = new Map<number, LayerState>()
  private nextId = 1
  ids(): number[] {
    return [...this.layers.keys()]
  }
  contains(root: number, id: number): boolean {
    for (let item = this.layers.get(id); item; item = this.layers.get(item.parent))
      if (item.id === root) return true
    return false
  }
  exchange(first: number, second: number, withChildren: boolean): void {
    if (first === second) return
    const a = this.get(first),
      b = this.get(second)
    // Native Join retains each Layer's manager and rejects crossing a primary
    // tree. Two primary roots can exchange complete subtrees without a Join.
    // Reject the other cross-manager cases before mutating either hierarchy.
    if (
      a.managerId !== b.managerId &&
      (!a.primary ||
        !b.primary ||
        a.parent !== 0 ||
        b.parent !== 0 ||
        (!withChildren && (a.children.length !== 0 || b.children.length !== 0)))
    )
      throw new Error('Cannot exchange Layers across primary managers')
    const old = new Map(
      this.ids().map((id) => {
        const layer = this.get(id)
        return [id, { parent: layer.parent, children: [...layer.children], primary: layer.primary }]
      }),
    )
    const swap = (id: number) => (id === first ? second : id === second ? first : id)
    if (!withChildren) {
      // Permute the two vertices while retaining every tree position. This
      // also handles a primary layer or an ancestor/descendant pair.
      for (const id of this.ids()) {
        const source = old.get(swap(id))!,
          layer = this.get(id)
        layer.parent = swap(source.parent)
        layer.children = source.children.map(swap)
        layer.primary = source.primary
      }
    } else {
      let ancestor = 0,
        descendant = 0,
        branch = 0
      if (this.contains(first, second)) {
        ancestor = first
        descendant = second
      } else if (this.contains(second, first)) {
        ancestor = second
        descendant = first
      }
      if (ancestor) {
        branch = descendant
        while (old.get(branch)!.parent !== ancestor) branch = old.get(branch)!.parent
      }
      for (const id of this.ids()) {
        const layer = this.get(id),
          source = old.get(id)!
        if (id !== first && id !== second) layer.children = source.children.map(swap)
      }
      a.parent = old.get(second)!.parent
      b.parent = old.get(first)!.parent
      a.primary = old.get(second)!.primary
      b.primary = old.get(first)!.primary
      if (ancestor) {
        const upper = this.get(ancestor),
          lower = this.get(descendant)
        upper.children = old.get(ancestor)!.children.filter((id) => id !== branch)
        lower.children = [
          ...old.get(descendant)!.children,
          branch === descendant ? ancestor : branch,
        ]
        if (branch === descendant) upper.parent = descendant
        else this.get(branch).parent = descendant
      }
    }
    ;[a.left, b.left] = [b.left, a.left]
    ;[a.top, b.top] = [b.top, a.top]
    ;[a.visible, b.visible] = [b.visible, a.visible]
    ;[a.absolute, b.absolute] = [b.absolute, a.absolute]
    for (const layer of this.layers.values()) {
      const previous = old.get(layer.id)!.children
      if (
        layer.children.length !== previous.length ||
        layer.children.some((child, index) => child !== previous[index])
      )
        layer.childrenRevision++
    }
  }
  create(parent: number, windowId = 0): number {
    if (parent) this.get(parent)
    if (this.layers.size >= 1024) throw new Error('Layer limit exceeded')
    this.budget(32 * 32 * 4)
    const id = this.nextId++,
      layer: LayerState = {
        windowId: parent ? this.get(parent).windowId : windowId,
        managerId: parent ? this.get(parent).managerId : id,
        childrenRevision: 0,
        id,
        parent,
        primary: !parent,
        children: [],
        left: 0,
        top: 0,
        width: 32,
        height: 32,
        visible: !parent,
        opacity: 255,
        imageLeft: 0,
        imageTop: 0,
        bitmap: new Bitmap(32, 32),
        clipBeforeRelease: { x: 0, y: 0, width: 32, height: 32 },
        revision: 0,
        type: parent ? 2 : 1,
        // Construct promotes a primary's neutral color after allocating the
        // shared transparent-white default image. It does not refill it.
        neutralColor: parent ? neutralColor(2) : 0xffffffff,
        face: 128,
        holdAlpha: false,
        imageModified: true,
        absoluteOrderMode: false,
        absolute: 0,
        enabled: true,
        focusable: false,
        joinFocusChain: true,
        hitType: 0,
        hitThreshold: parent ? 16 : 0,
        cursor: 0,
        name: '',
        hint: '',
        showParentHint: true,
        cached: false,
        callOnPaint: false,
        attentionLeft: 0,
        attentionTop: 0,
        useAttention: false,
        imeMode: 0,
      }
    this.layers.set(id, layer)
    if (parent) {
      const owner = this.get(parent)
      owner.children.push(id)
      owner.childrenRevision++
      layer.absolute = owner.children.length - 1
    }
    return id
  }
  get(id: number): LayerState {
    const layer = this.layers.get(id)
    if (!layer) throw new Error(`Layer does not exist: ${id}`)
    return layer
  }
  localPoint(id: number, x: number, y: number): { x: number; y: number } {
    let layer = this.get(id)
    while (true) {
      x -= layer.left
      y -= layer.top
      if (!layer.parent) break
      layer = this.get(layer.parent)
    }
    return { x, y }
  }
  bitmap(id: number): Bitmap {
    const bitmap = this.get(id).bitmap
    if (!bitmap) throw new Error('This layer has no drawable image')
    return bitmap
  }
  private budget(extra: number): void {
    if (this.inspect().bitmapBytes + extra > MAX_BYTES)
      throw new Error('Layer bitmaps exceed 64 MiB budget')
  }
  private neutral(layer: LayerState): number {
    return layer.neutralColor
  }
  /** Script updates mark onPaint even if their display region is empty. The
   * region requests presentation; it does not replace the bitmap drawing clip. */
  update(id: number, region?: Rect): boolean {
    let layer = this.get(id)
    layer.callOnPaint = true
    let left = region?.x ?? 0,
      top = region?.y ?? 0,
      right = left + (region?.width ?? layer.width),
      bottom = top + (region?.height ?? layer.height)
    while (true) {
      left = Math.max(0, left)
      top = Math.max(0, top)
      right = Math.min(layer.width, right)
      bottom = Math.min(layer.height, bottom)
      if (left >= right || top >= bottom || !layer.visible) return false
      if (!layer.parent) return layer.primary
      left += layer.left
      top += layer.top
      right += layer.left
      bottom += layer.top
      layer = this.get(layer.parent)
    }
  }
  private resizeBitmap(layer: LayerState, width: number, height: number): void {
    const bitmap = layer.bitmap!
    dimension(width)
    dimension(height)
    if (bitmap.width === width && bitmap.height === height) return
    this.budget(width * height * (bitmap.province ? 5 : 4) - bitmap.bytes)
    bitmap.resize(width, height, this.neutral(layer))
    layer.imageModified = true
    layer.revision++
  }
  resize(id: number, width: number, height: number): void {
    dimension(width)
    dimension(height)
    const layer = this.get(id),
      bitmap = layer.bitmap
    if (bitmap) {
      this.resizeBitmap(layer, Math.max(width, bitmap.width), Math.max(height, bitmap.height))
      layer.imageLeft = Math.max(layer.imageLeft, width - bitmap.width)
      layer.imageTop = Math.max(layer.imageTop, height - bitmap.height)
    }
    layer.width = width
    layer.height = height
  }
  resizeImage(id: number, width: number, height: number): void {
    const layer = this.get(id)
    this.bitmap(id)
    this.resizeBitmap(layer, width, height)
    layer.width = Math.min(layer.width, width)
    layer.height = Math.min(layer.height, height)
    layer.imageLeft = Math.max(layer.imageLeft, layer.width - width)
    layer.imageTop = Math.max(layer.imageTop, layer.height - height)
  }
  imagePosition(id: number, left: number, top: number): void {
    const layer = this.get(id),
      bitmap = this.bitmap(id)
    if (
      !Number.isInteger(left) ||
      !Number.isInteger(top) ||
      left > 0 ||
      top > 0 ||
      left + bitmap.width < layer.width ||
      top + bitmap.height < layer.height
    )
      throw new Error('Image offset must keep the display rectangle inside the image')
    layer.imageLeft = left
    layer.imageTop = top
  }
  property(id: number, name: string): string | number | boolean {
    const layer = this.get(id)
    if (name === 'imageWidth') return this.bitmap(id).width
    if (name === 'imageHeight') return this.bitmap(id).height
    if (name === 'hasImage') return !!layer.bitmap
    if (name === 'isPrimary') return layer.primary
    if (name === 'order') return layer.parent ? this.get(layer.parent).children.indexOf(id) : 0
    if (name === 'absolute')
      return layer.parent && this.get(layer.parent).absoluteOrderMode
        ? layer.absolute
        : this.property(id, 'order')
    if (name === 'nodeVisible' || name === 'nodeEnabled') {
      let item = layer
      while (true) {
        if (name === 'nodeVisible' ? !item.visible : !item.enabled) return false
        if (!item.parent) return true
        item = this.get(item.parent)
      }
    }
    if (name === 'neutralColor') return this.neutral(layer)
    if (name.startsWith('clip')) {
      const clip = this.bitmap(id).clip
      const key = { clipLeft: 'x', clipTop: 'y', clipWidth: 'width', clipHeight: 'height' }[
        name
      ] as keyof Rect | undefined
      if (key) return clip[key]
    }
    const value = layer[name as keyof LayerState]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      return value
    throw new Error(`Unsupported Layer property: ${name}`)
  }
  set(id: number, name: string, value: number | string): void {
    const layer = this.get(id)
    if (['name', 'hint'].includes(name)) {
      layer[name as 'name'] = String(value)
      return
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
      throw new Error(`Invalid Layer.${name}`)
    if (name === 'neutralColor') layer.neutralColor = value >>> 0
    else if (name === 'width' || name === 'height')
      this.resize(
        id,
        name === 'width' ? value : layer.width,
        name === 'height' ? value : layer.height,
      )
    else if (name === 'imageWidth' || name === 'imageHeight')
      this.resizeImage(
        id,
        name === 'imageWidth' ? value : this.bitmap(id).width,
        name === 'imageHeight' ? value : this.bitmap(id).height,
      )
    else if (name === 'imageLeft' || name === 'imageTop')
      this.imagePosition(
        id,
        name === 'imageLeft' ? value : layer.imageLeft,
        name === 'imageTop' ? value : layer.imageTop,
      )
    else if (name === 'left' || name === 'top') {
      if (layer.primary && value !== 0) throw new Error('The primary layer cannot move')
      layer[name] = value
    } else if (name === 'visible') {
      if (layer.primary && !value) throw new Error('The primary layer must remain visible')
      layer.visible = !!value
    } else if (name === 'opacity') {
      if (layer.primary && value !== 255) throw new Error('The primary layer must remain opaque')
      layer.opacity = Math.max(0, Math.min(255, value))
    } else if (name === 'type') {
      if (layer.type === value) return
      if (!imageTypes.has(value) && !noImageTypes.has(value))
        throw new Error(`Layer blend type ${value} is not implemented`)
      layer.type = value
      layer.neutralColor = neutralColor(value)
      this.set(id, 'hasImage', Number(imageTypes.has(value)))
    } else if (name === 'hasImage') {
      if (value && !imageTypes.has(layer.type))
        throw new Error('This layer type cannot own an image')
      if (value && !layer.bitmap) {
        this.budget(layer.width * layer.height * 4)
        layer.bitmap = new Bitmap(layer.width, layer.height, this.neutral(layer))
        layer.imageLeft = layer.imageTop = 0
      } else if (!value) {
        if (layer.bitmap) layer.clipBeforeRelease = { ...layer.bitmap.clip }
        layer.bitmap = undefined
      }
      // AllocateImage resets the drawing clip even when the backing image
      // already exists. Its pixels, province and image offset remain intact.
      if (value) layer.bitmap!.resetClip()
      layer.revision++
      layer.imageModified = true
    } else if (name === 'order' || name === 'absolute') this.order(id, value, name === 'absolute')
    else if (name === 'absoluteOrderMode') {
      if (value && !layer.absoluteOrderMode)
        layer.children.forEach((id, index) => {
          this.get(id).absolute = index
        })
      layer.absoluteOrderMode = !!value
    } else if (name.startsWith('clip')) {
      const clip = { ...this.bitmap(id).clip },
        key = { clipLeft: 'x', clipTop: 'y', clipWidth: 'width', clipHeight: 'height' }[name] as
          keyof Rect | undefined
      if (!key) throw new Error(`Invalid Layer.${name}`)
      clip[key] = value
      this.bitmap(id).setClip(clip)
    } else if (
      [
        'enabled',
        'focusable',
        'joinFocusChain',
        'holdAlpha',
        'cached',
        'callOnPaint',
        'showParentHint',
        'useAttention',
        'imageModified',
      ].includes(name)
    )
      layer[name as 'enabled'] = !!value
    else if (
      [
        'face',
        'hitType',
        'hitThreshold',
        'cursor',
        'attentionLeft',
        'attentionTop',
        'imeMode',
      ].includes(name)
    ) {
      if (name === 'face' && ![0, 1, 2, 3, 4, 128].includes(value))
        throw new Error('Invalid drawing face')
      if (name === 'hitType' && ![0, 1].includes(value)) throw new Error('Invalid hit type')
      layer[name as 'face'] = value
    } else throw new Error(`Unsupported Layer property: ${name}`)
  }
  validateParent(id: number, parent: number): void {
    const layer = this.get(id)
    if (layer.primary) throw new Error('The primary layer cannot be reparented')
    if (parent && this.get(parent).managerId !== layer.managerId)
      throw new Error('Cannot move a Layer under another primary layer')
    for (
      let item = parent ? this.get(parent) : undefined, depth = 0;
      item;
      item = item.parent ? this.get(item.parent) : undefined
    ) {
      if (item.id === id) throw new Error('Cyclic layer hierarchy')
      if (++depth > 64) throw new Error('Layer depth limit exceeded')
    }
  }
  reparent(id: number, parent: number): void {
    this.validateParent(id, parent)
    const layer = this.get(id)
    if (layer.parent) {
      const children = this.get(layer.parent).children
      children.splice(children.indexOf(id), 1)
      this.get(layer.parent).childrenRevision++
    }
    layer.parent = parent
    if (parent) {
      const owner = this.get(parent)
      owner.children.push(id)
      owner.childrenRevision++
      layer.absolute = owner.children.length - 1
    }
  }
  order(id: number, index: number, absolute = false): void {
    const layer = this.get(id)
    if (!layer.parent) throw new Error('This layer has no siblings')
    const parent = this.get(layer.parent)
    const previous = [...parent.children]
    this.set(parent.id, 'absoluteOrderMode', Number(absolute))
    const children = parent.children
    children.splice(children.indexOf(id), 1)
    if (absolute) {
      layer.absolute = index
      const at = children.findIndex((id) => this.get(id).absolute >= index)
      children.splice(at < 0 ? children.length : at, 0, id)
    } else children.splice(Math.max(0, Math.min(children.length, index)), 0, id)
    if (children.some((child, at) => child !== previous[at])) parent.childrenRevision++
  }
  move(id: number, other: number, before: boolean): void {
    const layer = this.get(id),
      sibling = this.get(other)
    if (!layer.parent || layer.parent !== sibling.parent)
      throw new Error('Layer ordering requires siblings')
    if (id === other) return
    const children = this.get(layer.parent).children,
      from = children.indexOf(id),
      target = children.indexOf(other)
    this.order(id, target + (before ? (from > target ? 1 : 0) : from < target ? -1 : 0))
  }
  image(id: number, pixels: Pixels, province?: Uint8Array): void {
    const layer = this.get(id)
    const old = this.bitmap(id)
    dimension(pixels.width)
    dimension(pixels.height)
    if (pixels.data.length !== pixels.width * pixels.height * 4)
      throw new Error('Invalid RGBA image')
    if (province && province.length !== pixels.width * pixels.height)
      throw new Error('Invalid province plane')
    this.budget(pixels.data.length + (province?.length ?? 0) - old.bytes)
    const bitmap = new Bitmap(pixels.width, pixels.height)
    bitmap.pixels.data.set(pixels.data)
    bitmap.province = province?.slice()
    layer.bitmap = bitmap
    this.resizeImage(id, pixels.width, pixels.height)
    layer.imageModified = true
    layer.revision++
  }
  provinceImage(id: number, province: Uint8Array): void {
    const bitmap = this.bitmap(id)
    if (province.length !== bitmap.width * bitmap.height) throw new Error('Invalid province plane')
    this.budget(province.length - (bitmap.province?.length ?? 0))
    bitmap.province = province.slice()
    bitmap.touch()
    this.get(id).imageModified = true
  }
  assignImages(id: number, source: number): boolean {
    const layer = this.get(id),
      bitmap = this.get(source).bitmap
    if (!bitmap) {
      this.set(id, 'hasImage', 0)
      return true
    }
    if (id === source) {
      bitmap.resetClip()
      layer.imageModified = true
      // Native bitmap Assign reports no main-image change for self-assignment,
      // but Layer.AssignImages still resets its clip and modified flag.
      return false
    }
    this.budget(bitmap.bytes - (layer.bitmap?.bytes ?? 0))
    // AssignImages copies the image directly, even for a binder. AllocateImage
    // would wrongly reject that type and reset the destination image offset.
    const dest = new Bitmap(bitmap.width, bitmap.height)
    dest.pixels.data.set(bitmap.pixels.data)
    dest.province = bitmap.province?.slice()
    layer.bitmap = dest
    // InternalSetImageSize keeps the destination geometry when it still fits,
    // otherwise shrinking the display and moving its viewport inside the image.
    layer.width = Math.min(layer.width, dest.width)
    layer.height = Math.min(layer.height, dest.height)
    layer.imageLeft = Math.max(layer.imageLeft, layer.width - dest.width)
    layer.imageTop = Math.max(layer.imageTop, layer.height - dest.height)
    layer.revision++
    layer.imageModified = true
    return true
  }
  face(id: number): number {
    const layer = this.get(id)
    return layer.face === 128 ? autoFace(layer.type) : layer.face
  }
  fill(id: number, rect: Rect, color: number): boolean {
    const layer = this.get(id),
      target = intersect(layer.bitmap?.clip ?? layer.clipBeforeRelease, rect)
    // Native FillRect clips before looking for the plane it would write.
    if (!target.width || !target.height) return false
    const bitmap = this.bitmap(id),
      face = this.face(id)
    if (face === 3 && !bitmap.province && color & 255) this.budget(bitmap.width * bitmap.height)
    if (bitmap.fill(rect, color, face, layer.holdAlpha)) layer.imageModified = true
    return true
  }
  textOpacity(id: number, opacity: number): number {
    // Check before FontService can resolve a file or ask the glyph backend.
    this.bitmap(id)
    return textOpacity(this.face(id), opacity)
  }
  composite(id: number, image: Pixels, left: number, top: number, opacity = 255): boolean {
    const layer = this.get(id),
      bitmap = this.bitmap(id),
      face = this.face(id)
    const drawn = bitmap.composite(
      image,
      Math.trunc(left),
      Math.trunc(top),
      face,
      opacity,
      layer.holdAlpha,
    )
    if (drawn) layer.imageModified = true
    return drawn
  }
  color(id: number, rect: Rect, color: number, opacity: number): void {
    const bitmap = this.bitmap(id),
      face = this.face(id)
    if (face === 3 && !bitmap.province && color & 255) this.budget(bitmap.width * bitmap.height)
    bitmap.color(rect, color, opacity, face)
    this.get(id).imageModified = true
  }
  copy(id: number, left: number, top: number, source: number, rect: Rect): boolean {
    const layer = this.get(id)
    // The source must still be a live Layer even when no pixels are requested.
    this.get(source)
    const target = intersect(layer.bitmap?.clip ?? layer.clipBeforeRelease, {
      x: left,
      y: top,
      width: rect.width,
      height: rect.height,
    })
    if (!target.width || !target.height) return false
    // Only the destination clip participates in this preflight. Missing main
    // images still throw before the bitmap clips against source dimensions.
    const dest = this.bitmap(id),
      face = this.face(id)
    if (face === 3 && !dest.province) this.budget(dest.width * dest.height)
    if (dest.copy(this.bitmap(source), left, top, rect, face, layer.holdAlpha))
      layer.imageModified = true
    // Native requests an update for this destination even when the source
    // bitmap clips the actual transfer to empty. This is not imageModified.
    return true
  }
  setPixel(
    id: number,
    x: number,
    y: number,
    value: number,
    plane: 'main' | 'mask' | 'province',
  ): boolean {
    const bitmap = this.bitmap(id)
    if (plane === 'province' && !bitmap.province) this.budget(bitmap.width * bitmap.height)
    const written = bitmap.setPixel(x, y, value, plane)
    // Province allocation has its own modified semantics; this slice changes
    // only the main/mask paths whose clip check follows the main-image check.
    if (written || plane === 'province') this.get(id).imageModified = true
    return written || plane === 'province'
  }
  *hitCandidates(
    x: number,
    y: number,
    root?: number,
    excludeSelf = false,
  ): Generator<{ id: number; x: number; y: number }> {
    const tree = this
    function* visit(
      id: number,
      x: number,
      y: number,
    ): Generator<{ id: number; x: number; y: number }> {
      if (!tree.has(id)) return
      const layer = tree.get(id)
      if (!layer.visible || x < 0 || y < 0 || x >= layer.width || y >= layer.height) return
      for (const child of [...layer.children].reverse()) {
        if (!tree.has(child)) continue
        const item = tree.get(child)
        if (item.parent === id) yield* visit(child, x - item.left, y - item.top)
      }
      if (!tree.has(id)) return
      if (excludeSelf && id === root) return
      const ix = Math.floor(x - layer.imageLeft),
        iy = Math.floor(y - layer.imageTop),
        bitmap = layer.bitmap
      const inImage = bitmap && ix >= 0 && iy >= 0 && ix < bitmap.width && iy < bitmap.height
      const hit =
        layer.hitType === 1
          ? inImage && bitmap.getPixel(ix, iy, 'province') !== 0
          : bitmap
            ? inImage && bitmap.getPixel(ix, iy, 'mask') >= layer.hitThreshold
            : layer.hitThreshold <= 0
      if (hit) yield { id, x, y }
    }
    if (root) yield* visit(root, x, y)
    else
      for (const layer of [...this.layers.values()].reverse())
        if (layer.primary) yield* visit(layer.id, x, y)
  }
  hitTest(
    x: number,
    y: number,
    root?: number,
    excludeSelf = false,
    getDisabled = false,
  ): { id: number; x: number; y: number } | undefined {
    for (const hit of this.hitCandidates(x, y, root, excludeSelf))
      return getDisabled || this.property(hit.id, 'nodeEnabled') ? hit : undefined
  }
  destroy(id: number): void {
    this.detach(id)
    this.layers.delete(id)
  }
  /** Detach raw tree edges while keeping image/font data available to the
   * remaining native invalidation callbacks. Children remain valid. */
  detach(id: number): void {
    const layer = this.get(id)
    if (layer.parent) {
      const children = this.get(layer.parent).children
      children.splice(children.indexOf(id), 1)
      this.get(layer.parent).childrenRevision++
    }
    for (const child of layer.children) this.get(child).parent = 0
    layer.parent = 0
    layer.primary = false
    layer.children = []
    layer.childrenRevision++
  }
  invalidateChildren(id: number): void {
    this.get(id).childrenRevision++
  }
  inspect(): { layers: number; bitmapBytes: number } {
    let bitmapBytes = 0
    for (const layer of this.layers.values()) bitmapBytes += layer.bitmap?.bytes ?? 0
    return { layers: this.layers.size, bitmapBytes }
  }
  clear(): void {
    this.layers.clear()
  }
}
