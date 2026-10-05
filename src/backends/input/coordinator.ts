import type { InputPacket, InputView } from '../../engine/ports/input.ts'
import type { WindowPopupMessage } from '../../engine/ports/window-popup.ts'
import type { WindowView } from '../../engine/scene/window.ts'
import { BrowserInput, virtualKey, type BrowserCursorState, type BrowserInputHooks } from './browser.ts'
import type { CursorScene, SelectedCursorAsset } from './cursor.ts'
import { BrowserGamepad, type BrowserGamepadSource } from './gamepad-browser.ts'
import type { GamepadSample } from './gamepad.ts'
import { MouseKeyTicker, type MouseKeyClock } from '../../engine/input/mouse-key.ts'

interface SurfaceInput {
  readonly id: number
  readonly epoch: number
  readonly input: BrowserInput
  readonly focusRoot?: HTMLElement
  visible: boolean
  focusable: boolean
  blocked: boolean
  revision: number
  resumingFromModal: boolean
}
interface QueuedInput {
  readonly surface: SurfaceInput
  readonly packet: InputPacket
  readonly settled?: (admitted: boolean) => void
}

export interface BrowserInputCoordinatorOptions {
  /** Omit for the real browser Gamepad API. false disables device sampling. */
  gamepad?: BrowserGamepadSource | false
  /** A monotonic clock boundary; default uses the browser animation clock. */
  mouseKeyClock?: MouseKeyClock
  /** Temporary page controls such as owned menu popups preserve Window focus. */
  isTransientFocus?(target: EventTarget | null): boolean
  /** Page-only window messages, independent of physical key state. */
  windowPopup?(message: WindowPopupMessage): void
  /** An owned menu overlay can lie outside its Window's DOM focus root. */
  popupWindow?(target: EventTarget | null): number | undefined
  cursor?: {
    resolve(id: number): SelectedCursorAsset | undefined
    scene(windowId: number, epoch: number): CursorScene | undefined
  }
}

/** One DOM-order queue and physical keyboard for all surfaces in a Session. */
export class BrowserInputCoordinator {
  private readonly abort = new AbortController()
  private readonly surfaces = new Map<number, SurfaceInput>()
  private readonly views = new Map<number, WindowView>()
  private readonly inputs = new Map<number, InputView>()
  private readonly pressed = new Set<number>()
  private readonly padKeys = new Set<number>()
  private readonly gamepad: BrowserGamepad
  private readonly mouseKeyTicker: MouseKeyTicker
  private pagePointer?: { x: number; y: number }
  private pointerObservation = 0
  private readonly mouseKeyObservations = new Map<number, number>()
  private gamepadEnabled = true
  private readonly physicalOwners = new Map<number, number>()
  private readonly hostKeys = new Set<number>()
  private readonly hostKeyEvents = new WeakSet<KeyboardEvent>()
  private readonly popupHideKeyEvents = new WeakSet<KeyboardEvent>()
  private readonly popupHideAdmissions = new WeakMap<KeyboardEvent, Promise<boolean>>()
  private publishedKeys = ''
  private queue: QueuedInput[] = []
  private active?: SurfaceInput
  private mouseOwner?: SurfaceInput
  private sending = false
  private sendingEntry?: QueuedInput
  private suspended = false
  private closed = false
  private generation = 0
  private focusVersion = 0
  private hostMoving = false
  private readonly cursorStates = new Map<number, BrowserCursorState>()

