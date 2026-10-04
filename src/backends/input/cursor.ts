import {
  compositeCursor,
  cursorLimits,
  cursorStep,
  type CursorAsset,
  type CursorFrame,
  type CursorImage,
} from '../../formats/cursor/index.ts'

/** Selection is deliberately separate from presentation. In particular, an
 * uncalibrated multi-image directory must not silently become its first PNG. */
export interface SelectedCursorAsset {
  readonly asset: CursorAsset
  readonly selected: readonly CursorImage[]
}
export function selectCursorAsset(
  source: CursorAsset,
  select: (frame: CursorFrame, index: number) => number,
): SelectedCursorAsset {
  if (source.kind === 'ani' && source.rates.some((rate) => rate === 0))
    throw new Error('Custom cursor zero-rate animation timing is not calibrated')
  if (!source.frames.length || source.frames.length > cursorLimits.frames ||
      !source.sequence.length || source.sequence.length > cursorLimits.steps ||
      source.sequence.length !== source.rates.length ||
      source.sequence.some((value) => !Number.isSafeInteger(value) || value < 0 || value >= source.frames.length) ||
      source.rates.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      source.rates.reduce((sum, value) => sum + value, 0) !== source.durationJiffies ||
      source.durationJiffies > cursorLimits.durationJiffies ||
      (source.kind !== 'cur' && source.kind !== 'ani'))
    throw new Error('Invalid selected cursor timeline')
  let pixels = 0
  const selected = source.frames.map((frame, index) => {
    const choice = select(frame, index), image = frame.images[choice]
    if (!Number.isSafeInteger(choice) || choice < 0 || !image ||
        !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
        image.width < 1 || image.height < 1 || image.width > 256 || image.height > 256 ||
        image.data.length !== image.width * image.height * 4 ||
        image.andMask.length !== image.width * image.height ||
        (image.mode !== 'alpha' && image.mode !== 'and-xor') ||
        !Number.isSafeInteger(image.hotspot.x) || !Number.isSafeInteger(image.hotspot.y) ||
        image.hotspot.x < 0 || image.hotspot.y < 0 ||
        // CUR stores uint16, but loading scales the hotspot into ICONINFO's
        // DWORD coordinates. Presentation receives that loaded handle.
        image.hotspot.x > 0xffffffff || image.hotspot.y > 0xffffffff)
      throw new Error('Invalid selected cursor image')
    pixels += image.width * image.height
    if (pixels > cursorLimits.pixels) throw new Error('Selected cursor image budget exceeded')
    return { ...image, hotspot: { ...image.hotspot },
      data: new Uint8Array(image.data), andMask: new Uint8Array(image.andMask) }
  })
  return { selected, asset: { ...source,
    frames: selected.map((image) => ({ images: [image] })),
    imageCount: selected.length,
    decodedBytes: selected.reduce((sum, image) => sum + image.data.byteLength + image.andMask.byteLength, 0),
    sequence: [...source.sequence], rates: [...source.rates],
    animation: source.animation && { ...source.animation } } }
}

export interface CursorRectangle { left: number; top: number; width: number; height: number }
/** Viewport rectangles already include the actual DOM layout and zoom. The
 * source remains its intrinsic bitmap; drawImage must perform the CSS sizing. */
export interface CursorRasterLayer {
  readonly rectangle: CursorRectangle
  readonly clip: CursorRectangle
  readonly source?: HTMLCanvasElement | HTMLVideoElement
  readonly background?: string
  readonly opacity?: number
  readonly smoothing?: boolean
}
export interface CursorScene {
  /** A clipped, pointer-transparent plane above game/video and below controls. */
  readonly plane: HTMLElement
  readonly layers: readonly CursorRasterLayer[]
  /** Required only when the game canvas itself is transparent. This must be
   * the host's actual opaque backdrop, not a guessed fallback color. */
  readonly background?: string
}
export interface BrowserCursorOptions {
  resolve(id: number): SelectedCursorAsset | undefined
  scene(): CursorScene | undefined
}
export interface CursorPosition {
  readonly x: number
  readonly y: number
  readonly windowId?: number
  readonly revision?: number
  readonly cursorId: number
}
/** A placeholder can exist before its first committed opaque bitmap. The
 * presenter may retry this condition; it is never a usable black backdrop. */
