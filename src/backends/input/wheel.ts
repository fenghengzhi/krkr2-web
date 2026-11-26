/** Convert DOM vertical movement to integer TVP deltas using the existing
 * pixel/line/page scale. Horizontal and fractional samples must never
 * synthesize a zero native wheel notification.
 * A residual belongs to one direction, unit mode and Window input lifetime. */
export class VerticalWheel {
  private remainder = 0
  private mode = -1
  private direction = 0

  clear(): void {
    this.remainder = 0
    this.mode = -1
    this.direction = 0
  }

  sample(deltaY: number, mode: number, pageHeight: number): number {
    const value = -deltaY * (mode === 1 ? 40 : mode === 2 ? pageHeight : 1)
    if (!Number.isFinite(value) || !value) {
      this.clear()
      return 0
    }
    const direction = Math.sign(value)
    if (mode !== this.mode || direction !== this.direction) this.remainder = 0
    this.mode = mode
    this.direction = direction
    const accumulated = value + this.remainder, delta = Math.trunc(accumulated)
    this.remainder = accumulated - delta
    return delta || 0
  }
}
