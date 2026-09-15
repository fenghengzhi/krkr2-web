import { intersect } from '../graphics/bitmap.ts'
import { autoFace, blendPixel, neutralColor, usesAlpha } from '../graphics/blend.ts'
import type { Pixels, Rect } from '../ports/graphics.ts'
import type { LayerState, LayerTree } from './layers.ts'

interface Completion {
  pixels: Pixels
  x: number
  y: number
  rect: Rect
  type: number
  opacity: number
}
interface Surface {
  pixels: Pixels
  bounds: Rect
}
interface Target {
  complete(completion: Completion): void
  borrow(rect: Rect): Surface
}
const displayType = (layer: LayerState) => (layer.type === 6 || layer.type === 7 ? 0 : layer.type)
const nonempty = (rect: Rect) => rect.width > 0 && rect.height > 0

/** Rectangle subtraction retains actual DrawCompleted coverage. A transparent
 * image is still an output; a missing image may produce no output at all. */
function subtract(rect: Rect, other: Rect): Rect[] {
  const area = intersect(rect, other)
  if (!nonempty(area)) return [rect]
  return [
    { x: rect.x, y: rect.y, width: rect.width, height: area.y - rect.y },
    {
      x: rect.x,
      y: area.y + area.height,
      width: rect.width,
      height: rect.y + rect.height - area.y - area.height,
    },
    { x: rect.x, y: area.y, width: area.x - rect.x, height: area.height },
    {
      x: area.x + area.width,
      y: area.y,
      width: rect.x + rect.width - area.x - area.width,
      height: area.height,
    },
  ].filter(nonempty)
}
const difference = (rects: Rect[], others: Rect[]): Rect[] =>
  others.reduce((remaining, other) => remaining.flatMap((rect) => subtract(rect, other)), rects)

function image(rect: Rect, color: number): Pixels {
  const bytes = rect.width * rect.height * 4
  if (bytes > 64 * 1024 * 1024) throw new Error('Composited image exceeds 64 MiB budget')
  const result = { width: rect.width, height: rect.height, data: new Uint8Array(bytes) }
  for (let at = 0; at < bytes; at += 4) {
    result.data[at] = (color >>> 16) & 255
    result.data[at + 1] = (color >>> 8) & 255
    result.data[at + 2] = color & 255
    result.data[at + 3] = (color >>> 24) & 255
  }
  return result
}
function copy(target: Pixels, bounds: Rect, source: Completion): void {
  const area = intersect(bounds, source.rect)
  if (!nonempty(area) || target === source.pixels) return
  for (let y = area.y; y < area.y + area.height; y++) {
    const from = ((y - source.y) * source.pixels.width + area.x - source.x) * 4
    target.data.set(
      source.pixels.data.subarray(from, from + area.width * 4),
      ((y - bounds.y) * target.width + area.x - bounds.x) * 4,
    )
  }
}
function fill(surface: Surface, rect: Rect, color: number, drawn?: Uint8Array): void {
  for (let y = rect.y; y < rect.y + rect.height; y++)
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const index = (y - surface.bounds.y) * surface.pixels.width + x - surface.bounds.x
      if (drawn?.[index]) continue
      const at = index * 4
      surface.pixels.data[at] = (color >>> 16) & 255
      surface.pixels.data[at + 1] = (color >>> 8) & 255
      surface.pixels.data[at + 2] = color & 255
      surface.pixels.data[at + 3] = (color >>> 24) & 255
    }
}

/** The Complete drawable copies completed rectangles without blending. Binder
 * receivers forward messages to that drawable; ordinary receivers blend into
 * their own image first. This is intentionally separate from screen rendering.
 * Explicit cache enablement affects message order; incremental native cache
 * regions and transition pipelines remain the composer's existing boundaries. */
