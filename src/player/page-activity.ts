import type { ActivityState } from '../engine/ports/activity.ts'

/** Page signals stay on the main thread; the engine receives a versioned value. */
export class PageActivityMonitor {
  private away = false
  private frozen = false
  private sequence = 0
  private closed = false
  private readonly abort = new AbortController()
  private signature = ''
  constructor(
    private readonly changed: (state: ActivityState) => void,
    private pauseWhenHidden = true,
  ) {
    const options = { capture: true, signal: this.abort.signal }
    document.addEventListener('visibilitychange', () => this.publish(), options)
    document.addEventListener(
      'freeze',
      () => {
        this.frozen = true
        this.publish()
      },
      options,
    )
    document.addEventListener(
      'resume',
      () => {
        this.frozen = false
        this.publish()
      },
      options,
    )
    window.addEventListener(
      'pagehide',
      () => {
        this.away = true
        this.publish()
      },
      options,
    )
    window.addEventListener(
      'pageshow',
      () => {
        this.away = false
        this.frozen = false
        this.publish()
      },
      options,
    )
    this.publish()
  }
  setPauseWhenHidden(value: boolean): void {
    this.pauseWhenHidden = value
    this.publish()
  }
  private publish(): void {
    if (this.closed) return
    const state = this.away
      ? 'away'
      : this.frozen
        ? 'frozen'
        : document.visibilityState === 'hidden'
          ? 'hidden'
          : 'visible'
    const signature = `${state}:${this.pauseWhenHidden}`
    if (signature === this.signature) return
    this.signature = signature
    this.changed({ sequence: ++this.sequence, state, pauseWhenHidden: this.pauseWhenHidden })
  }
  close(): void {
    this.closed = true
    this.abort.abort()
  }
}
