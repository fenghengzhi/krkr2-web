import type { InputPacket, InputView } from '../../engine/ports/input.ts'
import type { WindowView } from '../../engine/scene/window.ts'
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
  pointer(x: number, y: number): void
  modifiers(shift: number, pointer: boolean): void
  key(key: number, down: boolean): void
  activate(): boolean
  deactivate(pageBlur: boolean): void
  keyboard(): boolean
  mouse(type: 'down' | 'move' | 'up', buttons: number): boolean
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
  private composeTimer?: ReturnType<typeof setTimeout>
  private mouseButtons = 0
  private pressed = new Set<number>()
  private touches = new Map<number, { x: number; y: number; startX: number; startY: number }>()
  private mouseTouch: number | undefined
  private clicks = new Map<number, number>()
  private view?: WindowView
  private input?: InputView
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sendPacket: (packet: InputPacket) => Promise<void>,
    private readonly sendKeys: (keys: number[]) => Promise<void>,
    private readonly sendPointer: (x: number, y: number) => Promise<void>,
    private readonly error: (error: unknown) => void,
    private readonly shared?: BrowserInputHooks,
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
    this.text.addEventListener('blur', () => this.deactivate(), options)
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
        this.composing = true
        this.composed = ''
      },
      options,
    )
    this.text.addEventListener(
      'compositionend',
      (event) => {
        const commit = this.keyboard() && this.composing
        this.composing = false
        this.composed = event.data
        this.text.value = ''
        if (commit && event.data) this.push({ type: 'text', text: event.data })
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
        if (this.composing || (event as InputEvent).isComposing) return
        const value = this.text.value
        this.text.value = ''
        if (value && value !== this.composed) this.push({ type: 'text', text: value })
        this.composed = ''
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
  setInput(input: InputView): void {
    this.input = input
    this.appearance()
  }
  setSuspended(suspended: boolean): void {
    if (this.disposed || this.suspended === suspended) return
    this.suspended = suspended
    if (suspended) {
      this.epoch++
      this.queue = []
      this.active = false
      this.composing = false
      this.composed = ''
      clearTimeout(this.composeTimer)
      this.text.value = ''
      this.mouseButtons = 0
      this.mouseTouch = undefined
      this.clicks.clear()
      this.touches.clear()
      this.pressed.clear()
      this.releasePointerCaptures()
      this.keys()
    } else if (document.activeElement === this.text) this.activate()
  }
  private appearance(): void {
    if (this.disposed) return
    this.canvas.style.cursor = this.view?.mouseCursorState
      ? 'none'
      : (cursors[this.input?.cursor ?? 0] ?? 'default')
    this.canvas.title = this.input?.hint ?? ''
    const x = this.input?.attentionX ?? 0,
      y = this.input?.attentionY ?? 0
    this.text.style.left = `${this.canvas.offsetLeft + (x * this.canvas.clientWidth) / (this.view?.width ?? 800)}px`
    this.text.style.top = `${this.canvas.offsetTop + (y * this.canvas.clientHeight) / (this.view?.height ?? 600)}px`
    this.text.inputMode = this.input?.imeMode === 0 ? 'none' : 'text'
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
    if (!this.keyboard()) return
    if (this.composing || event.isComposing || event.keyCode === 229) return
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
    this.push({ type: down ? 'keyDown' : 'keyUp', key, shift })
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
  private keyboard(): boolean {
    return !this.suspended && !this.disposed && (this.shared?.keyboard() ?? true)
  }
  private activate(): void {
    if (this.suspended || this.disposed || this.active) return
    if (this.shared && !this.shared.activate()) return
    this.active = true
    this.push({ type: 'activate' })
  }
  private deactivate(pageBlur = false): void {
    this.shared?.deactivate(pageBlur)
    if (!this.active && !this.mouseButtons && !this.touches.size && !this.captured.size) return
    this.active = false
    this.mouseButtons = 0
    this.clicks.clear()
    this.touches.clear()
    this.releasePointerCaptures()
    this.mouseTouch = undefined
    this.pressed.clear()
    this.composing = false
    this.composed = ''
    this.text.value = ''
    clearTimeout(this.composeTimer)
    this.keys()
    this.push({ type: 'deactivate' })
  }
  private push(packet: InputPacket): void {
    if (this.disposed || this.suspended) return
    if (
      packet.type === 'down' ||
      packet.type === 'move' ||
      packet.type === 'up' ||
      packet.type === 'wheel'
    ) {
      if (this.shared) this.shared.pointer(packet.x, packet.y)
      else {
        const epoch = this.epoch
        // Physical observation must bypass a packet waiting on TJS/event delivery.
        void this.sendPointer(packet.x, packet.y).catch((error) => {
          if (!this.disposed && epoch === this.epoch) this.error(error)
        })
      }
    }
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
    this.pressed.clear()
    this.touches.clear()
  }
}
