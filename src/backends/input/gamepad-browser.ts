import { GamepadState, type GamepadSample, type GamepadSnapshot } from './gamepad.ts'

/** A device source and clock, independent of focus or script delivery. Tests
 * substitute this boundary; the player uses navigator.getGamepads directly. */
export interface BrowserGamepadSource {
  read(): readonly (GamepadSnapshot | null | undefined)[]
  now(): number
  request(callback: () => void): number
  cancel(handle: number): void
}
function browserSource(): BrowserGamepadSource | undefined {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function' ||
      typeof window.requestAnimationFrame !== 'function') return undefined
  return {
    read: () => navigator.getGamepads(),
    now: () => performance.now(),
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
  }
}

/** One sampler per Session, not per canvas. RAF stops with the page; explicit
 * suspension also cancels it so a late callback cannot resurrect old input. */
export class BrowserGamepad {
  private readonly state = new GamepadState()
  private readonly source: BrowserGamepadSource | undefined
  private handle?: number
  private generation = 0
  private active = false
  private suspended = false
  private closed = false
  private failed = false
  private lastSample = -Infinity

  constructor(
    private readonly observe: (sample: GamepadSample) => void,
    private readonly error: (error: unknown) => void,
    source?: BrowserGamepadSource | false,
  ) {
    this.source = source === false ? undefined : source ?? browserSource()
    this.schedule()
  }

  setActive(active: boolean): void {
    if (this.closed || active === this.active) return
    this.active = active
    if (!active) {
      this.cancel()
      this.release()
    } else if (!this.suspended && !this.failed) {
      this.sample()
      this.schedule()
    }
  }
  setRepeat(delay: number, interval: number): void {
    this.state.setRepeat(delay, interval)
  }
  setSuspended(suspended: boolean): void {
    if (this.closed || suspended === this.suspended) return
    this.suspended = suspended
    if (suspended) {
      this.cancel()
      this.release()
    } else {
      this.lastSample = -Infinity
      this.schedule()
    }
  }
  private release(): void {
    if (this.source) this.observe(this.state.suspend(this.source.now()))
    this.lastSample = -Infinity
  }
  private sample(): void {
    if (!this.source || this.closed || this.suspended || this.failed) return
    try {
      const now = this.source.now()
      this.lastSample = now
      this.observe(this.state.sample(this.source.read(), now, this.active))
    } catch (error) {
      // API denial/disconnection errors retire admitted keys once. Keyboard
      // and pointer input remain independent, and no throwing poll repeats.
      this.failed = true
      this.cancel()
      this.release()
      this.error(error)
    }
  }
  private schedule(): void {
    if (!this.source || !this.active || this.closed || this.suspended || this.failed || this.handle !== undefined) return
    const generation = this.generation
    this.handle = this.source.request(() => {
      if (generation !== this.generation) return
      this.handle = undefined
      if (!this.active || this.closed || this.suspended || this.failed) return
      // Original Window polling is 50 ms. A delayed frame reads only current
      // input; it never fabricates device transitions for missed samples.
      if (this.source!.now() - this.lastSample >= 50) this.sample()
      this.schedule()
    })
  }
  private cancel(): void {
    this.generation++
    if (this.handle !== undefined) this.source?.cancel(this.handle)
    this.handle = undefined
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.cancel()
    this.release()
    this.state.reset()
  }
}
