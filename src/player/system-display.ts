import {
  copySystemDisplayMetrics,
  systemDisplayProperties,
  type SystemDisplayMetrics,
  type SystemDisplayUpdate,
} from '../engine/system/display.ts'

/** Owns one player's page geometry. It never requests OS window-management permissions. */
export class BrowserSystemDisplay {
  private readonly browser: Window
  private readonly abort: AbortController
  private readonly observer?: ResizeObserver
  private readonly borderObserver?: ResizeObserver
  private metrics: SystemDisplayMetrics
  private revision = 0
  private closed = false
  private fullscreen = false
  private readonly fixed: boolean

  constructor(
    private readonly desktop: HTMLElement,
    private readonly changed: (update: SystemDisplayUpdate) => void,
    fixed?: SystemDisplayMetrics,
  ) {
    const browser = desktop.ownerDocument.defaultView
    if (!browser) throw new Error('System display requires a browser document')
    this.browser = browser
    this.abort = new AbortController()
    this.fixed = fixed !== undefined
    this.metrics = fixed === undefined ? this.sample() : copySystemDisplayMetrics(fixed)
    // Injected geometry is a fixed, copied embedding contract. It does not
    // observe page changes or retain the caller's object after construction.
    try {
      if (fixed === undefined) {
        this.observer = new ResizeObserver(() => this.refresh())
        this.observer.observe(desktop)
        // client dimensions include padding and exclude scrollbars. Observing
        // both boxes catches padding-only changes as well as scrollbar changes
        // whose outer border box is unchanged. Equal samples do not send RPCs.
        this.borderObserver = new ResizeObserver(() => this.refresh())
        this.borderObserver.observe(desktop, { box: 'border-box' })
        browser.addEventListener('resize', this.refresh, { signal: this.abort.signal })
        browser.visualViewport?.addEventListener('resize', this.refresh, {
          signal: this.abort.signal,
        })
        desktop.ownerDocument.addEventListener('fullscreenchange', this.refresh, {
          signal: this.abort.signal,
        })
      }
      changed({ revision: this.revision, metrics: { ...this.metrics } })
    } catch (error) {
      try {
        this.close()
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'System display setup and cleanup failed')
      }
      throw error
    }
  }

  private sample(): SystemDisplayMetrics {
    const width = this.fullscreen ? this.browser.innerWidth : this.desktop.clientWidth,
      height = this.fullscreen ? this.browser.innerHeight : this.desktop.clientHeight
    return copySystemDisplayMetrics({
      screenWidth: width,
      screenHeight: height,
      // Window.left/top are relative to this player's containing stage. Page
      // offsets, OS screen coordinates and page scrolling do not move its origin.
      desktopLeft: 0,
      desktopTop: 0,
      desktopWidth: width,
      desktopHeight: height,
    })
  }

  /** Called from this player's Window roster after its host applies the view. */
  setFullscreen(fullscreen: boolean): void {
    if (this.closed || this.fixed || this.fullscreen === fullscreen) return
    this.fullscreen = fullscreen
    this.refresh()
  }

  private readonly refresh = (): void => {
    if (this.closed) return
    const next = this.sample()
    if (systemDisplayProperties.every((name) => next[name] === this.metrics[name])) return
    this.metrics = next
    this.changed({ revision: ++this.revision, metrics: { ...next } })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const errors: unknown[] = []
    for (const dispose of [
      () => this.observer?.disconnect(),
      () => this.borderObserver?.disconnect(),
      () => this.abort.abort(),
    ]) {
      try {
        dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'System display cleanup failed')
  }
}
