import type { FrameLayer, Pixels, Rect } from '../ports/graphics.ts'
import { intersect } from '../graphics/bitmap.ts'
import { autoFace, blendPixel, neutralColor, usesAlpha } from '../graphics/blend.ts'
import { opaqueTransition, transitionPixels, type TransitionFrame } from '../graphics/transition.ts'
import type { LayerTree, LayerState } from './layers.ts'
import { completeBinder } from './completion.ts'
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
function convert(image: Pixels, type: number, toPremultiplied: boolean): Pixels {
  const result = { ...image, data: image.data.slice() }
  if (type === 12) return result
  for (let at = 0; at < result.data.length; at += 4) {
    const alpha = usesAlpha(type) ? image.data[at + 3]! : 255
    result.data[at + 3] = alpha
    for (let c = 0; c < 3; c++)
      result.data[at + c] = toPremultiplied
        ? Math.round((image.data[at + c]! * alpha) / 255)
        : alpha
          ? Math.min(255, Math.round((image.data[at + c]! * 255) / alpha))
          : 0
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
  private needsBlend(id: number, visited = new Set<number>()): boolean {
    if (visited.has(id)) return false
    visited.add(id)
    const layer = this.layers.get(id),
      frame = this.transition(id)
    return (
      (!layer.bitmap && layer.type === 1) ||
      !ordinary(layer.type) ||
      (!!frame && this.needsBlend(frame.source, visited)) ||
      layer.children.some((child) => {
        const item = this.layers.get(child)
        return item.visible && item.opacity > 0 && this.needsBlend(child, visited)
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
      const before = this.blendTree(id, true, ancestors, suppressed),
        after = this.blendTree(frame.source, false, new Set(), new Set([...suppressed, id]))
      return this.cached(
        `blend-transition:${id}`,
        `${frame.token}:${frame.phase}:${before.revision}:${after.revision}:${layer.type}`,
        () =>
          opaqueTransition(frame)
            ? transitionPixels(before.pixels, after.pixels, frame)
            : convert(
                transitionPixels(
                  convert(before.pixels, layer.type, true),
                  convert(after.pixels, this.layers.get(frame.source).type, true),
                  frame,
                ),
                layer.type,
                false,
              ),
      )
    }
    const trail = new Set(ancestors).add(id)
    const bitmap = displayBitmap(layer)
    let main: Composed | undefined = bitmap
      ? { pixels: bitmap.pixels, revision: bitmap.revision }
      : undefined
    if (frame && main) {
      if (opaqueTransition(frame)) main = this.raw(id, false, true)
      else {
        const before = this.raw(id, true),
          after = this.raw(frame.source)
        main = this.cached(
          `blend-main-transition:${id}`,
          `${frame.token}:${frame.phase}:${before.revision}:${after.revision}`,
          () => convert(transitionPixels(before.pixels, after.pixels, frame), layer.type, false),
        )
      }
    }
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
          for (let y = child.clip.y; y < child.clip.y + child.clip.height; y++)
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
  private raw(id: number, skipTransition = false, native = false): Composed {
    const layer = this.layers.get(id),
      bitmap = layer.bitmap
    if (!bitmap) throw new Error('Source layer has no image')
    const frame = !skipTransition ? this.transition(id) : undefined
    if (frame && !frame.children) {
      const opaque = opaqueTransition(frame),
        before = this.raw(id, true, opaque),
        after = this.raw(frame.source, false, opaque)
      return this.cached(
        `raw-transition:${id}:${native}`,
        `${frame.token}:${frame.phase}:${before.revision}:${after.revision}:${layer.type}`,
        () => {
          const pixels = transitionPixels(before.pixels, after.pixels, frame)
          return native === opaque ? pixels : convert(pixels, layer.type, !native)
        },
      )
    }
    if (native) return { pixels: bitmap.pixels, revision: bitmap.revision }
    return this.cached(`raw:${id}`, `${bitmap.revision}:${layer.type}`, () => {
      const result = blank(bitmap.width, bitmap.height)
      for (let at = 0; at < result.data.length; at += 4) {
        const alpha = !usesAlpha(layer.type) ? 255 : bitmap.pixels.data[at + 3]!
        result.data[at + 3] = alpha
        for (let c = 0; c < 3; c++)
          result.data[at + c] =
            layer.type === 12
              ? bitmap.pixels.data[at + c]!
              : Math.round((bitmap.pixels.data[at + c]! * alpha) / 255)
      }
      return result
    })
  }
  private compose(
    id: number,
    skipTransition = false,
    ancestors = new Set<number>(),
    suppressed = new Set<number>(),
  ): Composed {
    const transition = this.transition(id)
    if (this.needsBlend(id) || (transition && opaqueTransition(transition))) {
      const source = this.blendTree(id, skipTransition, ancestors, suppressed),
        layer = this.layers.get(id)
      return this.cached(`blend-display:${id}`, `${source.revision}:${layer.type}`, () =>
        convert(source.pixels, compositionType(layer), true),
      )
    }
    if (ancestors.has(id)) throw new Error('Cyclic scene composition')
    const trail = new Set(ancestors)
    trail.add(id)
    const layer = this.layers.get(id),
      frame = !skipTransition && !suppressed.has(id) ? this.transition(id) : undefined
    if (frame?.children) {
      const before = this.compose(id, true, ancestors, suppressed),
        after = this.compose(frame.source, false, new Set(), new Set([...suppressed, id]))
      return this.cached(
        `tree-transition:${id}`,
        `${frame.token}:${frame.phase}:${before.revision}:${after.revision}`,
        () => transitionPixels(before.pixels, after.pixels, frame),
      )
    }
    const main = displayBitmap(layer)
      ? this.raw(id, skipTransition || suppressed.has(id))
      : undefined
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
            image: this.compose(childId, false, trail, suppressed),
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
    return this.cached(`tree:${id}:${skipTransition}`, signature, () => {
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
  /** Complete on a binder ends at a raw CopyRect target, rather than the
   * parent's blend target. Its own pixels and child completion messages are
   * copied without applying their display type or nonzero opacity. */
  private copyTree(id: number): Composed {
    const transitioned = new Map<number, Pixels>()
    const signature = (id: number, ancestors = new Set<number>()): unknown[] => {
      if (ancestors.has(id)) throw new Error('Cyclic scene composition')
      const layer = this.layers.get(id),
        trail = new Set(ancestors).add(id),
        frame = !binder(layer) && this.transition(id) ? this.blendTree(id) : undefined
      if (frame) transitioned.set(id, frame.pixels)
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
    return this.cached(`copy-tree:${id}`, JSON.stringify(signature(id)), () =>
      completeBinder(this.layers, id, transitioned),
    )
  }
  /** Snapshot ignores the source's own visibility and opacity. An ordinary
   * root blends descendants; a binder root receives raw completion copies. */
  snapshot(id: number): Pixels {
    const layer = this.layers.get(id),
      bitmap = this.layers.bitmap(id)
    if (
      !this.transition(id) &&
      !layer.children.some((id) => {
        const child = this.layers.get(id)
        return child.visible && child.opacity > 0
      }) &&
      layer.imageLeft === 0 &&
      layer.imageTop === 0 &&
      layer.width === bitmap.width &&
      layer.height === bitmap.height
    )
      return { ...bitmap.pixels, data: bitmap.pixels.data.slice() }
    if (binder(layer)) {
      const source = this.copyTree(id).pixels
      return { ...source, data: source.data.slice() }
    }
    const transition = this.transition(id)
    if (this.needsBlend(id) || (transition && opaqueTransition(transition))) {
      const source = this.blendTree(id).pixels
      return { ...source, data: source.data.slice() }
    }
    const source = this.compose(id).pixels,
      result = { ...source, data: source.data.slice() }
    if (this.layers.get(id).type !== 12)
      for (let at = 0; at < result.data.length; at += 4) {
        const alpha = result.data[at + 3]!
        if (alpha)
          for (let c = 0; c < 3; c++)
            result.data[at + c] = Math.min(255, Math.round((result.data[at + c]! * 255) / alpha))
      }
    return result
  }
  frame(
    width: number,
    height: number,
    offsetX = 0,
    offsetY = 0,
    zoom = 1,
    windowId?: number,
  ): FrameLayer[] {
    const result: FrameLayer[] = []
    const visit = (layer: LayerState, x: number, y: number, clip: Rect) => {
      if (!layer.visible || !layer.opacity) return
      const rect = {
          x: x + layer.left * zoom,
          y: y + layer.top * zoom,
          width: layer.width * zoom,
          height: layer.height * zoom,
        },
        area = intersect(clip, rect)
      if (!area.width || !area.height) return
      if (binder(layer)) {
        for (const child of layer.children) visit(this.layers.get(child), rect.x, rect.y, area)
        return
      }
      const transition = this.transition(layer.id),
        group =
          this.needsBlend(layer.id) ||
          (transition && opaqueTransition(transition)) ||
          transition?.children ||
          (layer.opacity < 255 && layer.children.some((id) => this.layers.get(id).visible))
      if (group) {
        const image = this.compose(layer.id)
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
          ? this.raw(layer.id)
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
      if (layer.primary && (windowId === undefined || layer.windowId === windowId))
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
