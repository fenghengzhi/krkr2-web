import { copySystemColorPalette, systemColorCssNames } from '../engine/graphics/system-colors.ts'

/** Capture the actual page's CSS system colors once, before starting its Worker. */
export function sampleSystemColorPalette(canvas: HTMLCanvasElement): readonly number[] {
  const document = canvas.ownerDocument,
    view = document.defaultView,
    parent = document.body ?? document.documentElement
  if (!view || !parent) throw new Error('Browser system colors require a page window')
  const probe = document.createElement('span'),
    sample = document.createElement('canvas')
  sample.width = sample.height = 1
  const context = sample.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Browser system colors require a 2D canvas')
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;overflow:hidden;'
  // Host styles must not turn successive keyword reads into transitional colors.
  probe.style.setProperty('transition', 'none', 'important')
  probe.style.setProperty('animation', 'none', 'important')
  probe.style.setProperty('color-scheme', view.getComputedStyle(canvas).colorScheme, 'important')
  parent.append(probe)
  try {
    const colors = new Map<string, number>()
    const palette = systemColorCssNames.map((name) => {
      if (name === null) return 0
      const previous = colors.get(name)
      if (previous !== undefined) return previous
      probe.style.removeProperty('color')
      probe.style.setProperty('color', name, 'important')
      if (probe.style.color.toLowerCase() !== name.toLowerCase())
        throw new Error(`Browser system color is unavailable: ${name}`)
      const resolved = view.getComputedStyle(probe).color
      if (!resolved || resolved.toLowerCase() === name.toLowerCase())
        throw new Error(`Browser system color did not resolve: ${name}`)
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = resolved
      context.fillRect(0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      if (pixel[3] !== 255) throw new Error(`Browser system color is not opaque: ${name}`)
      const color = (pixel[0]! << 16) | (pixel[1]! << 8) | pixel[2]!
      colors.set(name, color)
      return color
    })
    return copySystemColorPalette(palette)
  } finally {
    probe.remove()
  }
}
