import { copySystemColorPalette, systemColorCssNames } from '../engine/graphics/system-colors.ts'

/** Capture the actual page's CSS system colors once, before starting its Worker. */
export function sampleSystemColorPalette(canvas: HTMLCanvasElement): readonly number[] {
  return sampleCssColorPalette(canvas, systemColorCssNames, 'Canvas')
}

/** CSS adapter shared by the fixed system roles and explicit CSS fixture colors. */
export function sampleCssColorPalette(
  canvas: HTMLCanvasElement,
  cssColors: readonly (string | null)[],
  canvasColor: string,
): readonly number[] {
  const document = canvas.ownerDocument,
    view = document.defaultView,
    parent = document.body ?? document.documentElement
  if (!view || !parent) throw new Error('Browser system colors require a page window')
  const probe = document.createElement('span'),
    sample = document.createElement('canvas')
  sample.width = sample.height = 1
  const context = sample.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Browser system colors require a 2D canvas')
  context.globalCompositeOperation = 'source-over'
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;overflow:hidden;'
  // Host styles must not turn successive keyword reads into transitional colors.
  probe.style.setProperty('transition', 'none', 'important')
  probe.style.setProperty('animation', 'none', 'important')
  probe.style.setProperty('color-scheme', view.getComputedStyle(canvas).colorScheme, 'important')
  parent.append(probe)
  try {
    const resolve = (name: string) => {
      probe.style.removeProperty('color')
      probe.style.setProperty('color', name, 'important')
      if (!probe.style.color) throw new Error(`Browser system color is unavailable: ${name}`)
      const resolved = view.getComputedStyle(probe).color
      if (
        !resolved ||
        systemColorCssNames.some((keyword) => keyword?.toLowerCase() === resolved.toLowerCase())
      )
        throw new Error(`Browser system color did not resolve: ${name}`)
      return resolved
    }
    const flatten = (resolved: string, backdrop: number) => {
      // CSS colors can have alpha (including native Highlight). Resolve them
      // through the browser's source-over rasterization, not by dropping alpha.
      context.fillStyle = `#${backdrop.toString(16).padStart(6, '0')}`
      context.fillRect(0, 0, 1, 1)
      context.fillStyle = resolved
      context.fillRect(0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      return (pixel[0]! << 16) | (pixel[1]! << 8) | pixel[2]!
    }
    // White is an explicit Web fallback only when CSS Canvas is transparent.
    // It does not stand in for Windows colors or the embedding page background.
    const backdrop = flatten(resolve(canvasColor), 0xffffff),
      colors = new Map<string, number>([[canvasColor, backdrop]])
    const palette = cssColors.map((name) => {
      if (name === null) return 0
      const previous = colors.get(name)
      if (previous !== undefined) return previous
      const color = flatten(resolve(name), backdrop)
      colors.set(name, color)
      return color
    })
    return copySystemColorPalette(palette)
  } finally {
    probe.remove()
    // This synchronous sampler never uses its bitmap again, including when a
    // browser readback fails. Release it without waiting for canvas collection.
    sample.width = sample.height = 0
  }
}
