/** Fixed KRKR2 2.32stable WindowFormUnit.cpp (dec49af9), InternalKeyDown,
 * InternalKeyUp and GenerateMouseEvent. Coordinates and actual event delivery
 * belong to the existing input adapter; this state machine never dispatches DOM
 * events or changes the physical keyboard snapshot. */
export type MouseKeyAction =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'down' | 'up' | 'click'; button: 0 | 1; position: 'current' | 'down' | 'move' }
export interface MouseKeyResult { consumed: boolean; actions: MouseKeyAction[] }

const directions = new Map<number, number>([
  [37, 0], [39, 1], [38, 2], [40, 3],
  [0x1b5, 0], [0x1b7, 1], [0x1b6, 2], [0x1b8, 3],
])
const leftButtons = new Set([13, 32, 0x1c0])
const rightButtons = new Set([27, 0x1c1])

export class MouseKeyState {
  private enabled = false
  private x = 0
  private y = 0
  private lastTick = 0
  private leftPushed = false
  private rightPushed = false

  /** Assignment is observable even when the value is unchanged. Native true
   * resets the emulated button flags and tick, but preserves acceleration. */
  configure(enabled: boolean, now: number): MouseKeyAction[] {
    this.enabled = enabled
    if (enabled) {
      this.leftPushed = this.rightPushed = false
      this.lastTick = now
      return []
    }
    const actions: MouseKeyAction[] = []
    if (this.leftPushed) actions.push({ type: 'up', button: 0, position: 'move' })
    if (this.rightPushed) actions.push({ type: 'up', button: 1, position: 'move' })
    this.leftPushed = this.rightPushed = false
    return actions
  }
  key(down: boolean, key: number, now: number, held: ReadonlySet<number>, inside: boolean): MouseKeyResult {
    if (!this.enabled) return { consumed: false, actions: [] }
    const button = leftButtons.has(key) ? 0 : rightButtons.has(key) ? 1 : undefined
    if (button !== undefined) {
      const actions: MouseKeyAction[] = []
      if (inside) {
        if (down) {
          if (button === 0) this.leftPushed = true
          else this.rightPushed = true
          actions.push({ type: 'down', button, position: 'current' })
        } else {
          // Native does not require a prior down or suppress repeated downs.
          // Click is posted first, using the last down's captured coordinates.
          if (button === 0) {
            actions.push({ type: 'click', button, position: 'down' })
            this.leftPushed = false
          } else this.rightPushed = false
          actions.push({ type: 'up', button, position: 'current' })
        }
      }
      return { consumed: true, actions }
    }
    const direction = directions.get(key)
    if (down && direction !== undefined) {
      const actions = this.x === 0 && this.y === 0 ? this.generate(now, held, direction) : []
      if (actions.length) this.lastTick = now + 100
      return { consumed: true, actions }
    }
    // Direction keyup remains an ordinary native key event.
    return { consumed: false, actions: [] }
  }
  text(value: string): boolean {
    return this.enabled && (value === '\r' || value === '\u001b' || value === ' ')
  }
  tick(now: number, held: ReadonlySet<number>): MouseKeyAction[] {
    return this.enabled ? this.generate(now, held) : []
  }
  private generate(now: number, held: ReadonlySet<number>, forced?: number): MouseKeyAction[] {
    if (forced === undefined && now - 45 < this.lastTick) return []
    const left = forced === 0 || held.has(37) || held.has(0x1b5),
      right = forced === 1 || held.has(39) || held.has(0x1b7),
      up = forced === 2 || held.has(38) || held.has(0x1b6),
      down = forced === 3 || held.has(40) || held.has(0x1b8),
      moving = left || right || up || down
    if (!moving) this.x = this.y = 0
    if (!held.has(16)) {
      if ((!right && left && this.x > 0) || (!left && right && this.x < 0)) this.x = 0
      if ((!down && up && this.y > 0) || (!up && down && this.y < 0)) this.y = 0
    } else {
      if (left) this.x = -40
      if (right) this.x = 40
      if (up) this.y = -40
      if (down) this.y = 40
    }
    if (moving) {
      if (left && this.x > -30) this.x = this.x ? this.x - 2 : -2
      if (right && this.x < 30) this.x = this.x ? this.x + 2 : 2
      if (!left && !right) this.x += this.x > 0 ? -1 : this.x < 0 ? 1 : 0
      if (up && this.y > -30) this.y = this.y ? this.y - 2 : -2
      if (down && this.y < 30) this.y = this.y ? this.y + 2 : 2
      if (!up && !down) this.y += this.y > 0 ? -1 : this.y < 0 ? 1 : 0
    }
    this.lastTick = now
    return moving ? [{ type: 'move', dx: this.x >> 1, dy: this.y >> 1 }] : []
  }
  /** A destroyed surface/session cannot carry button obligations into a new
   * input lifetime. Focus/menu suspension alone does not call this reset. */
  reset(): void {
    this.enabled = false
    this.x = this.y = this.lastTick = 0
    this.leftPushed = this.rightPushed = false
  }
}

export interface MouseKeyClock {
  now(): number
  request(callback: () => void): number
  cancel(handle: number): void
}

/** A 50 ms native TickBeat cadence, with no catch-up replay after a delayed
 * browser frame. The callback uses the same queue as observed DOM input. */
export class MouseKeyTicker {
  private handle?: number
  private generation = 0
  private active = false
  private closed = false
  private previous = 0
  constructor(private readonly clock: MouseKeyClock | undefined, private readonly tick: (now: number) => void) {}
  now(): number { return this.clock?.now() ?? 0 }
  setActive(active: boolean): void {
    if (this.closed || active === this.active) return
    this.active = active
    if (!active) this.cancel()
    else {
      this.previous = this.now()
      this.schedule()
    }
  }
  private schedule(): void {
    if (!this.clock || this.closed || !this.active || this.handle !== undefined) return
    const generation = this.generation
    this.handle = this.clock.request(() => {
      if (generation !== this.generation || this.closed || !this.active) return
      this.handle = undefined
      const now = this.now()
      if (now - this.previous >= 50) { this.previous = now; this.tick(now) }
      this.schedule()
    })
  }
  private cancel(): void {
    this.generation++
    if (this.handle !== undefined) this.clock?.cancel(this.handle)
    this.handle = undefined
  }
  close(): void { this.closed = true; this.cancel() }
}
