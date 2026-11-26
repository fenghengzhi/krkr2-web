import type { Rect } from '../ports/graphics.ts'

export type FullscreenZoom = 'inner' | 'outer' | 'none'
type Size = { width: number; height: number }

/** KRKR reads -fsres and -fszoom each time it enters fullscreen. Unknown
 * values keep the previous selection. The browser supplies one display mode,
 * its layout viewport, while the game controls how its image fits it. */
export class FullscreenOptions {
  private automatic = true
  private zoom: FullscreenZoom = 'inner'
  select(args: ReadonlyMap<string, string>): FullscreenZoom {
    switch (args.get('-fsres')) {
      case 'auto': this.automatic = true; break
      case 'prop': case 'proportional': case 'nearest': case 'nochange': this.automatic = false; break
    }
    switch (args.get('-fszoom')) {
      case 'yes': case 'inner': this.zoom = 'inner'; break
      case 'no': this.zoom = 'none'; break
      case 'outer': this.zoom = 'outer'; break
    }
    return this.automatic && this.zoom === 'none' ? 'inner' : this.zoom
  }
}

/** Center the native-sized ScrollBox, then clip it to the browser viewport.
 * The crop precedes the Layer offset/scroll and is shared by paint and input. */
export function fullscreenLayout(inner: Rect, game: Size, mode: FullscreenZoom = 'inner') {
  if (![inner.width, inner.height, game.width, game.height].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new Error('Fullscreen layout requires nonempty display and game dimensions')
  const widthLimits = inner.width * game.height <= inner.height * game.width
  const byWidth = mode === 'inner' ? widthLimits : !widthLimits
  let zoom = mode === 'none' ? { numer: 1, denom: 1 } : byWidth
    ? { numer: inner.width, denom: game.width } : { numer: inner.height, denom: game.height }
  if (zoom.numer > zoom.denom && zoom.numer * 1000 < zoom.denom * 1034) zoom = { numer: 1, denom: 1 }
  const width = Math.trunc(game.width * zoom.numer / zoom.denom), height = Math.trunc(game.height * zoom.numer / zoom.denom)
  const x = Math.trunc((inner.width - width) / 2), y = Math.trunc((inner.height - height) / 2)
  const area = { x: inner.x + Math.max(0, x), y: inner.y + Math.max(0, y),
    width: Math.min(inner.width, width), height: Math.min(inner.height, height) }
  // Odd excess pixels are assigned to the right/bottom by native integer division.
  const crop = width > area.width || height > area.height ? { x: Math.max(0, -x), y: Math.max(0, -y) } : undefined
  return { area, zoom, width, height, crop }
}
