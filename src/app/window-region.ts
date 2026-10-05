import { validateWindowRegion, type WindowRegion } from '../engine/scene/window-region.ts'

const svgNamespace = 'http://www.w3.org/2000/svg'
let nextClipId = 0

/** A Window region clips its complete outer box, including chrome. SVG clip
 * geometry also excludes physical pointer hits, unlike an alpha CSS mask.
 * The bitmap snapshot never follows later Layer drawing, offsets or zoom. */
export class WindowRegionClip {
  private revision = 0
  private definition?: SVGSVGElement
  private path?: SVGPathElement
  private disposed = false

  constructor(
    private readonly stage: HTMLElement,
    private readonly element: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly geometry: () => { width: number; height: number },
  ) {}

  set(revision: number, region: WindowRegion | null): void {
    if (this.disposed) return
    if (!Number.isSafeInteger(revision) || revision <= 0)
      throw new Error('Invalid Window region revision')
    if (revision <= this.revision) return
    if (region) validateWindowRegion(region)
    const document = this.element.ownerDocument
    let definition: SVGSVGElement | undefined, path: SVGPathElement | undefined
    const oldReference = this.element.style.clipPath
    try {
      if (region) {
        // One path keeps the DOM bounded even for a maximally fragmented mask.
        const rectangles = region.rectangles, parts: string[] = []
        for (let at = 0; at < rectangles.length; at += 4) {
          const x = rectangles[at]!, y = rectangles[at + 1]!,
            right = x + rectangles[at + 2]!, bottom = y + rectangles[at + 3]!
          parts.push(`M${x} ${y}H${right}V${bottom}H${x}Z`)
        }
        definition = document.createElementNS(svgNamespace, 'svg')
        definition.classList.add('game-window-region-defs')
        definition.setAttribute('width', '0')
        definition.setAttribute('height', '0')
        definition.setAttribute('aria-hidden', 'true')
        definition.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden'
        const clip = document.createElementNS(svgNamespace, 'clipPath')
        let id: string
        do { id = `game-window-region-${++nextClipId}` } while (document.getElementById(id))
        clip.id = id
        clip.setAttribute('clipPathUnits', 'userSpaceOnUse')
        path = document.createElementNS(svgNamespace, 'path')
        path.setAttribute('d', parts.join(''))
        path.setAttribute('clip-rule', 'nonzero')
        path.setAttribute('transform', this.transform())
        clip.append(path)
        definition.append(clip)
        // Keep the definition outside the clipped element, including an empty
        // region. Never hide it with display:none (SVG resource resolution).
        this.stage.append(definition)
        this.element.style.clipPath = `url("#${id}")`
      } else this.element.style.clipPath = ''
    } catch (error) {
      definition?.remove()
      this.element.style.clipPath = oldReference
      throw error
    }
    this.definition?.remove()
    this.definition = definition
    this.path = path
    this.revision = revision
    this.element.dataset.regionRevision = String(revision)
  }

  project(): void {
    if (!this.path || this.disposed) return
    const transform = this.transform()
    if (this.path.getAttribute('transform') !== transform)
      this.path.setAttribute('transform', transform)
  }

  private transform(): string {
    // Measured windows scale the complete logical outer with CSS transform.
    // The clip resource uses pre-transform local units and scales with it once.
    if (this.element.classList.contains('game-window-measured')) return 'scale(1 1)'
    const { width, height } = this.geometry(),
      style = this.element.ownerDocument.defaultView!.getComputedStyle(this.canvas),
      cssWidth = Number.parseFloat(style.width), cssHeight = Number.parseFloat(style.height),
      scaleX = width > 0 && cssWidth > 0 && Number.isFinite(cssWidth) ? cssWidth / width : 1,
      scaleY = height > 0 && cssHeight > 0 && Number.isFinite(cssHeight) ? cssHeight / height : 1
    // Only responsive page scaling is projected; origin remains outer-window
    // (0,0), without translating by its header, menu, border or letterboxing.
    return `scale(${scaleX} ${scaleY})`
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.element.style.clipPath = ''
    delete this.element.dataset.regionRevision
    this.definition?.remove()
    this.definition = undefined
    this.path = undefined
  }
}
