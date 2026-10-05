import type { EventClock } from '../scheduler/events.ts'

/** MainForm's 50 ms WatchTimer, not a user-input inactivity timeout. */
export class SystemMaintenance {
  private lastCompacted = 0
  private cancel?: () => void
  private closed = false
  private paused = false
  private epoch = 0
  constructor(
    private readonly clock: EventClock,
    private readonly continuous: () => boolean,
    private readonly compact: (level: 5) => void,
  ) { this.arm() }
  private arm(): void {
    if (this.closed || this.paused) return
    const epoch = ++this.epoch
    this.cancel = this.clock.schedule(() => {
      if (epoch !== this.epoch || this.closed || this.paused) return
      this.cancel = undefined
      const tick = Math.trunc(this.clock.now()) >>> 0
      if (!this.continuous() && ((tick - this.lastCompacted) >>> 0) > 4000) {
        this.lastCompacted = tick
        this.compact(5)
      }
      this.arm()
    }, 50)
  }
  close(): void {
    this.closed = true
    this.epoch++
    this.cancel?.()
    this.cancel = undefined
  }
  setPaused(paused: boolean): void {
    if (this.closed || paused === this.paused) return
    this.paused = paused
    this.epoch++
    this.cancel?.()
    this.cancel = undefined
    // Keep the native wall-clock baseline. Pause is not a new idle epoch.
    this.arm()
  }
}