export class CursorBackdropNotReady extends Error {
  constructor() {
    super('Custom cursor requires a readable opaque game backdrop')
    this.name = 'CursorBackdropNotReady'
  }
}
function intersection(a: CursorRectangle, b: CursorRectangle): CursorRectangle {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top)
  return { left, top, width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left),
    height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top) }
}
function clip(context: CanvasRenderingContext2D, rectangle: CursorRectangle, left: number, top: number) {
  context.beginPath()
  context.rect(rectangle.left - left, rectangle.top - top, rectangle.width, rectangle.height)
  context.clip()
}

/** Sample the committed DOM canvas bitmap and the host's ordered video layers.
 * No CSS blend mode can implement the colored destination-dependent XOR path.
 * The scratch bitmap is only one bounded cursor image, never a full-window copy. */
export function composeCursorBackdrop(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  scene: CursorScene,
  image: CursorImage,
  left: number,
  top: number,
): ImageData {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
      image.width < 1 || image.height < 1 || image.width > 256 || image.height > 256 ||
      image.data.length !== image.width * image.height * 4 ||
      image.andMask.length !== image.width * image.height ||
      !Number.isSafeInteger(left) || !Number.isSafeInteger(top))
    throw new Error('Invalid cursor backdrop dimensions or position')
  if (scene.background && !CSS.supports('color', scene.background))
    throw new Error('Invalid explicit cursor backdrop color')
  const bounds = canvas.getBoundingClientRect(),
    area = intersection(bounds, scene.plane.getBoundingClientRect())
  context.canvas.width = image.width
  context.canvas.height = image.height
  context.save()
  try {
    clip(context, area, left, top)
    if (scene.background) {
      context.fillStyle = scene.background
      context.fillRect(0, 0, image.width, image.height)
    }
    // A transferred HTMLCanvasElement is a CanvasImageSource: its committed
    // placeholder bitmap, rather than a later worker draw, is sampled here.
    const rendering = getComputedStyle(canvas).imageRendering
    context.imageSmoothingEnabled = rendering !== 'pixelated' && rendering !== 'crisp-edges'
    context.drawImage(canvas, bounds.left - left, bounds.top - top, bounds.width, bounds.height)
    for (const layer of scene.layers) {
      const rectangle = layer.rectangle, visible = intersection(area, layer.clip)
      if (!rectangle.width || !rectangle.height || !visible.width || !visible.height) continue
      context.save()
      try {
        clip(context, visible, left, top)
        context.globalAlpha = layer.opacity ?? 1
        if (layer.background) {
          context.fillStyle = layer.background
          context.fillRect(rectangle.left - left, rectangle.top - top, rectangle.width, rectangle.height)
        }
        if (layer.source) {
          context.imageSmoothingEnabled = layer.smoothing !== false
          context.drawImage(layer.source, rectangle.left - left, rectangle.top - top, rectangle.width, rectangle.height)
        }
      } finally { context.restore() }
    }
  } finally { context.restore() }
  const result = context.getImageData(0, 0, image.width, image.height),
    data = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength)
  // Edge pixels are clipped by the presentation plane too. Interior alpha
  // means an unknown HTML backdrop; RGB XOR cannot truthfully use that value.
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      if (left + x >= area.left && left + x + 1 <= area.left + area.width &&
          top + y >= area.top && top + y + 1 <= area.top + area.height &&
          data[(y * image.width + x) * 4 + 3] !== 255)
        throw new CursorBackdropNotReady()
  compositeCursor(image, { width: image.width, height: image.height, data }, 0, 0)
  return result
}

/** One presentation clock is shared by physical and virtual positions. This
 * schedules pixels only; all pointer observations still use BrowserInput. */
