export type DebugPanel = 'console' | 'controller'
export interface DebugVisibility {
  console: boolean
  controller: boolean
}

/** Script properties and browser controls share one session-owned view state. */
export class DebugPanels {
  private visibility: DebugVisibility = { console: true, controller: true }
  constructor(private readonly changed: () => void) {}
  private validate(panel: string): asserts panel is DebugPanel {
    if (panel !== 'console' && panel !== 'controller') throw new Error('Unknown debug panel')
  }
  get(panel: string): boolean {
    this.validate(panel)
    return this.visibility[panel]
  }
  set(panel: string, visible: boolean): void {
    this.validate(panel)
    if (typeof visible !== 'boolean') throw new Error('Debug visibility must be boolean')
    if (this.visibility[panel] === visible) return
    this.visibility[panel] = visible
    this.changed()
  }
  snapshot(): DebugVisibility {
    return { ...this.visibility }
  }
}
