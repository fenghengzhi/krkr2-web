import type { InputPacket, InputView } from '../../engine/ports/input.ts'
import type { WindowView } from '../../engine/scene/window.ts'
import { paintBoxPoint } from '../../engine/scene/draw-device.ts'
const cursors: Record<number, string> = {
  0: 'default',
  [-1]: 'none',
  [-2]: 'default',
  [-3]: 'crosshair',
  [-4]: 'text',
  [-5]: 'move',
  [-6]: 'nesw-resize',
  [-7]: 'ns-resize',
  [-8]: 'nwse-resize',
  [-9]: 'ew-resize',
  [-10]: 'n-resize',
  [-11]: 'wait',
  [-12]: 'grab',
  [-14]: 'col-resize',
  [-15]: 'row-resize',
  [-17]: 'progress',
  [-18]: 'not-allowed',
  [-19]: 'progress',
  [-20]: 'help',
  [-21]: 'pointer',
  [-22]: 'move',
  1: 'vertical-text',
}
export function virtualKey(event: Pick<KeyboardEvent, 'key' | 'code' | 'keyCode'>): number {
  if (event.keyCode && event.keyCode !== 229) return event.keyCode
  const special: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Pause: 19,
    CapsLock: 20,
    Escape: 27,
    ' ': 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    PrintScreen: 44,
    Insert: 45,
    Delete: 46,
    Meta: 91,
    ContextMenu: 93,
    NumLock: 144,
    ScrollLock: 145,
  }
  if (special[event.key] !== undefined) return special[event.key]!
  if (/^F\d+$/.test(event.key)) return 111 + Number(event.key.slice(1))
  if (/^Numpad\d$/.test(event.code)) return 96 + Number(event.code.slice(-1))
  if (event.key.length === 1 && /^[a-z0-9]$/i.test(event.key))
    return event.key.toUpperCase().charCodeAt(0)
  return (
    {
      Semicolon: 186,
      Equal: 187,
      Comma: 188,
      Minus: 189,
      Period: 190,
      Slash: 191,
      Backquote: 192,
      BracketLeft: 219,
      Backslash: 220,
      BracketRight: 221,
      Quote: 222,
      NumpadAdd: 107,
      NumpadSubtract: 109,
      NumpadMultiply: 106,
      NumpadDivide: 111,
      NumpadDecimal: 110,
    }[event.code] ?? 0
  )
}
export function shiftState(
  event: Pick<MouseEvent, 'shiftKey' | 'altKey' | 'ctrlKey' | 'buttons'>,
  repeat = false,
): number {
  return (
    (event.shiftKey ? 1 : 0) |
    (event.altKey ? 2 : 0) |
    (event.ctrlKey ? 4 : 0) |
    (event.buttons & 1 ? 8 : 0) |
    (event.buttons & 2 ? 16 : 0) |
    (event.buttons & 4 ? 32 : 0) |
    (repeat ? 128 : 0) |
    (event.buttons & 8 ? 256 : 0) |
    (event.buttons & 16 ? 512 : 0)
  )
}
/** Shared page input is scheduled at DOM observation time, before any VM await. */
export interface BrowserInputHooks {
  enqueue(packet: InputPacket): void
  pointer(x: number, y: number, sequence: number): void
  modifiers(shift: number, pointer: boolean): void
  key(key: number, down: boolean): void
  activate(): boolean
  deactivate(pageBlur: boolean, nextTarget: EventTarget | null): void
  keyboard(event?: KeyboardEvent): boolean
  mouse(type: 'down' | 'move' | 'up', buttons: number): boolean
}
/** Retained by the coordinator across replacement surfaces of one Window. */
export interface BrowserCursorState {
  physicalSequence: number
  highestRevision: number
  retiredRevision: number
}

