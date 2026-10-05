import type { ApplicationActivation } from '../engine/ports/application.ts'

/** Only actual page/application signals enter this channel. A textarea blur,
 * canvas switch or menu focus change is not application deactivation. */
export class PageApplicationMonitor {
  private readonly abort = new AbortController()
  private away = false
  private frozen = false
  private sequence = 0
  private active?: boolean
  private closed = false
  constructor(private readonly changed: (value: ApplicationActivation) => void) {
    const options = { signal: this.abort.signal }
    window.addEventListener('blur', (event) => { if (event.target === window) this.publish(false) }, options)
    window.addEventListener('focus', (event) => { if (event.target === window) this.publish(true) }, options)
    document.addEventListener('visibilitychange', () => this.publish(), options)
    document.addEventListener('freeze', () => { this.frozen = true; this.publish() }, options)
    document.addEventListener('resume', () => { this.frozen = false; this.publish() }, options)
    window.addEventListener('pagehide', () => { this.away = true; this.publish() }, options)
    window.addEventListener('pageshow', () => { this.away = false; this.frozen = false; this.publish() }, options)
    this.publish()
  }
  private publish(focused = document.hasFocus()): void {
    if (this.closed) return
    const active = focused && !this.away && !this.frozen && document.visibilityState !== 'hidden'
    if (active === this.active) return
    this.active = active
    this.changed({ sequence: ++this.sequence, active })
  }
  close(): void { this.closed = true; this.abort.abort() }
}
