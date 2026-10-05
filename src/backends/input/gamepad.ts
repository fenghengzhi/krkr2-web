/** Structural subset of the real Gamepad API, kept independent of DOM types. */
export interface GamepadSnapshot {
  readonly index: number
  readonly id: string
  readonly connected: boolean
  readonly mapping: string
  readonly axes: readonly number[]
  readonly buttons: readonly { readonly pressed: boolean; readonly value?: number }[]
}
export interface GamepadKeyEvent {
  type: 'keyDown' | 'keyUp'
  key: number
  repeat: boolean
}
export interface GamepadSample {
  /** Admitted held keys. VK_PADANY is a query aggregate, never an event/key. */
  keys: number[]
  /** Device state before the initial/re-activation neutral gate. */
  rawKeys: number[]
  /** Native dispatch order: releases, new presses, then group repeats. */
  events: GamepadKeyEvent[]
  selected: { index: number; id: string } | null
}

// Fixed 2.32stable DInputMgn.cpp, commit
// dec49af97e174d31059c3ccd7efc700ba3c6b788: 110–142, 175–238, 428–724.
// Bit order is left/right/up/down, unlike numerical virtual-key order.
const virtualKeys = [0x1b5, 0x1b7, 0x1b6, 0x1b8,
  0x1c0, 0x1c1, 0x1c2, 0x1c3, 0x1c4, 0x1c5, 0x1c6, 0x1c7, 0x1c8, 0x1c9] as const
const allKeys = (1 << virtualKeys.length) - 1
const crossKeys = 0x0f
const triggerKeys = allKeys & ~crossKeys
const axisUpperThreshold = 31128 // trunc(32767 * 95 / 100)
const axisLowerThreshold = -31129 // trunc(-32768 * 95 / 100)

function keys(mask: number): number[] {
  return virtualKeys.filter((_, index) => (mask & (1 << index)) !== 0)
}
function axis(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  const normalized = Math.max(-1, Math.min(1, value))
  return Math.trunc(normalized * (normalized < 0 ? 32768 : 32767))
}
function deviceState(pad: GamepadSnapshot): number {
  let mask = 0
  const x = axis(pad.axes[0]), y = axis(pad.axes[1])
  if (x >= axisUpperThreshold) mask |= 1 << 1
  else if (x <= axisLowerThreshold) mask |= 1 << 0
  if (y >= axisUpperThreshold) mask |= 1 << 3
  else if (y <= axisLowerThreshold) mask |= 1 << 2
  for (let button = 0; button < 10; button++)
    if (pad.buttons[button]?.pressed) mask |= 1 << (button + 4)
  // Web mapping, not a claim about DirectInput device enumeration or POV:
  // standard D-pad buttons supplement the first analog stick. Unmapped pads
  // use their exposed first two axes and first ten button indices only.
  if (pad.mapping === 'standard') {
    if (pad.buttons[14]?.pressed) mask |= 1 << 0
    if (pad.buttons[15]?.pressed) mask |= 1 << 1
    if (pad.buttons[12]?.pressed) mask |= 1 << 2
    if (pad.buttons[13]?.pressed) mask |= 1 << 3
  }
  return mask
}
function available(pad: GamepadSnapshot | null | undefined): pad is GamepadSnapshot {
  return !!pad && pad.connected && Number.isSafeInteger(pad.index) && pad.index >= 0 &&
    typeof pad.id === 'string' && typeof pad.mapping === 'string' &&
    Array.isArray(pad.axes) && Array.isArray(pad.buttons)
}
class Repeater {
  private pressedAt: number | undefined
  private previousCount = 0
  down(now: number): void { this.pressedAt = now; this.previousCount = 0 }
  up(): void { this.pressedAt = undefined; this.previousCount = 0 }
  take(now: number, delay: number, interval: number): number {
    if (this.pressedAt === undefined || delay < 0 || interval <= 0) return 0
    const elapsed = now - this.pressedAt - delay
    if (elapsed < 0) return 0
    const count = Math.floor(elapsed / interval), difference = count - this.previousCount
    this.previousCount = count
    // Native discards repeats beyond ten rather than deferring the excess.
    // A live settings change can decrease count; never reproduce its negative
    // repeat loop. The next sample uses the new count as its baseline.
    return Math.max(0, Math.min(10, difference))
  }
}