export function completeBinder(
  layers: LayerTree,
  id: number,
  transitioned: ReadonlyMap<number, Pixels> = new Map(),
): Pixels {
  const root = layers.get(id),
    bounds = { x: 0, y: 0, width: root.width, height: root.height },
    result = image(bounds, neutralColor(root.type))

  const draw = (
    layer: LayerState,
    x: number,
    y: number,
    requested: Rect,
    target: Target,
    forcedCache?: Pixels,
  ): void => {
    const viewport = { x, y, width: layer.width, height: layer.height },
      rect = intersect(viewport, requested)
    if (!nonempty(rect)) return
    const type = displayType(layer),
      opacity = layer.opacity,
      main = layer.bitmap,
      children = layer.children
        .map((id) => layers.get(id))
        .filter((child) => child.visible && child.opacity > 0),
      childRects = children.map((child) =>
        intersect(viewport, {
          x: x + child.left,
          y: y + child.top,
          width: child.width,
          height: child.height,
        }),
      ),
      color = type === 1 ? layer.neutralColor : neutralColor(layer.type),
      transition = transitioned.get(layer.id)

    if (transition && !forcedCache) {
      target.complete({ pixels: transition, x, y, rect, type, opacity })
      return
    }
    const own = (area: Rect, sink: (completion: Completion) => void) => {
      if (main)
        sink({
          pixels: main.pixels,
          x: x + layer.imageLeft,
          y: y + layer.imageTop,
          rect: area,
          type,
          opacity,
        })
      else if (type === 1)
        sink({ pixels: image(area, color), x: area.x, y: area.y, rect: area, type, opacity })
    }
    const drawChildren = (area: Rect, destination: Target) => {
      for (const child of children) draw(child, x + child.left, y + child.top, area, destination)
    }
    const compose = (area: Rect, cached: boolean, destination?: Pixels) => {
      // An uncached Binder never sends its temporary overlapped image. Its
      // children forward directly; the Binder's own image is exposed-only.
      if (type === 0 && !cached) {
        drawChildren(area, target)
        return
      }
      // Native totalopaque uses GetDrawTargetBitmap instead of a temporary.
      // Preserve that identity: the parent's completion then skips both its
      // blend and DrawnRegion update, including the cached no-main fill below.
      const surface = destination
          ? { pixels: destination, bounds: area }
          : !cached && type === 1 && opacity === 255
            ? target.borrow(area)
            : { pixels: image(area, color), bounds: area },
        { pixels, bounds } = surface,
        drawn = !main && type !== 0 ? new Uint8Array(pixels.width * pixels.height) : undefined
      if (main) own(area, (source) => copy(pixels, bounds, source))
      else fill(surface, area, color)
      const receive: Target =
        type === 0
          ? target
          : {
              borrow: () => surface,
              complete: (source) => {
                if (source.pixels === pixels) return
                const covered = intersect(area, source.rect),
                  face = autoFace(type),
                  hold = usesAlpha(type) && ![1, 2, 12].includes(source.type)
                for (let py = covered.y; py < covered.y + covered.height; py++)
                  for (let px = covered.x; px < covered.x + covered.width; px++) {
                    const index = (py - bounds.y) * pixels.width + px - bounds.x,
                      at = index * 4,
                      from = ((py - source.y) * source.pixels.width + px - source.x) * 4
                    if (drawn && !drawn[index] && source.type === type && source.opacity === 255)
                      pixels.data.set(source.pixels.data.subarray(from, from + 4), at)
                    else {
                      // A borrowed opaque write did not enter DrawnRegion.
                      // Native initializes that still-new area again before
                      // its first blending message, even if Binder then skips
                      // the pixel operation itself.
                      if (drawn && !drawn[index]) {
                        pixels.data[at] = (color >>> 16) & 255
                        pixels.data[at + 1] = (color >>> 8) & 255
                        pixels.data[at + 2] = color & 255
                        pixels.data[at + 3] = (color >>> 24) & 255
                      }
                      if (source.type !== 0)
                        blendPixel(
                          pixels.data,
                          at,
                          source.pixels.data,
                          from,
                          source.type,
                          face,
                          source.opacity,
                          hold,
                        )
                    }
                    if (drawn) drawn[index] = 1
                  }
              },
            }
      drawChildren(area, receive)
      if (cached && !main) fill(surface, area, color, drawn)
      target.complete({ pixels, x: bounds.x, y: bounds.y, rect: area, type, opacity })
    }
    if (forcedCache || layer.cached) {
      // Cached Binder children send their messages first, then their own
      // cache is sent. At the root the cache and raw target are the same image.
      compose(rect, true, forcedCache)
      return
    }
    if (!children.length) {
      own(rect, target.complete)
      return
    }

    let exposed: Rect[], overlapped: Rect[]
    if (main) {
      overlapped = []
      const intersecting = childRects.filter(nonempty)
      if (children.length > 30 && intersecting.length) {
        // Native TVP_EXPOSED_UNITE_LIMIT counts even offscreen seen children.
        // Only the part within viewport is observable by this draw request.
        const left = Math.min(...intersecting.map((rect) => rect.x)),
          top = Math.min(...intersecting.map((rect) => rect.y)),
          right = Math.max(...intersecting.map((rect) => rect.x + rect.width)),
          bottom = Math.max(...intersecting.map((rect) => rect.y + rect.height))
        overlapped = [{ x: left, y: top, width: right - left, height: bottom - top }]
      } else
        for (const childRect of intersecting)
          overlapped.push(...difference([childRect], overlapped))
      exposed = difference([viewport], overlapped)
    } else {
      // A sole matching, fully opaque child can transfer directly through an
      // image-less ordinary parent. Other regions use the parent's own format.
      exposed =
        children.length < 10
          ? children.flatMap((child, index) =>
              displayType(child) === type && child.opacity === 255 && nonempty(childRects[index]!)
                ? difference(
                    [childRects[index]!],
                    childRects.filter((_, other) => other !== index),
                  )
                : [],
            )
          : []
      overlapped = difference([viewport], exposed)
    }
    for (const region of overlapped) {
      const area = intersect(region, rect)
      if (nonempty(area)) compose(area, false)
    }
    for (const region of exposed) {
      const area = intersect(region, rect)
      if (!nonempty(area)) continue
      if (main) own(area, target.complete)
      else drawChildren(area, target)
    }
  }
  draw(
    root,
    0,
    0,
    bounds,
    {
      complete: (source) => copy(result, bounds, source),
      borrow: () => ({ pixels: result, bounds }),
    },
    result,
  )
  return result
}
