import type { FrameLayer, Pixels, Rect } from '../ports/graphics.ts'
import { intersect } from '../graphics/bitmap.ts'
import { autoFace, blendPixel, neutralColor, usesAlpha } from '../graphics/blend.ts'
import { blendAlphaRow } from '../graphics/alpha-row.ts'
import { transitionPixels, type TransitionFrame } from '../graphics/transition.ts'
import type { LayerTree, LayerState } from './layers.ts'
import { completeLayer, type CompletedTransition } from './completion.ts'
interface Composed {
  pixels: Pixels
  revision: number
}
interface Cached extends Composed {
  signature: string
}
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const blank = (width: number, height: number): Pixels => ({
  width,
  height,
  data: new Uint8Array(width * height * 4),
})
const ordinary = (type: number) =>
  type === 1 || type === 2 || type === 12 || type === 0 || type === 6 || type === 7
// Effect and Filter also use native DisplayType=ltBinder. An assigned main
// image remains readable, but these types pass their children's drawing on.
const binder = (layer: LayerState): boolean =>
  layer.type === 0 || layer.type === 6 || layer.type === 7
const displayBitmap = (layer: LayerState) => (binder(layer) ? undefined : layer.bitmap)
// Opaque Layers still draw their own neutral-color rectangle without a main
// image. Other image-less Layers retain the existing transparent group backing.
const compositionType = (layer: LayerState): number =>
  displayBitmap(layer) || layer.type === 1 ? layer.type : 2
function forDisplay(image: Pixels, type: number): Pixels {
  const result = { ...image, data: image.data.slice() }
  if (type === 12) return result
  for (let at = 0; at < result.data.length; at += 4) {
    const alpha = usesAlpha(type) ? image.data[at + 3]! : 255
    result.data[at + 3] = alpha
    for (let c = 0; c < 3; c++)
      result.data[at + c] = Math.round((image.data[at + c]! * alpha) / 255)
  }
  return result
}
function over(
  target: Pixels,
  source: Pixels,
  left: number,
  top: number,
  opacity: number,
  clip: Rect = { x: 0, y: 0, width: target.width, height: target.height },
): void {
  const area = intersect(clip, { x: left, y: top, width: source.width, height: source.height })
  for (let y = area.y; y < area.y + area.height; y++)
    for (let x = area.x; x < area.x + area.width; x++) {
      const at = (y * target.width + x) * 4,
        from = ((y - top) * source.width + x - left) * 4,
        alpha = (source.data[from + 3]! * opacity) / 255
      for (let c = 0; c < 4; c++)
        target.data[at + c] = Math.min(
          255,
          Math.round(source.data[from + c]! * opacity + target.data[at + c]! * (1 - alpha)),
        )
    }
}
/** CPU scene images serve snapshots and groups which need isolated composition.
 * Unmodified ordinary layers remain individual WebGL textures. */