/** One selected physical pad, sampled by the browser driver every 50 ms.
 * Native input sets a 50% DirectInput deadzone before testing its resulting
 * signed axis values at 95%. Browser axes are already normalized by the UA;
 * this explicit Web mapping uses those values and the same integer thresholds,
 * without inventing the unavailable driver's calibration/deadzone transform.
 * Standard mapping follows https://www.w3.org/TR/gamepad/#remapping.
 */
export class GamepadState {
  private selected: { index: number; id: string; mapping: string } | null = null
  private admitted = 0
  private admissionMask = 0
  private lastTrigger = 0
  private readonly crossRepeater = new Repeater()
  private readonly triggerRepeater = new Repeater()
  private lastTime = 0
  private delay = 500
  private interval = 30

  setRepeat(delay: number, interval: number): void {
    for (const value of [delay, interval])
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
        throw new Error('Gamepad repeat settings must be signed 32-bit integers')
    this.delay = delay
    this.interval = interval
  }
  private time(now: number): number {
    if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER)
      throw new Error('Invalid gamepad sample time')
    // performance.now is monotonic. A backwards injected clock freezes repeat
    // elapsed time until it catches up, while releases can still be processed.
    this.lastTime = Math.max(this.lastTime, Math.trunc(now))
    return this.lastTime
  }
  sample(pads: readonly (GamepadSnapshot | null | undefined)[], now: number, active: boolean): GamepadSample {
    const time = this.time(now)
    // Keep the chosen device while it is connected. The initial choice is the
    // lowest API index, an explicit Web counterpart of first-device selection.
    let pad = this.selected && pads.find((candidate) => available(candidate) &&
      candidate.index === this.selected!.index && candidate.id === this.selected!.id &&
      candidate.mapping === this.selected!.mapping)
    if (!pad) {
      for (const candidate of pads)
        if (available(candidate) && (!pad || candidate.index < pad.index)) pad = candidate
      const changed = !!this.selected || !!pad
      this.selected = pad ? { index: pad.index, id: pad.id, mapping: pad.mapping } : null
      if (changed) {
        this.admissionMask = 0
        this.crossRepeater.up()
        this.triggerRepeater.up()
        this.lastTrigger = 0
      }
    }
    const raw = pad ? deviceState(pad) : 0
    if (active) this.admissionMask |= ~raw & allKeys
    else this.admissionMask = 0
    return this.update(active ? raw & this.admissionMask : 0, raw, time)
  }
  suspend(now: number): GamepadSample {
    const time = this.time(now)
    this.admissionMask = 0
    return this.update(0, 0, time)
  }
  /** Retire state without dispatch. The owner releases keys before reset;
   * configured repeat settings belong to the Session and remain unchanged. */
  reset(): void {
    this.selected = null
    this.admitted = this.admissionMask = this.lastTrigger = 0
    this.crossRepeater.up()
    this.triggerRepeater.up()
    this.lastTime = 0
  }
  private update(next: number, raw: number, now: number): GamepadSample {
    const down = next & ~this.admitted, up = this.admitted & ~next
    if (!(this.admitted & crossKeys) && (next & crossKeys)) this.crossRepeater.down(now)
    if (!(next & crossKeys)) this.crossRepeater.up()
    if (down & triggerKeys) {
      this.triggerRepeater.down(now)
      this.lastTrigger = down & triggerKeys
    } else if (up & triggerKeys) this.triggerRepeater.up()
    const events: GamepadKeyEvent[] = [
      ...keys(up).map((key) => ({ type: 'keyUp' as const, key, repeat: false })),
      ...keys(down).map((key) => ({ type: 'keyDown' as const, key, repeat: false })),
    ]
    const crossCount = this.crossRepeater.take(now, this.delay, this.interval),
      triggerCount = this.triggerRepeater.take(now, this.delay, this.interval)
    for (let count = 0; count < crossCount; count++)
      for (const key of keys(next & crossKeys)) events.push({ type: 'keyDown', key, repeat: true })
    const trigger = keys(this.lastTrigger)[0]
    if (trigger !== undefined)
      for (let count = 0; count < triggerCount; count++) events.push({ type: 'keyDown', key: trigger, repeat: true })
    this.admitted = next
    return { keys: keys(next), rawKeys: keys(raw), events,
      selected: this.selected ? { index: this.selected.index, id: this.selected.id } : null }
  }
}
