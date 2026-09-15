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
  stayOnTop?: boolean
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
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
  useMouseKey = false
  stayOnTop = false
  revision = 0
  get innerWidth(): number {
    return this.width
  }
  get innerHeight(): number {
    return this.height
  }
  set(property: string, value: string | number): void {
    if (property === 'caption') this.caption = String(value)
    else {
      const number = Number(value)
      if (!Number.isSafeInteger(number)) throw new Error(`Invalid Window.${property}`)
      if (property === 'width' || property === 'innerWidth') this.resize(number, this.height)
      else if (property === 'height' || property === 'innerHeight') this.resize(this.width, number)
      else if (['left', 'top', 'layerLeft', 'layerTop'].includes(property))
        this[property as 'left'] = number
      else if (
        [
          'visible',
          'innerSunken',
          'showScrollBars',
          'focusable',
          'fullScreen',
          'trapKey',
          'useMouseKey',
          'stayOnTop',
        ].includes(property)
      )
        this[property as 'visible'] = !!number
      else if (property === 'borderStyle') {
        if (number < 0 || number > 5) throw new Error('Invalid window border style')
        this.borderStyle = number
      } else if (property === 'mouseCursorState') {
        if (number < 0 || number > 2) throw new Error('Invalid cursor state')
        this.mouseCursorState = number
      } else if (property === 'imeMode') this.imeMode = number
      else if (property === 'zoomNumer' || property === 'zoomDenom') {
        if (number <= 0 || number > 65536) throw new Error('Invalid window zoom')
        this[property] = number
      } else if (['minWidth', 'minHeight', 'maxWidth', 'maxHeight'].includes(property)) {
        if (number < 0 || number > 4096) throw new Error('Invalid window size constraint')
        this[property as 'minWidth'] = number
      } else throw new Error(`Unsupported Window property: ${property}`)
    }
    this.revision++
  }
  resize(width: number, height: number): void {
    if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 4096))
      throw new Error('Window dimensions must be between 1 and 4096')
    this.width = Math.max(this.minWidth, Math.min(this.maxWidth || 4096, width))
    this.height = Math.max(this.minHeight, Math.min(this.maxHeight || 4096, height))
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
      stayOnTop,
      minWidth,
      minHeight,
      maxWidth,
      maxHeight,
    }
  }
}