export class SceneComposer {
  private cache = new Map<string, Cached>()
  private bytes = 0
  private revision = 1
  constructor(
    private readonly layers: LayerTree,
    private readonly transition: (id: number) => TransitionFrame | undefined = () => undefined,
  ) {}
  private needsRawComposition(id: number, includeTransitions: boolean, visited = new Set<number>()): boolean {
    if (visited.has(id)) return false
    visited.add(id)
    const layer = this.layers.get(id),
      frame = this.transition(id)
    return (
      (!layer.bitmap && layer.type === 1) ||
      !ordinary(layer.type) ||
      (!!frame && (includeTransitions || this.needsRawComposition(frame.source, false, visited))) ||
      layer.children.some((child) => {
        const item = this.layers.get(child)
        return item.visible && item.opacity > 0 && this.needsRawComposition(child, includeTransitions, visited)
      })
    )
  }
  /** Raw TVP image planes for trees containing destination-dependent modes.
   * Children blend into the parent's format before that group is blended into
   * its parent. The same cached image is used by snapshots and display. */
  private blendTree(
    id: number,
    skipTransition = false,
    ancestors = new Set<number>(),
    suppressed = new Set<number>(),
  ): Composed {
    if (ancestors.has(id)) throw new Error('Cyclic scene composition')
    const layer = this.layers.get(id),
      frame = !skipTransition && !suppressed.has(id) ? this.transition(id) : undefined
    if (frame?.children) {
      const before = this.blendTree(id, true, ancestors, suppressed)
      const sourceBitmap = this.layers.get(frame.source).bitmap
      // The handler asks Src2 to Complete. A full-size leaf supplies its
      // stored main image even while a separate transition is displaying it.
      const after = sourceBitmap && !this.snapshotNeedsCompletion(frame.source)
        ? { pixels: sourceBitmap.pixels, revision: -sourceBitmap.revision }
        : this.blendTree(frame.source, false, new Set(), new Set([...suppressed, id]))
      return this.cached(
        `blend-transition:${id}`,
        `${frame.token}:${frame.pixelPhase ?? frame.phase}:${before.revision}:${after.revision}:${layer.type}`,
        () => transitionPixels(before.pixels, after.pixels, frame),
      )
    }
    const trail = new Set(ancestors).add(id)
    const bitmap = displayBitmap(layer)
    let main: Composed | undefined = bitmap
      ? { pixels: bitmap.pixels, revision: -bitmap.revision }
      : undefined
    if (frame && main) main = this.mainImage(id)
    // Binder opacity gates visibility but does not scale children. Preserve
    // their access to the backdrop and only inherit the binder's clip/offset.
    const children: Array<{
      layer: LayerState
      image: Composed
      left: number
      top: number
      clip: Rect
    }> = []
    const gather = (parent: LayerState, left: number, top: number, clip: Rect) => {
      for (const childId of parent.children) {
        const child = this.layers.get(childId)
        if (!child.visible || !child.opacity) continue
        const x = left + child.left,
          y = top + child.top,
          area = intersect(clip, { x, y, width: child.width, height: child.height })
        if (!area.width || !area.height) continue
        if (
          binder(child) ||
          (!child.bitmap && child.type !== 1 && child.opacity === 255 && !this.transition(childId))
        )
          gather(child, x, y, area)
        else
          children.push({
            layer: child,
            image: this.blendTree(childId, false, trail, suppressed),
            left: x,
            top: y,
            clip: area,
          })
      }
    }
    gather(layer, 0, 0, { x: 0, y: 0, width: layer.width, height: layer.height })
    const type = compositionType(layer),
      fill = !layer.bitmap && layer.type === 1 ? layer.neutralColor : neutralColor(type)
    return this.cached(
      `blend-tree:${id}:${skipTransition}`,
      JSON.stringify([
        type,
        fill,
        layer.width,
        layer.height,
        layer.imageLeft,
        layer.imageTop,
        main?.revision,
        children.map((child) => [
          child.layer.id,
          child.layer.type,
          child.layer.opacity,
          child.left,
          child.top,
          child.clip,
          child.image.revision,
        ]),
      ]),
      () => {
        const pixels = blank(layer.width, layer.height)
        for (let at = 0; at < pixels.data.length; at += 4) {
          pixels.data[at] = (fill >>> 16) & 255
          pixels.data[at + 1] = (fill >>> 8) & 255
          pixels.data[at + 2] = fill & 255
          pixels.data[at + 3] = (fill >>> 24) & 255
        }
        if (main) {
          const area = intersect(
            { x: 0, y: 0, width: layer.width, height: layer.height },
            {
              x: layer.imageLeft,
              y: layer.imageTop,
              width: main.pixels.width,
              height: main.pixels.height,
            },
          )
          for (let y = area.y; y < area.y + area.height; y++) {
            const from = ((y - layer.imageTop) * main.pixels.width + area.x - layer.imageLeft) * 4
            pixels.data.set(
              main.pixels.data.subarray(from, from + area.width * 4),
              (y * pixels.width + area.x) * 4,
            )
          }
        }
        for (const child of children) {
          const mode = compositionType(child.layer),
            face = autoFace(type),
            hold = usesAlpha(type) && mode !== 1 && mode !== 2 && mode !== 12
          for (let y = child.clip.y; y < child.clip.y + child.clip.height; y++) {
            if (mode === 2 && face === 1) {
              blendAlphaRow(pixels.data, (y * pixels.width + child.clip.x) * 4, child.image.pixels.data,
                ((y - child.top) * child.image.pixels.width + child.clip.x - child.left) * 4,
                child.clip.x, child.clip.width, child.layer.opacity)
              continue
            }
            for (let x = child.clip.x; x < child.clip.x + child.clip.width; x++)
              blendPixel(
                pixels.data,
                (y * pixels.width + x) * 4,
                child.image.pixels.data,
                ((y - child.top) * child.image.pixels.width + x - child.left) * 4,
                mode,
                face,
                child.layer.opacity,
                hold,
              )
          }
        }
        return pixels
      },
    )
  }
  private cached(key: string, signature: string, create: () => Pixels): Composed {
    const old = this.cache.get(key)
    if (old?.signature === signature) {
      this.cache.delete(key)
      this.cache.set(key, old)
      return old
    }
    if (old) {
      this.bytes -= old.pixels.data.length
      this.cache.delete(key)
    }
    const pixels = create(),
      size = pixels.data.length
    if (size > MAX_CACHE_BYTES) throw new Error('Composited image exceeds 64 MiB budget')
    while (this.bytes + size > MAX_CACHE_BYTES && this.cache.size) {
      const first = this.cache.entries().next().value!
      this.bytes -= first[1].pixels.data.length
      this.cache.delete(first[0])
    }
    const value = { pixels, signature, revision: this.revision++ }
    this.cache.set(key, value)
    this.bytes += size
    return value
  }
  private mainImage(id: number): Composed {
    const layer = this.layers.get(id), bitmap = layer.bitmap
    if (!bitmap) throw new Error('Source layer has no image')
    const frame = this.transition(id)
    // Raw bitmap revisions and completed-image revisions have separate counters.
    if (!frame || frame.children) return { pixels: bitmap.pixels, revision: -bitmap.revision }
    // A main-image transition takes Src2 directly from TransSrc->MainImage,
    // even if the source is displaying a transition of its own.
    const after = this.layers.bitmap(frame.source)
    return this.cached(
      `raw-transition:${id}`,
      `${frame.token}:${frame.pixelPhase ?? frame.phase}:${bitmap.revision}:${after.revision}`,
      () => transitionPixels(bitmap.pixels, after.pixels, frame),
    )
  }
  private displayMain(id: number): Composed {
    const layer = this.layers.get(id), main = this.mainImage(id)
    return this.cached(`display-main:${id}`, `${main.revision}:${layer.type}`,
      () => forDisplay(main.pixels, layer.type))
  }
  private compose(id: number, software = false, ancestors = new Set<number>()): Composed {
    const layer = this.layers.get(id)
    if ((software && !binder(layer)) || this.needsRawComposition(id, true)) {
      const source = this.blendTree(id, false, ancestors)
      return this.cached(`blend-display:${id}`, `${source.revision}:${layer.type}`, () =>
        forDisplay(source.pixels, compositionType(layer)),
      )
    }
    if (ancestors.has(id)) throw new Error('Cyclic scene composition')
    const trail = new Set(ancestors).add(id)
    const main = displayBitmap(layer) ? this.displayMain(id) : undefined
    const children: Array<{
      layer: LayerState
      image: Composed
      left: number
      top: number
      clip: Rect
    }> = []
    const gather = (parent: LayerState, left: number, top: number, clip: Rect) => {
      for (const childId of parent.children) {
        const child = this.layers.get(childId)
        if (!child.visible || !child.opacity) continue
        const x = left + child.left,
          y = top + child.top,
          area = intersect(clip, { x, y, width: child.width, height: child.height })
        if (!area.width || !area.height) continue
        if (binder(child)) gather(child, x, y, area)
        else
          children.push({
            layer: child,
            image: this.compose(childId, false, trail),
            left: x,
            top: y,
            clip: area,
          })
      }
    }
    gather(layer, 0, 0, { x: 0, y: 0, width: layer.width, height: layer.height })
    const signature = JSON.stringify([
      layer.width,
      layer.height,
      layer.imageLeft,
      layer.imageTop,
      main?.revision,
      children.map(({ layer, image, left, top, clip }) => [
        layer.id,
        left,
        top,
        clip,
        layer.opacity,
        image.revision,
      ]),
    ])
    return this.cached(`tree:${id}`, signature, () => {
      const pixels = blank(layer.width, layer.height)
      if (main) over(pixels, main.pixels, layer.imageLeft, layer.imageTop, 1)
      for (const child of children)
        over(
          pixels,
          child.image.pixels,
          child.left,
          child.top,
          child.layer.opacity / 255,
          child.clip,
        )
      return pixels
    })
  }
  /** Complete populates the requested rectangle of a layer-sized bitmap.
   * The rectangle's left edge and width affect the native scanline kernels. */
  private copyTree(id: number, area?: Rect): Composed {
    const transitioned = new Map<number, CompletedTransition>()
    const signature = (id: number, ancestors = new Set<number>()): unknown[] => {
      if (ancestors.has(id)) throw new Error('Cyclic scene composition')
      const layer = this.layers.get(id),
        trail = new Set(ancestors).add(id),
        transition = !binder(layer) ? this.transition(id) : undefined,
        frame = transition?.children ? this.blendTree(id) : transition && layer.bitmap ? this.mainImage(id) : undefined
      if (frame && transition) transitioned.set(id, { pixels: frame.pixels, children: transition.children })
      return [
        id,
        layer.bitmap?.revision,
        layer.type,
        layer.neutralColor,
        layer.cached,
        layer.width,
        layer.height,
        layer.imageLeft,
        layer.imageTop,
        layer.left,
        layer.top,
        layer.opacity,
        frame?.revision,
        layer.children
          .filter((id) => {
            const child = this.layers.get(id)
            return child.visible && child.opacity > 0
          })
          .map((id) => signature(id, trail)),
      ]
    }
    return this.cached(`copy-tree:${id}`, JSON.stringify([area, signature(id)]), () =>
      completeLayer(this.layers, id, transitioned, area),
    )
  }
  /** Native Complete returns MainImage before BeforeCompletion in this case,
   * even during a transition. Only immediate children's Visible/Opacity count;
   * their dimensions and intersection with the requested rectangle do not. */
  snapshotNeedsCompletion(id: number): boolean {
    const layer = this.layers.get(id),
      bitmap = this.layers.bitmap(id)
    return !(
      !layer.children.some((id) => {
        const child = this.layers.get(id)
        return child.visible && child.opacity > 0
      }) &&
      layer.imageLeft === 0 &&
      layer.imageTop === 0 &&
      layer.width === bitmap.width &&
      layer.height === bitmap.height
    )
  }
  /** Snapshot ignores the source's own visibility and opacity. An ordinary
   * root blends descendants; a binder root receives raw completion copies.
   * A caller which entered BeforeCompletion keeps that branch if onPaint
   * changes the tree while it is suspended. */
  snapshot(id: number, completing = false, area?: Rect): Pixels {
    const bitmap = this.layers.bitmap(id)
    if (!completing && !this.snapshotNeedsCompletion(id))
      return { ...bitmap.pixels, data: bitmap.pixels.data.slice() }
    // Native Complete copies MainImage into its cache, blends children in the
    // layer's format, and PiledCopy copies those raw channels. Display pixels
    // are premultiplied: converting through them loses low/zero-alpha RGB even
    // when a seen child lies outside the copied rectangle and adds no pixels.
    const source = this.copyTree(id, area).pixels
    return { ...source, data: source.data.slice() }
  }
  frame(
    width: number,
    height: number,
    offsetX = 0,
    offsetY = 0,
    zoom = 1,
    windowId?: number,
    zoomY = zoom,
    primaryId?: number,
    software = false,
  ): FrameLayer[] {
    const result: FrameLayer[] = []
    const visit = (layer: LayerState, x: number, y: number, clip: Rect) => {
      if (!layer.visible || !layer.opacity) return
      const rect = {
          x: x + layer.left * zoom,
          y: y + layer.top * zoomY,
          width: layer.width * zoom,
          height: layer.height * zoomY,
        },
        area = intersect(clip, rect)
      if (!area.width || !area.height) return
      if (binder(layer) && !software) {
        for (const child of layer.children) visit(this.layers.get(child), rect.x, rect.y, area)
        return
      }
      const transition = this.transition(layer.id),
        group =
          software || this.needsRawComposition(layer.id, false) ||
          (transition && (transition.children || transition.kind !== 'scroll')) ||
          (layer.opacity < 255 && layer.children.some((id) => this.layers.get(id).visible))
      if (group) {
        const image = this.compose(layer.id, software)
        result.push({
          ...rect,
          id: -layer.id,
          opacity: layer.opacity / 255,
          pixels: image.pixels,
          revision: image.revision,
          clip: area,
          source: { x: 0, y: 0, width: layer.width, height: layer.height },
          type: 12,
        })
        return
      }
      const bitmap = displayBitmap(layer)
      if (bitmap) {
        const image = transition
          ? this.displayMain(layer.id)
          : { pixels: bitmap.pixels, revision: bitmap.revision }
        result.push({
          ...rect,
          id: transition ? -layer.id : layer.id,
          opacity: layer.opacity / 255,
          ...image,
          clip: area,
          source: {
            x: -layer.imageLeft,
            y: -layer.imageTop,
            width: layer.width,
            height: layer.height,
          },
          type: transition ? 12 : layer.type,
        })
      }
      for (const child of layer.children) visit(this.layers.get(child), rect.x, rect.y, area)
    }
    for (const id of this.layers.ids()) {
      const layer = this.layers.get(id)
      if (layer.primary && (windowId === undefined || layer.windowId === windowId) &&
        (primaryId === undefined || layer.id === primaryId))
        visit(layer, offsetX, offsetY, { x: 0, y: 0, width, height })
    }
    for (const [key, value] of this.cache)
      if (!this.layers.has(Number(key.split(':')[1]))) {
        this.cache.delete(key)
        this.bytes -= value.pixels.data.length
      }
    return result
  }
  clear(): void {
    this.cache.clear()
    this.bytes = 0
  }
}