const cursorArtwork: Record<string, { path: string; x: number; y: number }> = {
  default: { path: 'M3 2 L3 19 L7 15 L11 22 L14 20 L10 13 L18 13 Z', x: 3, y: 2 },
  crosshair: { path: 'M12 2V22M2 12H22M8 8H16V16H8Z', x: 12, y: 12 },
  text: { path: 'M8 2H16M12 2V22M8 22H16', x: 12, y: 12 },
  'vertical-text': { path: 'M2 8V16M2 12H22M22 8V16', x: 12, y: 12 },
  move: { path: 'M12 2V22M2 12H22M8 6L12 2L16 6M8 18L12 22L16 18M6 8L2 12L6 16M18 8L22 12L18 16', x: 12, y: 12 },
  'ew-resize': { path: 'M2 12H22M7 7L2 12L7 17M17 7L22 12L17 17', x: 12, y: 12 },
  'ns-resize': { path: 'M12 2V22M7 7L12 2L17 7M7 17L12 22L17 17', x: 12, y: 12 },
  'nwse-resize': { path: 'M3 3L21 21M3 10V3H10M14 21H21V14', x: 12, y: 12 },
  'nesw-resize': { path: 'M21 3L3 21M14 3H21V10M3 14V21H10', x: 12, y: 12 },
  'n-resize': { path: 'M12 3V22M5 10L12 3L19 10', x: 12, y: 3 },
  'col-resize': { path: 'M9 2V22M15 2V22M1 12H7M4 9L1 12L4 15M17 12H23M20 9L23 12L20 15', x: 12, y: 12 },
  'row-resize': { path: 'M2 9H22M2 15H22M12 1V7M9 4L12 1L15 4M12 17V23M9 20L12 23L15 20', x: 12, y: 12 },
  wait: { path: 'M5 2H19M5 22H19M7 2V6L17 18V22M17 2V6L7 18V22M7 6H17M7 18H17', x: 12, y: 12 },
  progress: { path: 'M3 2V19L7 15L11 22L14 20L10 13H18ZM17 2A4 4 0 1 1 16 10', x: 3, y: 2 },
  'not-allowed': { path: 'M21 12A9 9 0 1 1 3 12A9 9 0 1 1 21 12ZM6 6L18 18', x: 12, y: 12 },
  pointer: { path: 'M9 22L4 13Q3 10 6 11L9 14V3Q9 0 12 3V10Q13 7 15 10Q17 8 18 11Q22 9 21 14L19 22Z', x: 10, y: 2 },
  grab: { path: 'M6 21L2 12Q2 9 5 11L7 14V6Q7 3 9 5L10 11V4Q11 1 13 4V11L15 5Q18 3 17 7L16 13L19 9Q22 8 21 12L18 21Z', x: 12, y: 12 },
  help: { path: 'M3 2V19L7 15L11 22L14 20L10 13H18ZM16 3Q16 0 20 1Q24 3 20 6L19 8M19 10V11', x: 3, y: 2 },
}
export class BrowserInput {
  private readonly abort = new AbortController()
  private readonly text: HTMLTextAreaElement
  private resizeObserver?: ResizeObserver
  private queue: InputPacket[] = []
  private sending = false
  private disposed = false
  private suspended = false
  private epoch = 0
  private captured = new Set<number>()
  private active = false
  private composing = false
  private composed = ''
  private retiredComposition = ''
  private composeTimer?: ReturnType<typeof setTimeout>
  private mouseButtons = 0
  private pressed = new Set<number>()
  private touches = new Map<number, { x: number; y: number; startX: number; startY: number }>()
  private mouseTouch: number | undefined
  private clicks = new Map<number, number>()
  private view?: WindowView
  private input?: InputView
  private sourceWindowId?: number
  private keyboardRoute = ''
  private virtualMarker?: HTMLSpanElement
  private markerShape = ''
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sendPacket: (packet: InputPacket) => Promise<void>,
    private readonly sendKeys: (keys: number[]) => Promise<void>,
    private readonly sendPointer: (x: number, y: number, sequence?: number) => Promise<void>,
    private readonly error: (error: unknown) => void,
    private readonly shared?: BrowserInputHooks,
    private readonly cursorState: BrowserCursorState = {
      physicalSequence: 0,
      highestRevision: 0,
      retiredRevision: 0,
    },
  ) {
    this.text = document.createElement('textarea')
    this.text.setAttribute('aria-label', '游戏文字输入')
    this.text.className = 'game-text-input'
    this.text.tabIndex = -1
    this.text.autocomplete = 'off'
    this.text.spellcheck = false
    Object.assign(this.text.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      opacity: '0',
      padding: '0',
      border: '0',
      fontSize: '16px',
      pointerEvents: 'none',
      resize: 'none',
    })
    canvas.parentElement?.append(this.text)
    canvas.style.touchAction = 'none'
    const options = { signal: this.abort.signal }
    canvas.addEventListener('focus', () => this.focus(), options)
    this.text.addEventListener('focus', () => this.activate(), options)
    this.text.addEventListener(
      'blur',
      (event) => this.deactivate(false, event.relatedTarget),
      options,
    )
    window.addEventListener('blur', () => this.deactivate(true), options)
    canvas.addEventListener('mousedown', (event) => this.mouse(event, 'down'), options)
    window.addEventListener(
      'mousemove',
      (event) => {
        if (event.target === canvas || this.mouseButtons) this.mouse(event, 'move')
      },
      options,
    )
    window.addEventListener(
      'mouseup',
      (event) => {
        if (this.mouseButtons) this.mouse(event, 'up')
      },
      options,
    )
    canvas.addEventListener('mouseleave', () => this.push({ type: 'leave' }), options)
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options)
    canvas.addEventListener(
      'click',
      (event) => {
        if (
          event.detail === 0 &&
          !(event instanceof PointerEvent && event.pointerType === 'touch')
        ) {
          if (this.shared && !this.shared.mouse('down', 1)) return
          this.focus()
          const p = this.point(event.clientX, event.clientY)
          this.push({ type: 'down', ...p, shift: 8, button: 0, clicks: 1 })
          this.shared?.mouse('up', 0)
          this.push({ type: 'up', ...p, shift: 0, button: 0, clicks: 1 })
        }
      },
      options,
    )
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        const p = this.point(event.clientX, event.clientY)
        const delta = Math.round(
          -event.deltaY *
            (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? this.canvas.clientHeight : 1),
        )
        this.push({ type: 'wheel', ...p, shift: shiftState(event), delta })
      },
      { ...options, passive: false },
    )
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const)
      canvas.addEventListener(type, (event) => this.touch(event), options)
    for (const target of [canvas, this.text]) {
      target.addEventListener('keydown', (event) => this.key(event as KeyboardEvent, true), options)
      target.addEventListener('keyup', (event) => this.key(event as KeyboardEvent, false), options)
    }
    this.text.addEventListener(
      'compositionstart',
      () => {
        if (!this.keyboard()) return
        clearTimeout(this.composeTimer)
        this.composing = true
        this.composed = ''
        this.retiredComposition = ''
      },
      options,
    )
    this.text.addEventListener(
      'compositionend',
      (event) => {
        const commit = this.keyboard() && this.composing
        this.composing = false
        this.composed = event.data
        if (!commit) this.retiredComposition = event.data
        this.text.value = ''
        if (commit && event.data) this.push({ type: 'text', text: event.data }, true)
        clearTimeout(this.composeTimer)
        this.composeTimer = setTimeout(() => {
          this.composed = ''
        }, 0)
      },
      options,
    )
    this.text.addEventListener(
      'input',
      (event) => {
        if (!this.keyboard()) {
          this.text.value = ''
          return
        }
        const inputEvent = event as InputEvent
        if (this.composing || inputEvent.isComposing) return
        const value = this.text.value,
          compositionInput =
            !inputEvent.inputType ||
            inputEvent.inputType === 'insertCompositionText' ||
            inputEvent.inputType === 'insertFromComposition'
        this.text.value = ''
        // A paste/drop or other new editing operation is not a late IME
        // duplicate merely because it contains the same characters. Retired
        // ownership only suppresses composition commits (and legacy events
        // without an inputType); the short live-commit dedupe is separate.
        if (!compositionInput) this.retiredComposition = ''
        if (inputEvent.inputType === 'insertFromPaste' || inputEvent.inputType === 'insertFromDrop')
          this.composed = ''
        if (value && value !== this.composed && value !== this.retiredComposition)
          this.push({ type: 'text', text: value }, compositionInput)
        this.composed = ''
        this.retiredComposition = ''
      },
      options,
    )
    window.addEventListener('resize', () => this.appearance(), options)
    window.addEventListener('scroll', () => this.appearance(), {
      ...options,
      capture: true,
      passive: true,
    })
    // Responsive layout and fullscreen fitting change CSS dimensions without
    // changing the game's logical Window or InputView.
    if (typeof ResizeObserver !== 'undefined') {
      try {
        this.resizeObserver = new ResizeObserver(() => this.appearance())
        this.resizeObserver.observe(canvas)
      } catch {
        try {
          this.resizeObserver?.disconnect()
        } catch {}
        this.resizeObserver = undefined
      }
    }
  }
  setWindow(view: WindowView): void {
    this.view = view
    this.appearance()
  }
  setInput(input: InputView, sourceWindowId?: number): void {
    const route = input.keyboardRoute,
      signature = [
        sourceWindowId ?? '',
        input.focused,
        route?.windowId ?? '',
        route?.revision ?? '',
        route?.focused ?? '',
      ].join(':')
    // A roster/input refresh may update presentation without changing logical
    // ownership. Only identity/focus/route changes retire an in-flight edit;
    // zoom, attention coordinates and CSS resize never restart composition.
    if ((this.input || this.composing) && this.keyboardRoute !== signature) this.cancelComposition()
    this.keyboardRoute = signature
    this.input = input
    this.sourceWindowId = sourceWindowId
    const virtual = input.virtualCursor
    if (virtual && Number.isSafeInteger(virtual.revision) && virtual.revision > 0)
      this.cursorState.highestRevision = Math.max(this.cursorState.highestRevision, virtual.revision)
    this.appearance()
  }
  setSuspended(suspended: boolean): void {
    if (this.disposed || this.suspended === suspended) return
    this.suspended = suspended
    if (suspended) {
      this.epoch++
      this.retireVirtualCursor()
      this.queue = []
      this.active = false
      this.cancelComposition()
      this.mouseButtons = 0
      this.mouseTouch = undefined
      this.clicks.clear()
      this.touches.clear()
      this.pressed.clear()
      this.releasePointerCaptures()
      this.keys()
    } else if (document.activeElement === this.text) this.activate()
    this.appearance()
  }
  private appearance(): void {
    if (this.disposed) return
    this.canvas.style.cursor = this.view?.mouseCursorState
      ? 'none'
      : (cursors[this.input?.cursor ?? 0] ?? 'default')
    this.canvas.title = this.input?.hint ?? ''
    this.cursorAppearance()
    const route = this.input?.keyboardRoute,
      crossWindow = !!route && route.windowId !== this.sourceWindowId,
      attention = crossWindow ? null : this.input?.attention,
      x = attention?.x ?? 0,
      y = attention?.y ?? 0,
      font = attention?.font,
      height = Math.abs(font?.height ?? 16)
    this.text.style.left = `${this.canvas.offsetLeft + (x * this.canvas.clientWidth) / (this.view?.width ?? 800)}px`
    this.text.style.top = `${this.canvas.offsetTop + (y * this.canvas.clientHeight) / (this.view?.height ?? 600)}px`
    // This is a CSS input hint using the focused Layer's sampled Font, not an
    // operating-system candidate-window font. Cross-Window routing retains the
    // real source textarea and its default placement instead of focusing the
    // receiver's (possibly nonfocusable) surface.
    this.text.style.fontFamily = font?.face ?? ''
    this.text.style.fontSize = `${Number.isFinite(height) && height >= 1 && height <= 256 ? height : 16}px`
    this.text.style.fontWeight = font ? (font.bold ? 'bold' : 'normal') : ''
    this.text.style.fontStyle = font ? (font.italic ? 'italic' : 'normal') : ''
    this.text.style.textDecorationLine = font
      ? [font.underline ? 'underline' : '', font.strikeout ? 'line-through' : '']
          .filter(Boolean)
          .join(' ') || 'none'
      : ''
    this.text.inputMode = (route?.imeMode ?? this.input?.imeMode) === 0 ? 'none' : 'text'
  }
  private retireVirtualCursor(): void {
    this.cursorState.retiredRevision = Math.max(
      this.cursorState.retiredRevision,
      this.cursorState.highestRevision,
    )
    this.removeVirtualMarker()
  }
  private removeVirtualMarker(): void {
    this.virtualMarker?.remove()
    this.virtualMarker = undefined
    this.markerShape = ''
    this.canvas.style.cursor = this.view?.mouseCursorState
      ? 'none'
      : (cursors[this.input?.cursor ?? 0] ?? 'default')
  }
  private cursorAppearance(): void {
    if (this.suspended || this.view?.visible === false || this.view?.blocked) {
      this.retireVirtualCursor()
      return
    }
    const cursor = this.input?.virtualCursor,
      shape = cursors[this.input?.cursor ?? 0] ?? 'default',
      width = this.view?.width ?? 800,
      height = this.view?.height ?? 600
    if (
      !cursor ||
      !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y) ||
      !Number.isSafeInteger(cursor.revision) ||
      cursor.revision <= this.cursorState.retiredRevision ||
      cursor.revision < this.cursorState.highestRevision ||
      !Number.isSafeInteger(cursor.basePhysicalSequence) ||
      cursor.basePhysicalSequence < this.cursorState.physicalSequence ||
      cursor.x < 0 || cursor.y < 0 || cursor.x >= width || cursor.y >= height ||
      this.view?.mouseCursorState || shape === 'none' ||
      !this.canvas.parentElement
    ) {
      this.removeVirtualMarker()
      return
    }
    const artwork = cursorArtwork[shape] ?? cursorArtwork.default!
    if (!this.virtualMarker) {
      const marker = document.createElement('span')
      marker.className = 'game-virtual-cursor'
      marker.setAttribute('aria-hidden', 'true')
      Object.assign(marker.style, {
        position: 'absolute',
        width: '24px',
        height: '24px',
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: '6',
        lineHeight: '0',
      })
      this.virtualMarker = marker
      this.canvas.parentElement.append(marker)
    }
    const marker = this.virtualMarker
    marker.dataset.windowId = String(this.sourceWindowId ?? '')
    marker.dataset.cursorRevision = String(cursor.revision)
    marker.dataset.cursorShape = shape
    if (this.markerShape !== shape) {
      // Fixed artwork only. No game string or storage name becomes SVG markup.
      const fill = shape === 'default' || shape === 'pointer' || shape === 'grab' || shape === 'help' || shape === 'progress'
        ? '#fff' : 'none'
      marker.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="${artwork.path}" fill="${fill}" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/><path d="${artwork.path}" fill="${fill}" stroke="#101620" stroke-width="1.5" stroke-linejoin="round"/></svg>`
      this.markerShape = shape
    }
    marker.style.left = `${this.canvas.offsetLeft + cursor.x * this.canvas.clientWidth / width}px`
    marker.style.top = `${this.canvas.offsetTop + cursor.y * this.canvas.clientHeight / height}px`
    marker.style.transform = `translate(${-artwork.x}px, ${-artwork.y}px)`
    this.canvas.style.cursor = 'none'
  }
  private point(x: number, y: number) {
    const bounds = this.canvas.getBoundingClientRect()
    return {
      x: ((x - bounds.left) * (this.view?.width ?? 800)) / bounds.width,
      y: ((y - bounds.top) * (this.view?.height ?? 600)) / bounds.height,
    }
  }
  focus(): boolean {
    if (
      this.view?.focusable === false ||
      this.view?.visible === false ||
      this.disposed ||
      this.suspended
    )
      return false
    // Focusing the canvas first would blur its already focused textarea, losing
    // capture and composition and queuing a false deactivate/activate pair.
    if (document.activeElement !== this.text) this.text.focus({ preventScroll: true })
    if (document.activeElement !== this.text) return false
    this.activate()
    return this.active
  }
  private releasePointerCaptures(): void {
    for (const id of this.captured) {
      try {
        if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id)
      } catch {}
    }
    this.captured.clear()
  }
  private keys(): void {
    if (this.shared) return
    void this.sendKeys([...this.pressed]).catch((error) => {
      if (!this.disposed) this.error(error)
    })
  }
  private modifiers(shift: number, pointer = true): void {
    if (this.shared) {
      this.shared.modifiers(shift, pointer)
      return
    }
    for (const [key, mask] of [
      [16, 1],
      [18, 2],
      [17, 4],
      [1, 8],
      [2, 16],
      [4, 32],
      [5, 256],
      [6, 512],
    ])
      shift & mask! ? this.pressed.add(key!) : this.pressed.delete(key!)
    this.keys()
  }
  private mouse(event: MouseEvent, type: 'down' | 'move' | 'up'): void {
    if (this.suspended || this.disposed) return
    if (this.shared && !this.shared.mouse(type, event.buttons)) return
    const button = [0, 2, 1, 3, 4][event.button] ?? 0,
      p = this.point(event.clientX, event.clientY)
    if (type === 'down') {
      event.preventDefault()
      this.focus()
      this.mouseButtons = event.buttons || this.mouseButtons | (1 << event.button)
      this.clicks.set(button, event.detail || 1)
    }
    const shift = shiftState(event)
    this.modifiers(shift)
    this.push({
      type,
      ...p,
      button,
      shift,
      clicks: type === 'up' ? (this.clicks.get(button) ?? 0) : 0,
    })
    if (type === 'up') {
      this.mouseButtons = event.buttons
      this.clicks.delete(button)
    }
  }
  private touch(event: PointerEvent): void {
    if (this.suspended || this.disposed) return
    if (event.type === 'pointerdown') this.captured.add(event.pointerId)
    else if (event.type === 'pointerup' || event.type === 'pointercancel')
      this.captured.delete(event.pointerId)
    if (event.pointerType !== 'touch') {
      if (event.type === 'pointerdown') this.canvas.setPointerCapture(event.pointerId)
      if (event.type === 'pointercancel') {
        this.mouseButtons = 0
        this.shared?.mouse('up', 0)
        this.modifiers(shiftState(event))
        this.push({ type: 'cancel' })
      }
      return
    }
    this.retireVirtualCursor()
    event.preventDefault()
    const p = this.point(event.clientX, event.clientY),
      bounds = this.canvas.getBoundingClientRect()
    const packet = {
      ...p,
      width: (event.width * (this.view?.width ?? 800)) / bounds.width,
      height: (event.height * (this.view?.height ?? 600)) / bounds.height,
      id: event.pointerId,
    }
    if (event.type === 'pointerdown') {
      this.focus()
      this.canvas.setPointerCapture(event.pointerId)
      this.touches.set(event.pointerId, { ...p, startX: p.x, startY: p.y })
      this.push({ type: 'touchDown', ...packet })
      if (this.touches.size === 1) {
        this.mouseTouch = event.pointerId
        this.push({ type: 'down', ...p, button: 0, shift: 8, clicks: 0 })
      } else if (this.mouseTouch !== undefined) {
        const first = this.touches.get(this.mouseTouch)!
        this.push({ type: 'up', x: first.x, y: first.y, button: 0, shift: 0, clicks: 0 })
        this.mouseTouch = undefined
      }
    } else if (this.touches.has(event.pointerId)) {
      const previous = this.touches.get(event.pointerId)!
      if (event.type === 'pointermove') {
        Object.assign(previous, p)
        this.push({ type: 'touchMove', ...packet })
        if (this.mouseTouch === event.pointerId)
          this.push({ type: 'move', ...p, button: 0, shift: 8, clicks: 0 })
      } else {
        this.push({ type: 'touchUp', ...packet })
        if (this.mouseTouch === event.pointerId) {
          this.push({
            type: 'up',
            ...p,
            button: 0,
            shift: 0,
            clicks: event.type === 'pointercancel' ? 0 : 1,
          })
          this.mouseTouch = undefined
        }
        this.touches.delete(event.pointerId)
      }
    }
  }
  private key(event: KeyboardEvent, down: boolean): void {
    if (!this.keyboard(event)) return
    if (this.composing || event.isComposing || event.keyCode === 229) return
    if (down) this.retiredComposition = ''
    const key = virtualKey(event),
      shift = shiftState(
        {
          ...event,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          buttons: this.mouseButtons,
        },
        event.repeat,
      )
    if (down) this.pressed.add(key)
    else this.pressed.delete(key)
    this.shared?.key(key, down)
    this.modifiers(shift, false)
    if (event.defaultPrevented) return
    // DOM has no WM_SYSKEY message class. This explicit Web mapping only
    // covers Alt-modified keys, Alt itself and F10; it does not claim to
    // classify every native Windows system-key message.
    this.push({
      type: down ? 'keyDown' : 'keyUp',
      key,
      shift,
      ...(event.altKey || key === 18 || key === 121 ? { systemKey: true } : {}),
    })
    const controls: Record<string, string> = { Enter: '\r', Escape: '\u001b', Backspace: '\b' }
    if (down && controls[event.key] !== undefined) {
      event.preventDefault()
      this.push({ type: 'text', text: controls[event.key]! })
    } else if (
      [
        'Tab',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'PageUp',
        'PageDown',
        'Home',
        'End',
        'Delete',
      ].includes(event.key)
    )
      event.preventDefault()
  }
  private keyboard(event?: KeyboardEvent): boolean {
    return (
      !this.suspended &&
      !this.disposed &&
      this.ownsFocus(document.activeElement) &&
      (this.shared?.keyboard(event) ?? true)
    )
  }
  private activate(): void {
    if (this.suspended || this.disposed || this.active) return
    if (this.shared) {
      this.active = this.shared.activate()
      return
    }
    this.active = true
    this.push({ type: 'activate' })
  }
  ownsFocus(target: EventTarget | null): boolean {
    return target === this.canvas || target === this.text
  }
  /** Coordinator-driven Window focus can move between DOM controls without
   * focusing this textarea. Keep its private activation guard in agreement. */
  setWindowActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
    if (!active) this.clearTransient()
  }
  private clearTransient(): void {
    this.mouseButtons = 0
    this.clicks.clear()
    this.touches.clear()
    this.releasePointerCaptures()
    this.mouseTouch = undefined
    this.pressed.clear()
    this.cancelComposition()
    this.keys()
  }
  private cancelComposition(): void {
    // Keep one retired commit solely to reject its trailing input event if a
    // route/focus change occurs between compositionend and that duplicate.
    // A new composition or ordinary keydown starts a fresh editing sequence.
    this.retiredComposition = this.composed || this.retiredComposition
    this.composing = false
    this.composed = ''
    this.text.value = ''
    clearTimeout(this.composeTimer)
  }
  private deactivate(pageBlur = false, nextTarget: EventTarget | null = null): void {
    if (pageBlur) this.retireVirtualCursor()
    const captured = !!(this.mouseButtons || this.touches.size || this.captured.size)
    if (this.shared) {
      this.clearTransient()
      this.shared.deactivate(pageBlur, nextTarget)
      // Moving into this Window's menu can release pointer ownership without
      // falsely reporting that the native Window itself deactivated.
      if (captured && this.shared.keyboard()) this.push({ type: 'cancel' })
      return
    }
    if (!this.active && !captured) return
    this.active = false
    this.clearTransient()
    this.push({ type: 'deactivate' })
  }
  private push(packet: InputPacket, composition = false): void {
    if (this.disposed || this.suspended) return
    if (
      this.input?.keyboardRoute &&
      (packet.type === 'keyDown' || packet.type === 'keyUp' || packet.type === 'text')
    )
      packet = {
        ...packet,
        keyboardRouteRevision: this.input.keyboardRoute.revision,
        ...(!composition && this.input.keyboardRoute.inputRevision !== undefined
          ? { keyboardInputRevision: this.input.keyboardRoute.inputRevision }
          : {}),
      }
    if (
      packet.type === 'down' ||
      packet.type === 'move' ||
      packet.type === 'up' ||
      packet.type === 'wheel'
    ) {
      this.retireVirtualCursor()
      if (!Number.isSafeInteger(this.cursorState.physicalSequence + 1)) {
        this.error(new Error('Physical pointer sequence exhausted'))
        return
      }
      const sequence = ++this.cursorState.physicalSequence
      // VCL captures PaintBox-relative integers before the Window callback.
      // Preserve this origin snapshot while the packet waits behind earlier
      // input; raw coordinates still feed physical observation and takeover.
      packet = {
        ...packet,
        pointerSequence: sequence,
        ...(this.view ? { paintBoxPoint: paintBoxPoint(this.view, packet.x, packet.y) } : {}),
      }
      if (this.shared) this.shared.pointer(packet.x, packet.y, sequence)
      else {
        const epoch = this.epoch
        // Physical observation must bypass a packet waiting on TJS/event delivery.
        void this.sendPointer(packet.x, packet.y, sequence).catch((error) => {
          if (!this.disposed && epoch === this.epoch) this.error(error)
        })
      }
    }
    if (packet.type === 'leave' || packet.type === 'cancel') this.retireVirtualCursor()
    if (this.shared) {
      this.shared.enqueue(packet)
      return
    }
    const last = this.queue.at(-1)
    if (
      last &&
      last.type === packet.type &&
      (packet.type === 'move' ||
        (packet.type === 'touchMove' && last.type === 'touchMove' && last.id === packet.id))
    )
      this.queue[this.queue.length - 1] = packet
    else {
      if (this.queue.length >= 256) {
        this.queue = []
        this.queue.push({ type: 'cancel' })
        this.error(new Error('Input queue budget exceeded'))
        return
      }
      this.queue.push(packet)
    }
    if (!this.sending) void this.flush()
  }
  private async flush(): Promise<void> {
    this.sending = true
    const epoch = this.epoch
    try {
      while (!this.disposed && this.queue.length) await this.sendPacket(this.queue.shift()!)
    } catch (error) {
      if (epoch === this.epoch) {
        this.queue = []
        if (!this.disposed) this.error(error)
      }
    } finally {
      this.sending = false
      if (!this.disposed && !this.suspended && this.queue.length) void this.flush()
    }
  }
  close(): void {
    if (this.disposed) return
    this.setSuspended(true)
    this.disposed = true
    try {
      this.resizeObserver?.disconnect()
    } catch {}
    this.resizeObserver = undefined
    this.abort.abort()
    this.queue = []
    clearTimeout(this.composeTimer)
    this.text.remove()
    this.removeVirtualMarker()
    this.pressed.clear()
    this.touches.clear()
  }
}
