import type { Pixels, Rect } from '../ports/graphics.ts'
import { Bitmap, dimension, intersect, textOpacity } from '../graphics/bitmap.ts'
import { ProvincePlane } from '../graphics/province.ts'
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
  province?: ProvincePlane
  /** Invalidates a suspended province load when its destination is replaced. */
  provinceGeneration: number
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
export interface ProvinceImageLoad {
  readonly layer: LayerState
  readonly bitmap: Bitmap
  readonly generation: number
  readonly width: number
  readonly height: number
}
export interface LayerImageLoad extends ProvinceImageLoad {
  readonly bitmapRevision: number
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
        provinceGeneration: 0,
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
  private clip(layer: LayerState): Rect {
    return layer.bitmap?.clip ?? layer.clipBeforeRelease
  }
  private bytes(layer: LayerState): number {
    return (layer.bitmap?.bytes ?? 0) + (layer.province?.bytes ?? 0)
  }
  private resizedProvince(
    layer: LayerState,
    width: number,
    height: number,
  ): ProvincePlane | undefined {
    const current = layer.province
    if (!current || (current.width === width && current.height === height)) return current
    const replacement = current.clone()
    replacement.resize(width, height)
    return replacement
  }
  private allocateImage(layer: LayerState, color = this.neutral(layer)): void {
    const width = layer.bitmap?.width ?? layer.width,
      height = layer.bitmap?.height ?? layer.height
    this.budget(width * height * (layer.province ? 5 : 4) - this.bytes(layer))
    // Prepare both planes before publishing either replacement. The existing
    // MainImage object keeps its identity for active compositor operations.
    const province = this.resizedProvince(layer, width, height)
    const bitmap = layer.bitmap ?? new Bitmap(width, height, color)
    if (!layer.bitmap) layer.imageLeft = layer.imageTop = 0
    layer.bitmap = bitmap
    layer.province = province
    bitmap.resetClip()
    layer.provinceGeneration++
    layer.revision++
    layer.imageModified = true
  }
  releaseImages(id: number): void {
    const layer = this.get(id)
    if (layer.bitmap) layer.clipBeforeRelease = { ...layer.bitmap.clip }
    layer.bitmap = undefined
    layer.province = undefined
    layer.provinceGeneration++
    layer.revision++
    layer.imageModified = true
  }
  private allocateProvince(layer: LayerState): ProvincePlane {
    if (layer.province) return layer.province
    const width = layer.bitmap?.width ?? layer.width,
      height = layer.bitmap?.height ?? layer.height
    this.budget(width * height)
    layer.province = new ProvincePlane(width, height)
    layer.provinceGeneration++
    layer.imageModified = true
    return layer.province
  }
  independImage(id: number, _plane: 'main' | 'province'): void {
    // Every Web image is already exclusively owned. Native IndependNoCopy
    // also returns immediately for an independent image; false never clears it.
    this.get(id)
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
    this.budget(width * height * (layer.province ? 5 : 4) - this.bytes(layer))
    const province = this.resizedProvince(layer, width, height)
    bitmap.resize(width, height, this.neutral(layer))
    layer.province = province
    layer.provinceGeneration++
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
      const clip = this.clip(layer)
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
      const color = neutralColor(value)
      if (imageTypes.has(value)) this.allocateImage(layer, color)
      else this.releaseImages(id)
      layer.type = value
      layer.neutralColor = color
    } else if (name === 'hasImage') {
      if (value && !imageTypes.has(layer.type))
        throw new Error('This layer type cannot own an image')
      if (value) this.allocateImage(layer)
      else this.releaseImages(id)
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
    this.bitmap(id)
    dimension(pixels.width)
    dimension(pixels.height)
    if (pixels.data.length !== pixels.width * pixels.height * 4)
      throw new Error('Invalid RGBA image')
    if (province && province.length !== pixels.width * pixels.height)
      throw new Error('Invalid province plane')
    this.budget(pixels.data.length + (province?.length ?? 0) - this.bytes(layer))
    const bitmap = new Bitmap(pixels.width, pixels.height)
    bitmap.pixels.data.set(pixels.data)
    const plane = province ? new ProvincePlane(pixels.width, pixels.height, province) : undefined
    layer.bitmap = bitmap
    layer.province = plane
    layer.provinceGeneration++
    this.resizeImage(id, pixels.width, pixels.height)
    layer.imageModified = true
    layer.revision++
  }
  provinceImage(id: number, province: Uint8Array): void {
    const layer = this.get(id),
      bitmap = this.bitmap(id)
    if (province.length !== bitmap.width * bitmap.height) throw new Error('Invalid province plane')
    this.budget(province.length - (layer.province?.bytes ?? 0))
    layer.province = new ProvincePlane(bitmap.width, bitmap.height, province)
    layer.provinceGeneration++
    layer.imageModified = true
  }
  beginImageLoad(id: number): LayerImageLoad {
    const layer = this.get(id),
      bitmap = this.bitmap(id)
    layer.provinceGeneration++
    return {
      layer,
      bitmap,
      generation: layer.provinceGeneration,
      width: bitmap.width,
      height: bitmap.height,
      bitmapRevision: bitmap.revision,
    }
  }
  finishImageLoad(load: LayerImageLoad, pixels: Pixels, province?: Uint8Array): boolean {
    if (!this.provinceLoadMatches(load) || load.bitmap.revision !== load.bitmapRevision)
      return false
    this.image(load.layer.id, pixels, province)
    return true
  }
  beginProvinceImage(id: number): ProvinceImageLoad {
    const layer = this.get(id),
      bitmap = this.bitmap(id)
    this.budget(bitmap.width * bitmap.height - (layer.province?.bytes ?? 0))
    const province = layer.province
      ? this.resizedProvince(layer, bitmap.width, bitmap.height)!
      : new ProvincePlane(bitmap.width, bitmap.height)
    layer.province = province
    layer.provinceGeneration++
    layer.imageModified = true
    return {
      layer,
      bitmap,
      generation: layer.provinceGeneration,
      width: bitmap.width,
      height: bitmap.height,
    }
  }
  private provinceLoadMatches(load: ProvinceImageLoad): boolean {
    return (
      this.layers.get(load.layer.id) === load.layer &&
      load.layer.provinceGeneration === load.generation &&
      load.layer.bitmap === load.bitmap &&
      load.bitmap.width === load.width &&
      load.bitmap.height === load.height
    )
  }
  finishProvinceImage(load: ProvinceImageLoad, province: Uint8Array): boolean {
    if (!this.provinceLoadMatches(load)) return false
    this.provinceImage(load.layer.id, province)
    return true
  }
  failProvinceImage(load: ProvinceImageLoad): boolean {
    if (!this.provinceLoadMatches(load)) return false
    load.layer.province = undefined
    load.layer.provinceGeneration++
    load.layer.imageModified = true
    return true
  }
  assignImages(id: number, source: number): boolean {
    const layer = this.get(id),
      sourceLayer = this.get(source),
      bitmap = sourceLayer.bitmap
    if (!bitmap) {
      // Native first deletes destination MainImage and Province. For self
      // assignment that also removes the source Province before it is read.
      const province = id === source ? undefined : sourceLayer.province
      this.budget((province?.bytes ?? 0) - this.bytes(layer))
      const replacement = province?.clone()
      this.releaseImages(id)
      layer.province = replacement
      return true
    }
    if (id === source) {
      bitmap.resetClip()
      layer.imageModified = true
      // Native bitmap Assign reports no main-image change for self-assignment,
      // but Layer.AssignImages still resets its clip and modified flag.
      return false
    }
    this.budget(this.bytes(sourceLayer) - this.bytes(layer))
    // AssignImages copies the image directly, even for a binder. AllocateImage
    // would wrongly reject that type and reset the destination image offset.
    const dest = new Bitmap(bitmap.width, bitmap.height)
    dest.pixels.data.set(bitmap.pixels.data)
    const province = sourceLayer.province?.clone()
    layer.bitmap = dest
    layer.province = province
    layer.provinceGeneration++
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
      target = intersect(this.clip(layer), rect)
    // Native FillRect clips before looking for the plane it would write.
    if (!target.width || !target.height) return false
    const face = this.face(id)
    if (face === 3) {
      this.fillProvince(layer, target, color)
      return true
    }
    const bitmap = this.bitmap(id)
    if (bitmap.fill(rect, color, face, layer.holdAlpha)) layer.imageModified = true
    return true
  }
  private fillProvince(layer: LayerState, rect: Rect, color: number): void {
    const value = color & 255
    const plane = value ? this.allocateProvince(layer) : layer.province
    if (!plane) return
    if (
      !value &&
      rect.x === 0 &&
      rect.y === 0 &&
      rect.width === plane.width &&
      rect.height === plane.height
    ) {
      layer.province = undefined
      layer.provinceGeneration++
      layer.imageModified = true
    } else if (plane.fill(rect, value)) {
      layer.provinceGeneration++
      layer.imageModified = true
    }
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
  color(id: number, rect: Rect, color: number, opacity: number): boolean {
    const layer = this.get(id),
      face = this.face(id)
    if (face === 3) {
      const target = intersect(this.clip(layer), rect)
      if (!target.width || !target.height) return false
      this.fillProvince(layer, target, color)
      return true
    }
    const bitmap = this.bitmap(id)
    bitmap.color(rect, color, opacity, face)
    this.get(id).imageModified = true
    return true
  }
  copy(id: number, left: number, top: number, source: number, rect: Rect): boolean {
    const layer = this.get(id)
    // The source must still be a live Layer even when no pixels are requested.
    const sourceLayer = this.get(source)
    const target = intersect(this.clip(layer), {
      x: left,
      y: top,
      width: rect.width,
      height: rect.height,
    })
    if (!target.width || !target.height) return false
    // Only the destination clip participates in this preflight. Missing main
    // images still throw before the bitmap clips against source dimensions.
    const face = this.face(id)
    if (face === 3) {
      const clippedSource = {
        x: rect.x + target.x - left,
        y: rect.y + target.y - top,
        width: target.width,
        height: target.height,
      }
      if (!sourceLayer.province) {
        // This uses the adjusted source rectangle in the original engine,
        // rather than the destination point. A missing plane is not allocated.
        if (layer.province?.fill(clippedSource, 0)) layer.provinceGeneration++
        layer.imageModified = true
      } else {
        const sourcePlane = sourceLayer.province,
          dest = this.allocateProvince(layer)
        if (dest.copy(sourcePlane, target.x, target.y, clippedSource)) {
          layer.provinceGeneration++
          layer.imageModified = true
        }
      }
      return true
    }
    const dest = this.bitmap(id)
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
    const layer = this.get(id)
    if (plane === 'province') {
      // Allocate even for zero and before the saved Layer clip is inspected.
      const province = this.allocateProvince(layer),
        clip = this.clip(layer)
      if (x < clip.x || y < clip.y || x >= clip.x + clip.width || y >= clip.y + clip.height)
        return false
      province.setPixel(x, y, value)
      layer.provinceGeneration++
      layer.imageModified = true
      return true
    }
    const bitmap = this.bitmap(id)
    const written = bitmap.setPixel(x, y, value, plane)
    if (written) layer.imageModified = true
    return written
  }
  getPixel(id: number, x: number, y: number, plane: 'main' | 'mask' | 'province'): number {
    const layer = this.get(id)
    return plane === 'province'
      ? (layer.province?.getPixel(x, y) ?? 0)
      : this.bitmap(id).getPixel(x, y, plane)
  }
  flip(id: number, horizontal: boolean): void {
    const layer = this.get(id)
    this.bitmap(id).flip(horizontal)
    layer.province?.flip(horizontal)
    layer.provinceGeneration++
    layer.imageModified = true
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
          ? (layer.province?.getPixel(ix, iy) ?? 0) !== 0
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
    for (const layer of this.layers.values()) bitmapBytes += this.bytes(layer)
    return { layers: this.layers.size, bitmapBytes }
  }
  clear(): void {
    this.layers.clear()
  }
}
