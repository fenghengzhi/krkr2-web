import type { WindowGeometry } from '../ports/window-geometry.ts'
import { copyWindowGeometry } from './window-geometry.ts'
import { TvpError } from '../system/tvp-error.ts'

export interface WindowView {
  width: number
  height: number
  left: number
  top: number
  caption: string
  visible: boolean
  borderStyle: number
  innerSunken: boolean
  showScrollBars: boolean
  focusable: boolean
  /** Host modal routing state; this never changes the script's Window properties. */
  blocked?: boolean
  fullScreen: boolean
  layerLeft: number
  layerTop: number
  zoomNumer: number
  zoomDenom: number
  mouseCursorState: number
  useMouseKey?: boolean
  /** Immutable region payloads travel separately, once per replacement. */
  regionRevision?: number
  stayOnTop?: boolean
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
  geometry?: WindowGeometry
}

export interface WindowPresentation {
  id: number
  view: WindowView
  active: boolean
  main: boolean
}

/** Logical window coordinates are independent of the page's responsive scale. */
export class WindowState implements WindowView {
  width = 800
  height = 600
  left = 0
  top = 0
  caption = 'krkr2-web'
  visible = false
  borderStyle = 2
  innerSunken = false
  showScrollBars = true
  focusable = true
  fullScreen = false
  layerLeft = 0
  layerTop = 0
  zoomNumer = 1
  zoomDenom = 1
  mouseCursorState = 0
  minWidth = 0
  minHeight = 0
  maxWidth = 0
  maxHeight = 0
  imeMode = 0
  trapKey = false
  /** Native trapped-message admission is a Window-wide latch, not a key set. */
  trappedKeysArmed = false
  keyboardRevision = 0
  useMouseKey = false
  regionRevision = 0
  stayOnTop = false
  revision = 0
  geometry?: WindowGeometry
  innerWidthRequest = 800
  innerHeightRequest = 600
  fullscreenRestore?: { left: number; top: number; width: number; height: number; innerSunken: boolean }
  get innerWidth(): number {
    return (this.geometry?.client.width ?? this.width) - (this.innerSunken ? 4 : 0)
  }
  get innerHeight(): number {
    return (this.geometry?.client.height ?? this.height) - (this.innerSunken ? 4 : 0)
  }
  get viewportWidth(): number { return this.geometry?.viewport.width ?? Math.max(0, this.innerWidth) }
  get viewportHeight(): number { return this.geometry?.viewport.height ?? Math.max(0, this.innerHeight) }
  /** Public KRKR2 setters reject even no-op assignments in fullscreen.
   * Host placement, rollback and native close still use set()/resize(). */
  assertWindowed(): void {
    if (this.fullScreen) throw new TvpError('TVPInvalidPropertyInFullScreen', [], 'Window property cannot be changed in fullscreen')
  }
  setScript(property: string, value: string | number): void {
    if (['visible', 'width', 'height', 'left', 'top', 'minWidth', 'minHeight',
      'maxWidth', 'maxHeight', 'innerSunken', 'innerWidth', 'innerHeight', 'borderStyle'].includes(property))
      this.assertWindowed()
    this.set(property, value)
  }
  resizeScript(width: number, height: number): void {
    this.assertWindowed()
    this.resize(width, height)
  }
  set(property: string, value: string | number): void {
    if (property === 'caption') this.caption = String(value)
    else {
      const number = Number(value)
      if (!Number.isSafeInteger(number)) throw new Error(`Invalid Window.${property}`)
      if (property === 'width') this.resize(number, this.height)
      else if (property === 'height') this.resize(this.width, number)
      else if (property === 'innerWidth') this.resizeInner(number, undefined)
      else if (property === 'innerHeight') this.resizeInner(undefined, number)
      else if (['left', 'top', 'layerLeft', 'layerTop'].includes(property))
        this[property as 'left'] = number
      else if (property === 'trapKey') {
        this.trapKey = !!number
        if (this.trapKey) this.trappedKeysArmed = false
        this.keyboardRevision++
      } else if (
        [
          'visible',
          'innerSunken',
          'showScrollBars',
          'focusable',
          'fullScreen',
          'useMouseKey',
          'stayOnTop',
        ].includes(property)
      ) {
        this[property as 'visible'] = !!number
        if (property === 'visible' || property === 'focusable') this.keyboardRevision++
      } else if (property === 'borderStyle') {
        if (number < 0 || number > 5) throw new Error('Invalid window border style')
        this.borderStyle = number
      } else if (property === 'mouseCursorState') {
        if (number < 0 || number > 2) throw new Error('Invalid cursor state')
        this.mouseCursorState = number
      } else if (property === 'imeMode') this.imeMode = number
      else if (property === 'zoomNumer' || property === 'zoomDenom') {
        this.setZoom(property === 'zoomNumer' ? number : this.zoomNumer,
          property === 'zoomDenom' ? number : this.zoomDenom)
      } else if (['minWidth', 'minHeight', 'maxWidth', 'maxHeight'].includes(property)) {
        if (number < 0 || number > 4096) throw new Error('Invalid window size constraint')
        this[property as 'minWidth'] = number
      } else throw new Error(`Unsupported Window property: ${property}`)
    }
    this.revision++
  }
  admitTrappedKey(type: 'keyDown' | 'keyUp' | 'text', systemKey = false): boolean {
    if (type === 'keyDown' && !systemKey) this.trappedKeysArmed = true
    const admitted = this.trappedKeysArmed
    if (type === 'keyUp' && !systemKey) this.trappedKeysArmed = true
    return admitted
  }
  resize(width: number, height: number): void {
    if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 4096))
      throw new Error('Window dimensions must be between 1 and 4096')
    this.width = Math.max(this.minWidth, Math.min(this.maxWidth || 4096, width))
    this.height = Math.max(this.minHeight, Math.min(this.maxHeight || 4096, height))
    this.revision++
  }
  resizeInner(width?: number, height?: number): void {
    for (const value of [width, height]) if (value !== undefined &&
        (!Number.isInteger(value) || value <= 0 || value > 4096))
      throw new Error('Window inner dimensions must be between 1 and 4096')
    if (width !== undefined) this.innerWidthRequest = width
    if (height !== undefined) this.innerHeightRequest = height
    this.revision++
  }
  setZoom(numer: number, denom: number): void {
    if (![numer, denom].every((value) => Number.isInteger(value) && value > 0 && value <= 65536))
      throw new Error('Invalid window zoom')
    let a = numer, b = denom
    while (b) { const remainder = a % b; a = b; b = remainder }
    this.zoomNumer = numer / a
    this.zoomDenom = denom / a
    this.revision++
  }
  copy(): WindowState {
    const result = Object.assign(new WindowState(), this)
    result.geometry = this.geometry && copyWindowGeometry(this.geometry)
    result.fullscreenRestore = this.fullscreenRestore && { ...this.fullscreenRestore }
    return result
  }
  commitGeometry(geometry: WindowGeometry): void {
    this.geometry = copyWindowGeometry(geometry)
    this.width = geometry.outer.width
    this.height = geometry.outer.height
    this.revision++
  }
  view(): WindowView {
    const {
      width,
      height,
      left,
      top,
      caption,
      visible,
      borderStyle,
      innerSunken,
      showScrollBars,
      focusable,
      fullScreen,
      layerLeft,
      layerTop,
      zoomNumer,
      zoomDenom,
      mouseCursorState,
      useMouseKey,
      regionRevision,
      stayOnTop,
      minWidth,
      minHeight,
      maxWidth,
      maxHeight,
    } = this
    return {
      width,
      height,
      left,
      top,
      caption,
      visible,
      borderStyle,
      innerSunken,
      showScrollBars,
      focusable,
      fullScreen,
      layerLeft,
      layerTop,
      zoomNumer,
      zoomDenom,
      mouseCursorState,
      useMouseKey,
      regionRevision,
      stayOnTop,
      minWidth,
      minHeight,
      maxWidth,
      maxHeight,
      ...(this.geometry ? { geometry: copyWindowGeometry(this.geometry) } : {}),
    }
  }
}