export class BrowserCursorPresenter {
  private readonly scratch = document.createElement('canvas')
  private readonly context: CanvasRenderingContext2D
  private overlay?: HTMLCanvasElement
  private asset?: SelectedCursorAsset
  private position?: () => CursorPosition | undefined
  private started = 0
  private frame?: number
  private closed = false
  private failed?: SelectedCursorAsset
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: () => CursorScene | undefined,
    private readonly visibility: (visible: boolean) => void,
    private readonly error: (error: unknown) => void,
  ) {
    const context = this.scratch.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Custom cursor backdrop canvas is unavailable')
    this.context = context
  }
  get visible(): boolean { return !!this.overlay?.isConnected }
  show(asset: SelectedCursorAsset, position: () => CursorPosition | undefined): void {
    if (this.closed) return
    if (this.asset !== asset) {
      this.asset = asset
      this.started = performance.now()
      this.failed = undefined
    }
    this.position = position
    if (this.failed === asset) return
    this.render(performance.now())
    this.schedule()
  }
  private schedule(): void {
    if (this.closed || !this.position || this.frame !== undefined || this.failed === this.asset) return
    this.frame = requestAnimationFrame((time) => {
      this.frame = undefined
      if (this.closed || !this.position) return
      this.render(time)
      this.schedule()
    })
  }
  private remove(): void {
    const overlay = this.overlay
    this.overlay = undefined
    if (overlay) {
      overlay.remove()
      overlay.width = overlay.height = 0
      this.visibility(false)
    }
  }
  private render(time: number): void {
    const asset = this.asset
    if (!asset || this.failed === asset) return
    try {
      const position = this.position?.(), scene = this.scene(), bounds = this.canvas.getBoundingClientRect()
      if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y)))
        throw new Error('Invalid custom cursor position')
      if (!position || !scene || !this.canvas.isConnected || !scene.plane.isConnected ||
          !bounds.width || !bounds.height || position.x < bounds.left || position.y < bounds.top ||
          position.x >= bounds.right || position.y >= bounds.bottom) {
        this.remove()
        return
      }
      const step = cursorStep(asset.asset, Math.max(0, time - this.started)),
        image = asset.selected[asset.asset.sequence[step]!]!,
        left = Math.round(position.x - image.hotspot.x), top = Math.round(position.y - image.hotspot.y),
        result = composeCursorBackdrop(this.context, this.canvas, scene, image, left, top),
        plane = scene.plane.getBoundingClientRect(),
        sx = plane.width / scene.plane.clientWidth, sy = plane.height / scene.plane.clientHeight
      if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) {
        this.remove()
        return
      }
      const overlay = this.overlay ?? document.createElement('canvas')
      overlay.width = image.width
      overlay.height = image.height
      const context = overlay.getContext('2d')
      if (!context) throw new Error('Custom cursor presentation canvas is unavailable')
      context.putImageData(result, 0, 0)
      overlay.className = `game-custom-cursor${position.revision === undefined ? '' : ' game-virtual-cursor'}`
      overlay.setAttribute('aria-hidden', 'true')
      // data-window-id identifies the transferred graphics canvas throughout
      // the player. Keep this second canvas out of those surface selectors.
      overlay.dataset.cursorWindowId = String(position.windowId ?? '')
      overlay.dataset.cursorId = String(position.cursorId)
      overlay.dataset.cursorStep = String(step)
      overlay.dataset.cursorShape = 'custom'
      if (position.revision === undefined) delete overlay.dataset.cursorRevision
      else overlay.dataset.cursorRevision = String(position.revision)
      Object.assign(overlay.style, {
        display: 'block', position: 'absolute', pointerEvents: 'none', userSelect: 'none', zIndex: '10',
        left: `${(left - plane.left) / sx}px`, top: `${(top - plane.top) / sy}px`,
        width: `${image.width / sx}px`, height: `${image.height / sy}px`, maxWidth: 'none', maxHeight: 'none',
        imageRendering: 'pixelated', aspectRatio: 'auto', margin: '0', border: '0', padding: '0',
        clipPath: `inset(${Math.max(0, bounds.top - top) / sy}px ${Math.max(0, left + image.width - bounds.right) / sx}px ${Math.max(0, top + image.height - bounds.bottom) / sy}px ${Math.max(0, bounds.left - left) / sx}px)`,
      })
      if (overlay.parentElement !== scene.plane) scene.plane.append(overlay)
      this.overlay = overlay
      this.visibility(true)
    } catch (error) {
      if (error instanceof CursorBackdropNotReady ||
          (error instanceof DOMException && error.name === 'InvalidStateError')) {
        this.remove()
        return
      }
      this.failed = asset
      this.remove()
      this.error(error)
    }
  }
  hide(): void {
    this.position = undefined
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.frame = undefined
    this.remove()
  }
  /** Asset retirement differs from leave/pause: no pixel reference survives. */
  clear(): void {
    this.hide()
    this.asset = this.failed = undefined
    this.scratch.width = this.scratch.height = 0
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.clear()
  }
}
