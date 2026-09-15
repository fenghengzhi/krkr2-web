import type { InputPacket, InputView } from '../../engine/ports/input.ts'
import type { WindowView } from '../../engine/scene/window.ts'
import { BrowserInput, virtualKey, type BrowserInputHooks } from './browser.ts'

interface SurfaceInput {
  readonly id: number
  readonly epoch: number
  readonly input: BrowserInput
  visible: boolean
}
interface QueuedInput {
  readonly surface: SurfaceInput
  readonly packet: InputPacket
}

/** One DOM-order queue and physical keyboard for all surfaces in a Session. */
export class BrowserInputCoordinator {
  private readonly abort = new AbortController()
  private readonly surfaces = new Map<number, SurfaceInput>()
  private readonly views = new Map<number, WindowView>()
  private readonly inputs = new Map<number, InputView>()
  private readonly pressed = new Set<number>()
  private publishedKeys = ''
  private queue: QueuedInput[] = []
  private active?: SurfaceInput
  private mouseOwner?: SurfaceInput
  private sending = false
  private suspended = false
  private closed = false
  private generation = 0

  constructor(
    private readonly send: (packet: InputPacket) => Promise<void>,
    private readonly sendKeys: (keys: number[]) => Promise<void>,
    private readonly sendPointer: (x: number, y: number, windowId: number) => Promise<void> | void,
    private readonly error: (error: unknown) => void,
  ) {
    // A key may be released over a menu or another page control after canvas blur.
    // This observer only releases previously observed physical keys; script events
    // still originate from the active surface's textarea/canvas.
    window.addEventListener(
      'keyup',
      (event) => {
        if (this.closed || this.suspended) return
        if (this.pressed.delete(virtualKey(event))) this.keys()
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
          if (!(event.buttons & button)) this.pressed.delete(key)
        this.keys()
      },
      { signal: this.abort.signal, capture: true },
    )
    window.addEventListener('blur', () => this.clearPhysical(), { signal: this.abort.signal })
  }

