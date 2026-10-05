import type { Locator } from '@playwright/test'

/** Enlarge the displayed Window as a whole. Enlarging just its canvas crops
 * the source pixels against the native viewport/content clipping rectangles.
 * This changes CSS presentation only; the renderer, backing pixels, clipping
 * hierarchy and logical hit coordinates remain the game's own. */
export async function magnifyPixelWindow(canvas: Locator): Promise<void> {
  await canvas.evaluate((node) => {
    const surface = node.closest<HTMLElement>('.game-window[data-window-id]')
    if (!surface) throw new Error('Pixel fixture has no owned game Window')
    const document = node.ownerDocument
    if (!document.getElementById('pixel-window-fixture-style')) {
      const style = document.createElement('style')
      style.id = 'pixel-window-fixture-style'
      style.textContent = '.game-window.pixel-window-fixture { transform: scale(8) !important; transform-origin: 0 0 !important; }'
      document.head.append(style)
    }
    surface.classList.add('pixel-window-fixture')
    ;(node as HTMLCanvasElement).style.imageRendering = 'pixelated'
  })
  await canvas.scrollIntoViewIfNeeded()
}
