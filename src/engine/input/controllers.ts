import { InputController, type InputOwnershipStep, type InputOperation } from './controller.ts'
import type { LayerTree } from '../scene/layers.ts'
import { WindowState, type WindowView } from '../scene/window.ts'

/** Host-only manager state. Script role references remain in the single Input
 * pump Dictionary; neither live nor retired controllers own a VM reference. */
export class InputControllers {
  private readonly registered = new Map<number, InputController>()
  private readonly retired = new Set<InputController>()
  private readonly fallback: InputController
  private legacy = false

  constructor(
    readonly layers: LayerTree,
    private readonly activeWindowId: () => number = () => 0,
  ) {
    const empty = new WindowState()
    this.fallback = new InputController(
      layers,
      () => empty,
      () => 0,
    )
  }

  static single(controller: InputController): InputControllers {
    const registry = new InputControllers(controller.layers, () => controller.sourceWindowId)
    registry.registered.set(controller.sourceWindowId, controller)
    registry.legacy = true
    return registry
  }

  create(id: number, view: WindowView | (() => WindowView)): InputController {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid input Window identifier')
    if (this.registered.has(id)) throw new Error('Input Window is already registered')
    const controller = new InputController(
      this.layers,
      typeof view === 'function' ? view : () => view,
      () => id,
    )
    this.registered.set(id, controller)
    return controller
  }

  get(id: number): InputController | undefined {
    return (
      this.registered.get(id) ?? (this.legacy ? this.registered.values().next().value : undefined)
    )
  }

  get active(): InputController {
    return this.get(this.activeWindowId()) ?? this.fallback
  }

  forLayer(id: number): InputController {
    return this.layers.has(id)
      ? (this.get(this.layers.get(id).windowId) ?? this.fallback)
      : this.legacy
        ? this.active
        : this.fallback
  }

  values(): InputController[] {
    return [...this.registered.values()]
  }

  /** Immediately exclude the window from routing, but keep its queued releases
   * until the cooperative pump has delivered them to the ownership Dictionary. */
  remove(id: number): void {
    const controller = this.registered.get(id)
    if (!controller) return
    controller.clear()
    this.registered.delete(id)
    if (controller.ownershipPending) this.retired.add(controller)
  }

  private all(): InputController[] {
    return [...this.registered.values(), ...this.retired, this.fallback]
  }

  takeOwnership(): InputOwnershipStep | undefined {
    for (const controller of this.all()) {
      const command = controller.takeOwnership()
      if (!controller.ownershipPending) this.retired.delete(controller)
      if (command) return command
    }
    return undefined
  }

  get ownershipPending(): boolean {
    return this.all().some((controller) => controller.ownershipPending)
  }

  *synchronize(): InputOperation {
    return undefined
  }

  /** Native registration releases capture on every existing window, without
   * discarding independent focused/modal manager slots. */
  releaseCaptures(): void {
    for (const controller of this.registered.values()) controller.release()
  }

  resetTransient(): void {
    for (const controller of this.all()) controller.resetTransient()
  }

  clear(): void {
    for (const controller of this.all()) controller.clear()
  }

  dispose(): void {
    for (const controller of this.all()) controller.dispose()
    this.registered.clear()
    this.retired.clear()
  }
}