  attach(windowId: number, epoch: number, canvas: HTMLCanvasElement): void {
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
    const current = () => !!surface && this.current(surface) && !this.suspended && surface.visible
    const hooks: BrowserInputHooks = {
      enqueue: (packet) => {
        if (current()) this.enqueue(surface, packet)
      },
      pointer: (x, y) => {
        if (!current()) return
        const generation = this.generation
        try {
          // Physical cursor reads must keep working while an earlier TJS callback
          // awaits input, storage, or a timer; they do not enter the script queue.
          void Promise.resolve(this.sendPointer(x, y, windowId)).catch((error) => {
            if (this.current(surface) && generation === this.generation) this.error(error)
          })
        } catch (error) {
          if (this.current(surface) && generation === this.generation) this.error(error)
        }
      },
      key: (key, down) => {
        if (!current() || this.active !== surface || !key) return
        if (down) this.pressed.add(key)
        else this.pressed.delete(key)
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
          shift & mask ? this.pressed.add(key) : this.pressed.delete(key)
        }
        this.keys()
      },
      activate: () => {
        if (!current()) return false
        if (this.active && this.active !== surface)
          this.enqueue(this.active, { type: 'deactivate' })
        this.active = surface
        return true
      },
      deactivate: (pageBlur) => {
        if (this.active === surface) this.active = undefined
        if (this.mouseOwner === surface) this.mouseOwner = undefined
        if (pageBlur) this.clearPhysical()
      },
      keyboard: () => current() && this.active === surface,
      mouse: (type, buttons) => {
        if (!current() || (this.mouseOwner && this.mouseOwner !== surface)) return false
        if (type === 'down') this.mouseOwner = surface
        else if (type === 'up' && !buttons) this.mouseOwner = undefined
        return true
      },
    }
    const input = new BrowserInput(
      canvas,
      this.send,
      this.sendKeys,
      async (x, y) => this.sendPointer(x, y, windowId),
      this.error,
      hooks,
    )
    surface = { id: windowId, epoch, input, visible: this.views.get(windowId)?.visible ?? true }
    this.surfaces.set(windowId, surface)
    const view = this.views.get(windowId),
      state = this.inputs.get(windowId)
    if (view) input.setWindow(view)
    if (state) input.setInput(state)
    input.setSuspended(this.suspended || !surface.visible)
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
      (epoch !== undefined && surface.epoch !== epoch)
    )
      return false
    return surface.input.focus()
  }

  setWindow(windowId: number, view: WindowView): void {
    if (this.closed) return
    this.views.set(windowId, view)
    const surface = this.surfaces.get(windowId)
    if (!surface) return
    surface.input.setWindow(view)
    if (surface.visible !== view.visible) {
      surface.visible = view.visible
      if (!view.visible) {
        this.queue = this.queue.filter((entry) => entry.surface !== surface)
        if (this.active === surface) {
          this.active = undefined
          this.enqueue(surface, { type: 'deactivate' })
        }
        if (this.mouseOwner === surface) this.mouseOwner = undefined
      }
      surface.input.setSuspended(this.suspended || !view.visible)
    }
  }

  setInput(windowId: number, view: InputView): void {
    if (this.closed) return
    this.inputs.set(windowId, view)
    this.surfaces.get(windowId)?.input.setInput(view)
  }

  setSuspended(suspended: boolean): void {
    if (this.closed || suspended === this.suspended) return
    this.suspended = suspended
    if (suspended) {
      this.generation++
      this.queue = []
      this.active = undefined
      this.mouseOwner = undefined
      this.clearPhysical()
    }
    for (const surface of this.surfaces.values())
      surface.input.setSuspended(suspended || !surface.visible)
  }

  private current(surface: SurfaceInput): boolean {
    return !this.closed && this.surfaces.get(surface.id) === surface
  }

  private remove(surface: SurfaceInput): void {
    this.surfaces.delete(surface.id)
    this.queue = this.queue.filter((entry) => entry.surface !== surface)
    if (this.active === surface) this.active = undefined
    if (this.mouseOwner === surface) this.mouseOwner = undefined
    surface.input.close()
  }

  private clearPhysical(): void {
    if (this.closed) return
    this.pressed.clear()
    this.keys()
  }

  private keys(): void {
    const keys = [...this.pressed].sort((a, b) => a - b),
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

  private enqueue(surface: SurfaceInput, packet: InputPacket): void {
    if (!this.current(surface) || this.suspended) return
    const entry = { surface, packet: { ...packet, windowId: surface.id } },
      last = this.queue.at(-1)
    if (
      last?.surface === surface &&
      last.packet.type === packet.type &&
      (packet.type === 'move' ||
        (packet.type === 'touchMove' &&
          last.packet.type === 'touchMove' &&
          last.packet.id === packet.id))
    )
      this.queue[this.queue.length - 1] = entry
    else if (this.queue.length >= 256) {
      this.queue = [...this.surfaces.values()].map((surface) => ({
        surface,
        packet: { type: 'cancel', windowId: surface.id },
      }))
      this.error(new Error('Input queue budget exceeded'))
    } else this.queue.push(entry)
    if (!this.sending) void this.flush()
  }

  private async flush(): Promise<void> {
    this.sending = true
    try {
      while (!this.closed && !this.suspended && this.queue.length) {
        const entry = this.queue.shift()!
        if (!this.current(entry.surface)) continue
        const generation = this.generation
        try {
          await this.send(entry.packet)
        } catch (error) {
          if (this.current(entry.surface) && generation === this.generation) {
            this.queue = this.queue.filter((pending) => pending.surface !== entry.surface)
            this.error(error)
          }
        }
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
    this.abort.abort()
    for (const surface of [...this.surfaces.values()]) this.remove(surface)
    this.views.clear()
    this.inputs.clear()
  }
}