  constructor(
    private readonly send: (packet: InputPacket) => Promise<void>,
    private readonly sendKeys: (keys: number[]) => Promise<void>,
    private readonly sendPointer: (x: number, y: number, windowId: number, sequence?: number) => Promise<void> | void,
    private readonly error: (error: unknown) => void,
    private readonly options: BrowserInputCoordinatorOptions = {},
  ) {
    const clock = options.mouseKeyClock ?? (typeof window.requestAnimationFrame === 'function' ? {
      now: () => performance.now(),
      request: (callback: () => void) => window.requestAnimationFrame(callback),
      cancel: (handle: number) => window.cancelAnimationFrame(handle),
    } : undefined)
    this.mouseKeyTicker = new MouseKeyTicker(clock, () => this.tickMouseKeys())
    for (const type of ['mousemove', 'mousedown', 'mouseup', 'wheel'] as const)
      window.addEventListener(type, (event) => {
        if (this.closed || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
        this.pagePointer = { x: event.clientX, y: event.clientY }
        this.pointerObservation++
        if (type === 'mousedown' && !this.suspended && !this.hostMoving) {
          const source = this.popupSource(event.target)
          if (!source) this.options.windowPopup?.({ type: 'application', active: false })
        }
        if (this.hostMoving) {
          for (const [key, mask] of [[1, 1], [2, 2], [4, 4], [5, 8], [6, 16]] as const) {
            if (event.buttons & mask) this.pressed.add(key)
            else { this.pressed.delete(key); this.physicalOwners.delete(key) }
          }
          this.keys()
        }
        // A real OS pointer is global, including when a trap-key Window is
        // not the physical target. Retire its Web cursor immediately instead
        // of waiting for a later keyboard packet or a delayed Worker view.
        for (const [id, surface] of this.surfaces) {
          if (!this.views.get(id)?.useMouseKey || !surface.visible || surface.blocked || this.suspended) continue
          try { surface.input.mouseKeyObservation(id, this.pagePointer, true) }
          catch (error) { this.error(error) }
          this.mouseKeyObservations.set(id, this.pointerObservation)
        }
      }, { signal: this.abort.signal, capture: true, passive: true })
    document.addEventListener(
      'focusin',
      (event) => {
        if (this.closed) return
        this.focusVersion++
        this.observeFocus(event.target)
      },
      { signal: this.abort.signal, capture: true },
    )
    // A host control can close itself and restore game focus on keydown. Its
    // matching keyup still belongs to that host action. Record only observed
    // host keydowns: isolated game keyups retain the native trap-key contract.
    window.addEventListener(
      'keydown',
      (event) => {
        if (this.closed) return
        const key = virtualKey(event)
        if (!key) return
        if (!this.suspended && !this.hostMoving && !event.isComposing && event.keyCode !== 229 &&
            (event.altKey || key === 18 || key === 121)) {
          const source = this.popupSource(event.target)
          if (source) {
            let settle!: (admitted: boolean) => void
            this.popupHideAdmissions.set(event, new Promise<boolean>((resolve) => { settle = resolve }))
            try {
              if (this.enqueue(source, { type: 'popupHide' }, settle)) this.popupHideKeyEvents.add(event)
            } catch (error) { settle(false); this.error(error) }
          }
        }
        if (this.hostMoving) {
          this.pressed.add(key)
          if (this.active) this.physicalOwners.set(key, this.active.id)
          this.hostKeys.add(key)
          this.keys()
          return
        }
        const game =
          !this.suspended &&
          this.active?.visible &&
          !this.active.blocked &&
          this.active.input.ownsFocus(event.target)
        if (game && event.repeat && this.hostKeys.has(key)) {
          this.hostKeyEvents.add(event)
          // A held host key can repeat after focus returns to the textarea.
          // Suppress its default edit as well as its game key callback.
          event.preventDefault()
        } else if (game) this.hostKeys.delete(key)
        else this.hostKeys.add(key)
      },
      { signal: this.abort.signal, capture: true },
    )
    // A key may be released over a menu or another page control after canvas blur.
    // This observer only releases previously observed physical keys; script events
    // still originate from the active surface's textarea/canvas.
    window.addEventListener(
      'keyup',
      (event) => {
        if (this.closed) return
        const key = virtualKey(event)
        if (this.hostKeys.delete(key)) this.hostKeyEvents.add(event)
        if (this.suspended) return
        this.physicalOwners.delete(key)
        if (this.pressed.delete(key)) this.keys()
      },
      { signal: this.abort.signal, capture: true },
    )
    window.addEventListener(
      'mouseup',
      (event) => {
        if (this.closed || this.suspended) return
        for (const [key, button] of [
          [1, 1],
          [2, 2],
          [4, 4],
          [5, 8],
          [6, 16],
        ] as const)
          if (!(event.buttons & button)) {
            this.pressed.delete(key)
            this.physicalOwners.delete(key)
          }
        this.keys()
      },
      { signal: this.abort.signal, capture: true },
    )
    window.addEventListener(
      'blur',
      (event) => {
        if (this.closed || event.target !== window) return
        this.options.windowPopup?.({ type: 'application', active: false })
        this.focusVersion++
        this.setActive(undefined)
        this.clearPhysical()
      },
      { signal: this.abort.signal },
    )
    this.gamepad = new BrowserGamepad((sample) => this.observeGamepad(sample), this.error, options.gamepad,
      () => this.tickMouseKeys())
    document.addEventListener('visibilitychange', () => this.syncGamepad(), { signal: this.abort.signal })
    window.addEventListener('focus', (event) => {
      if (event.target !== window) return
      if (!this.closed && !document.hidden)
        this.options.windowPopup?.({ type: 'application', active: true })
      this.syncGamepad()
    }, { signal: this.abort.signal })
  }

  get focusRevision(): number {
    return this.focusVersion
  }
  /** A consumed menu shortcut must not overtake its own queued Form prelude. */
  popupHideAdmission(event: KeyboardEvent): Promise<boolean> | undefined {
    return this.popupHideAdmissions.get(event)
  }

  attach(
    windowId: number,
    epoch: number,
    canvas: HTMLCanvasElement,
    focusRoot?: HTMLElement,
  ): void {
    if (this.closed) return
    if (
      !Number.isSafeInteger(windowId) ||
      windowId <= 0 ||
      !Number.isSafeInteger(epoch) ||
      epoch < 0
    )
      throw new Error('Invalid input surface identity')
    const previous = this.surfaces.get(windowId)
    if (previous && previous.epoch >= epoch) return
    if (previous) this.remove(previous)
    let surface: SurfaceInput
    const current = () =>
      !!surface && this.current(surface) && !this.suspended && surface.visible && !surface.blocked
    const hooks: BrowserInputHooks = {
      enqueue: (packet) => {
        if (current()) this.enqueue(surface, packet)
      },
      pointer: (x, y, sequence) => {
        if (!current()) return
        this.mouseKeyObservations.set(windowId, this.pointerObservation)
        const generation = this.generation,
          revision = surface.revision
        try {
          // Physical cursor reads must keep working while an earlier TJS callback
          // awaits input, storage, or a timer; they do not enter the script queue.
          void Promise.resolve(this.sendPointer(x, y, windowId, sequence)).catch((error) => {
            if (
              this.current(surface) &&
              generation === this.generation &&
              revision === surface.revision
            )
              this.error(error)
          })
        } catch (error) {
          if (
            this.current(surface) &&
            generation === this.generation &&
            revision === surface.revision
          )
            this.error(error)
        }
      },
      key: (key, down) => {
        if (!current() || this.active !== surface || !key) return
        if (down) {
          this.pressed.add(key)
          this.physicalOwners.set(key, surface.id)
        } else {
          this.pressed.delete(key)
          this.physicalOwners.delete(key)
        }
      },
      modifiers: (shift, pointer) => {
        if (!current()) return
        for (const [key, mask] of [
          [16, 1],
          [18, 2],
          [17, 4],
          [1, 8],
          [2, 16],
          [4, 32],
          [5, 256],
          [6, 512],
        ] as const) {
          if (!pointer && mask >= 8) continue
          if (shift & mask) {
            this.pressed.add(key)
            this.physicalOwners.set(key, surface.id)
          } else {
            this.pressed.delete(key)
            this.physicalOwners.delete(key)
          }
        }
        this.keys()
      },
      activate: () => {
        if (!current() || !surface.focusable || surface.resumingFromModal) return false
        this.setActive(surface)
        return true
      },
      deactivate: (pageBlur, nextTarget) => {
        if (this.mouseOwner === surface) this.mouseOwner = undefined
        if (this.active !== surface) return
        if (pageBlur) {
          this.setActive(undefined)
          this.clearPhysical()
        } else this.observeFocus(nextTarget)
      },
      keyboard: (event) =>
        current() && this.active === surface && (!event || !this.hostKeyEvents.has(event)),
      popupHidePosted: (event) => this.popupHideKeyEvents.has(event),
      mouse: (type, buttons) => {
        if (!current() || (this.mouseOwner && this.mouseOwner !== surface)) return false
        if (type === 'down') this.mouseOwner = surface
        else if (type === 'up' && !buttons) this.mouseOwner = undefined
        return true
      },
    }
    let cursorState = this.cursorStates.get(windowId)
    if (!cursorState) {
      cursorState = { physicalSequence: 0, highestRevision: 0, retiredRevision: 0 }
      this.cursorStates.set(windowId, cursorState)
    }
    const input = new BrowserInput(
      canvas,
      this.send,
      this.sendKeys,
      async (x, y, sequence) => this.sendPointer(x, y, windowId, sequence),
      this.error,
      hooks,
      cursorState,
      this.options.cursor && {
        resolve: (id) => this.options.cursor!.resolve(id),
        scene: () => this.current(surface) ? this.options.cursor!.scene(windowId, epoch) : undefined,
      },
    )
    surface = {
      id: windowId,
      epoch,
      input,
      focusRoot,
      visible: this.views.get(windowId)?.visible ?? true,
      focusable: this.views.get(windowId)?.focusable ?? true,
      blocked: !!this.views.get(windowId)?.blocked,
      revision: 0,
      resumingFromModal: false,
    }
    this.surfaces.set(windowId, surface)
    const view = this.views.get(windowId),
      state = this.inputs.get(windowId)
    if (view) input.setWindow(view)
    if (state) input.setInput(state, windowId)
    input.setSuspended(this.suspended || !surface.visible || surface.blocked)
    input.setHostMoving(this.hostMoving)
  }

  /** An asset event can arrive after the input snapshot that references it. */
  refreshCursors(): void {
    if (this.closed) return
    for (const surface of this.surfaces.values()) surface.input.refreshCursor()
  }
  setHostMoving(moving: boolean): void {
    if (this.closed || this.hostMoving === moving) return
    this.hostMoving = moving
    if (moving) {
      this.mouseOwner = undefined
      // Already admitted VM work retains its native lifetime. DOM work still
      // waiting for admission now belongs to the host's movement loop.
      this.discardQueued((entry) => entry.packet.type !== 'activate' && entry.packet.type !== 'deactivate')
    }
    for (const surface of this.surfaces.values()) surface.input.setHostMoving(moving)
    this.syncMouseKeyTicker()
  }

  detach(windowId: number, epoch: number): void {
    const surface = this.surfaces.get(windowId)
    if (!surface || surface.epoch !== epoch) return
    this.remove(surface)
    this.views.delete(windowId)
    this.inputs.delete(windowId)
  }

  focus(windowId: number, epoch?: number): boolean {
    const surface = this.surfaces.get(windowId)
    if (
      this.closed ||
      this.suspended ||
      !surface?.visible ||
      !surface.focusable ||
      surface.blocked ||
      (epoch !== undefined && surface.epoch !== epoch)
    )
      return false
    if (
      document.activeElement &&
      surface.focusRoot?.contains(document.activeElement) &&
      !surface.input.ownsFocus(document.activeElement)
    ) {
      this.setActive(surface)
      return true
    }
    return surface.input.focus()
  }

  /** DOM activation is authoritative for immediate browser shortcuts; an
   * earlier script callback may still be delaying the Worker's roster reply. */
  isActive(windowId: number, epoch?: number): boolean {
    const surface = this.active
    return !!(
      surface &&
      this.current(surface) &&
      !this.suspended &&
      surface.visible &&
      surface.focusable &&
      !surface.blocked &&
      surface.id === windowId &&
      (epoch === undefined || surface.epoch === epoch)
    )
  }

  setWindow(windowId: number, view: WindowView): void {
    if (this.closed) return
    const previous = this.views.get(windowId),
      blocked = !!view.blocked,
      blockingChanged = !!previous?.blocked !== blocked
    this.views.set(windowId, { ...view })
    // An activation awaiting a Worker reply or a replacement canvas must not
    // regain focus after its modal access was revoked, even if no DOM blur ran.
    if (blockingChanged) this.focusVersion++
    const surface = this.surfaces.get(windowId)
    if (!surface) return
    const resumingFromModal = surface.blocked && !blocked
    surface.input.setWindow(view)
    surface.focusable = view.focusable
    if (surface.blocked !== blocked) {
      surface.blocked = blocked
      surface.revision++
      if (blocked) {
        this.discardQueued((entry) => entry.surface === surface)
        if (this.active === surface) this.setActive(undefined)
        if (this.mouseOwner === surface) this.mouseOwner = undefined
        // Applying inert may already have blurred the DOM before this roster
        // arrives here. Physical ownership survives that blur until released.
        for (const [key, owner] of this.physicalOwners)
          if (owner === surface.id) {
            this.physicalOwners.delete(key)
            this.pressed.delete(key)
          }
        this.keys()
      }
    }
    if (!view.focusable && this.active === surface) this.setActive(undefined)
    if (surface.visible !== view.visible) {
      surface.visible = view.visible
      if (!view.visible) {
        this.discardQueued((entry) => entry.surface === surface)
        if (this.active === surface) {
          this.setActive(undefined)
        }
        if (this.mouseOwner === surface) this.mouseOwner = undefined
      }
    }
    surface.resumingFromModal = resumingFromModal
    try {
      surface.input.setSuspended(this.suspended || !view.visible || blocked)
    } finally {
      surface.resumingFromModal = false
    }
    this.syncGamepad()
  }

  setInput(windowId: number, view: InputView): void {
    if (this.closed) return
    this.inputs.set(windowId, view)
    this.surfaces.get(windowId)?.input.setInput(view, windowId)
    if (view.gamepad) {
      this.gamepadEnabled = view.gamepad.enabled
      this.gamepad.setRepeat(view.gamepad.delay, view.gamepad.interval)
    }
    this.syncGamepad()
  }

  setSuspended(suspended: boolean): void {
    if (this.closed || suspended === this.suspended) return
    this.suspended = suspended
    this.gamepad.setSuspended(suspended)
    if (suspended) {
      this.generation++
      this.discardQueued(() => true)
      this.active = undefined
      this.mouseOwner = undefined
      this.clearPhysical()
    }
    for (const surface of this.surfaces.values())
      surface.input.setSuspended(suspended || !surface.visible || surface.blocked)
    this.syncGamepad()
  }

  private current(surface: SurfaceInput): boolean {
    return !this.closed && this.surfaces.get(surface.id) === surface
  }

  private observeFocus(target: EventTarget | null): void {
    if (this.closed || this.suspended) return
    if (this.options.isTransientFocus?.(target)) {
      this.gamepad.setActive(false)
      this.mouseKeyTicker.setActive(false)
      return
    }
    const surface = [...this.surfaces.values()].find(
      (surface) =>
        surface.visible &&
        surface.focusable &&
        !surface.blocked &&
        (surface.input.ownsFocus(target) ||
          (!!target && surface.focusRoot?.contains(target as Node))),
    )
    this.setActive(surface)
  }

  private popupSource(target: EventTarget | null): SurfaceInput | undefined {
    const menuWindow = this.options.popupWindow?.(target),
      node = !!target && (typeof Node === 'undefined' || target instanceof Node)
    return [...this.surfaces.values()].find((surface) => this.current(surface) &&
      surface.visible && !surface.blocked && (surface.id === menuWindow || surface.input.ownsFocus(target) ||
        (node && !!surface.focusRoot?.contains(target as Node))))
  }

  private setActive(surface: SurfaceInput | undefined): void {
    const previous = this.active
    if (surface === previous) { this.syncGamepad(); return }
    // Release against the old Window before switching routes. Like native
    // suspended polling, a held key must become neutral before readmission.
    this.gamepad.setActive(false)
    this.active = surface
    if (previous) {
      if (this.mouseOwner === previous) this.mouseOwner = undefined
      previous.input.setWindowActive(false)
      this.enqueue(previous, { type: 'deactivate' })
    }
    if (surface) {
      surface.input.setWindowActive(true)
      this.enqueue(surface, { type: 'activate' })
    }
    this.syncGamepad()
  }

  private syncGamepad(): void {
    const surface = this.active
    this.gamepad.setActive(!!(this.gamepadEnabled && surface && this.current(surface) && !this.suspended &&
      surface.visible && surface.focusable && !surface.blocked && !document.hidden &&
      (typeof document.hasFocus !== 'function' || document.hasFocus()) &&
      surface.input.ownsFocus(document.activeElement)))
    this.syncMouseKeyTicker()
  }
  private syncMouseKeyTicker(): void {
    // Native TickBeat moves the cursor before polling DirectInput. When the
    // Gamepad driver owns that 50 ms beat, its beforeSample hook supplies the
    // tick; keyboard-only configurations retain a separate clock owner.
    this.mouseKeyTicker.setActive(!this.gamepad.sampling && !!this.active && this.mouseKeyEligible(this.active))
  }
  private tickMouseKeys(): void {
    const surface = this.active
    if (!surface || !this.mouseKeyEligible(surface)) return
    try { this.enqueue(surface, { type: 'mouseKeyTick', mouseKeyKeys: [...new Set([...this.pressed, ...this.padKeys])] }) }
    catch (error) { this.error(error) }
  }
  private mouseKeyEligible(surface: SurfaceInput): boolean {
    return this.current(surface) && !this.suspended && !this.hostMoving && surface.visible && surface.focusable &&
      !surface.blocked && !!this.views.get(surface.id)?.useMouseKey && !document.hidden &&
      (typeof document.hasFocus !== 'function' || document.hasFocus()) &&
      surface.input.ownsFocus(document.activeElement)
  }
  private observeGamepad(sample: GamepadSample): void {
    if (this.closed) return
    this.padKeys.clear()
    for (const key of sample.keys) this.padKeys.add(key)
    // Physical state bypasses a blocked script callback just like keyboard
    // observation; the ordered script events still use the common queue.
    this.keys()
    const surface = this.active
    if (!surface || !this.current(surface) || this.suspended) return
    const route = this.inputs.get(surface.id)?.keyboardRoute
    let shift = 0
    for (const [key, flag] of [[16, 1], [18, 2], [17, 4], [1, 8], [2, 16], [4, 32], [5, 256], [6, 512]])
      if (this.pressed.has(key!)) shift |= flag!
    for (const event of sample.events)
      this.enqueue(surface, { type: event.type, key: event.key, shift: shift | (event.repeat ? 128 : 0),
        ...(route ? { keyboardRouteRevision: route.revision,
          ...(route.inputRevision !== undefined ? { keyboardInputRevision: route.inputRevision } : {}) } : {}) })
    this.syncMouseKeyTicker()
  }

  private remove(surface: SurfaceInput): void {
    if (this.active === surface) this.gamepad.setActive(false)
    this.surfaces.delete(surface.id)
    this.mouseKeyObservations.delete(surface.id)
    this.discardQueued((entry) => entry.surface === surface)
    if (this.active === surface) this.active = undefined
    if (this.mouseOwner === surface) this.mouseOwner = undefined
    surface.input.close()
    this.syncGamepad()
  }

  private clearPhysical(): void {
    if (this.closed) return
    this.hostKeys.clear()
    this.pressed.clear()
    this.padKeys.clear()
    this.physicalOwners.clear()
    this.keys()
  }

  private keys(): void {
    const keys = [...new Set([...this.pressed, ...this.padKeys])].sort((a, b) => a - b),
      signature = keys.join(',')
    if (signature === this.publishedKeys) return
    this.publishedKeys = signature
    const generation = this.generation
    try {
      void this.sendKeys(keys).catch((error) => {
        if (!this.closed && generation === this.generation) this.error(error)
      })
    } catch (error) {
      if (!this.closed && generation === this.generation) this.error(error)
    }
  }

  private discardQueued(matches: (entry: QueuedInput) => boolean): void {
    const discarded = this.queue.filter(matches)
    this.queue = this.queue.filter((entry) => !matches(entry))
    for (const entry of discarded) entry.settled?.(false)
    if (this.sendingEntry && matches(this.sendingEntry)) this.sendingEntry.settled?.(false)
  }
  private enqueue(surface: SurfaceInput, packet: InputPacket, settled?: (admitted: boolean) => void): boolean {
    if (!this.current(surface) || this.suspended || surface.blocked ||
        (this.hostMoving && packet.type !== 'activate' && packet.type !== 'deactivate')) {
      settled?.(false)
      return false
    }
    if (packet.type === 'keyDown' || packet.type === 'keyUp' || packet.type === 'text' || packet.type === 'mouseKeyTick') {
      const targetId = packet.type === 'mouseKeyTick' ? surface.id :
        this.inputs.get(surface.id)?.keyboardRoute?.windowId ?? surface.id,
        target = this.surfaces.get(targetId)
      if (target && this.views.get(targetId)?.useMouseKey) {
        const observation = target.input.mouseKeyObservation(targetId, this.pagePointer,
          this.mouseKeyObservations.get(targetId) !== this.pointerObservation)
        this.mouseKeyObservations.set(targetId, this.pointerObservation)
        if (observation) packet = { ...packet, mouseKeyObservation: observation }
      }
    }
    const entry: QueuedInput = { surface, packet: { ...packet, windowId: surface.id }, settled },
      last = this.queue.at(-1)
    if (
      last?.surface === surface &&
      last.packet.type === packet.type &&
      (packet.type === 'move' || packet.type === 'mouseKeyTick' ||
        (packet.type === 'touchMove' &&
          last.packet.type === 'touchMove' &&
          last.packet.id === packet.id))
    ) {
      last.settled?.(false)
      this.queue[this.queue.length - 1] = entry
    } else if (this.queue.length >= 256) {
      this.discardQueued(() => true)
      settled?.(false)
      this.queue = [...this.surfaces.values()].map((surface) => ({
        surface,
        packet: { type: 'cancel', windowId: surface.id },
      }))
      this.error(new Error('Input queue budget exceeded'))
      if (!this.sending) void this.flush()
      return false
    } else this.queue.push(entry)
    if (!this.sending) void this.flush()
    return true
  }

  private async flush(): Promise<void> {
    this.sending = true
    try {
      while (!this.closed && !this.suspended && this.queue.length) {
        const entry = this.queue.shift()!
        if (!this.current(entry.surface) || entry.surface.blocked) { entry.settled?.(false); continue }
        this.sendingEntry = entry
        const generation = this.generation,
          revision = entry.surface.revision
        try {
          await this.send(entry.packet)
          entry.settled?.(true)
        } catch (error) {
          entry.settled?.(false)
          if (
            this.current(entry.surface) &&
            generation === this.generation &&
            revision === entry.surface.revision
          ) {
            this.discardQueued((pending) => pending.surface === entry.surface)
            this.error(error)
          }
        } finally { if (this.sendingEntry === entry) this.sendingEntry = undefined }
      }
    } finally {
      this.sending = false
      if (!this.closed && !this.suspended && this.queue.length) void this.flush()
    }
  }

  close(): void {
    if (this.closed) return
    this.setSuspended(true)
    this.closed = true
    this.gamepad.close()
    this.mouseKeyTicker.close()
    this.abort.abort()
    for (const surface of [...this.surfaces.values()]) this.remove(surface)
    this.views.clear()
    this.inputs.clear()
    this.cursorStates.clear()
    this.mouseKeyObservations.clear()
  }
}
