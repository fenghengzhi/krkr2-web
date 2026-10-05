import { createGameWindows, type WindowHostAction, type WindowHostView } from '../../src/app/game-windows.ts'
import { WindowState } from '../../src/engine/scene/window.ts'
import type { WindowRegion } from '../../src/engine/scene/window-region.ts'

export interface RegionDefinition { width: number; height: number; rectangles: number[] }

/** Real host DOM/CSS and trusted page pointer events. The action sink records
 * host commands without substituting the browser's hit testing. */
export function installWindowRegionHost() {
  const stage = document.createElement('div'), initial = document.createElement('canvas'),
    actions: WindowHostAction[] = [], pointer: Array<{ windowId: number; trusted: boolean; x: number; y: number }> = [],
    abort = new AbortController(), views = new Map<number, WindowHostView>(), epochs = new Map<number, number>()
  stage.className = 'stage'
  stage.style.cssText = 'position:relative;width:1000px;height:560px'
  stage.append(initial)
  document.body.append(stage)
  const windows = createGameWindows(stage, initial, (action) => actions.push(action))
  window.addEventListener('pointerdown', (event) => {
    const owner = event.target instanceof Element ? event.target.closest<HTMLElement>('.game-window') : null
    pointer.push({ windowId: Number(owner?.dataset.windowId ?? 0), trusted: event.isTrusted,
      x: event.clientX, y: event.clientY })
  }, { capture: true, signal: abort.signal })
  const surface = (id: number) => {
    const value = windows.get(id, epochs.get(id))
    if (!value) throw new Error(`Missing region fixture surface ${id}`)
    return value
  }
  for (const id of [11, 22]) {
    const view: WindowHostView = { ...new WindowState().view(), visible: true, left: 40, top: 40,
      width: 320, height: 180, caption: id === 11 ? 'Region lower' : 'Region upper', stayOnTop: id === 22 }
    views.set(id, view); epochs.set(id, 1)
    const canvas = windows.attach(id, 1)!
    canvas.width = 320; canvas.height = 180
    const context = canvas.getContext('2d')!
    context.fillStyle = id === 11 ? '#164b83' : '#d96e22'
    context.fillRect(0, 0, 320, 180)
    windows.update(id, view, false, 1)
  }
  return {
    publish(id: number, revision: number, definition: RegionDefinition | null, epoch = epochs.get(id)!, mutate = false) {
      const region: WindowRegion | null = definition && { width: definition.width, height: definition.height,
        rectangles: new Uint16Array(definition.rectangles) }
      windows.setRegion(id, revision, region, epoch)
      if (mutate) region?.rectangles.fill(0)
    },
    invalid(id: number, revision: number, kind: 'tuple' | 'bounds' | 'type' | 'dimension' | 'empty-rectangle') {
      const region: WindowRegion = { width: 320, height: 180, rectangles: new Uint16Array([0, 0, 80, 180]) }
      const invalid = kind === 'tuple' ? { ...region, rectangles: new Uint16Array([0, 0, 80]) }
        : kind === 'bounds' ? { ...region, rectangles: new Uint16Array([319, 0, 2, 10]) }
        : kind === 'type' ? { ...region, rectangles: new Uint8Array([0, 0, 80, 180]) }
        : kind === 'dimension' ? { ...region, width: 4097 }
        : { ...region, rectangles: new Uint16Array([0, 0, 0, 10]) }
      try {
        windows.setRegion(id, revision, invalid as unknown as WindowRegion, epochs.get(id)!)
        return ''
      } catch (error) { return error instanceof Error ? error.message : String(error) }
    },
    update(id: number, changes: Partial<WindowHostView>) {
      const view = { ...views.get(id)!, ...changes }
      views.set(id, view)
      windows.update(id, view, false, epochs.get(id)!)
    },
    canvasWidth(id: number, width: number) { surface(id).canvas.style.width = `${width}px` },
    detach(id: number, epoch = epochs.get(id)!) { windows.detach(id, epoch) },
    replace(id: number, epoch: number) {
      const canvas = windows.attach(id, epoch)
      if (!canvas) throw new Error('Expected a new region surface')
      epochs.set(id, epoch)
      canvas.width = 320; canvas.height = 180
      windows.update(id, views.get(id)!, false, epoch)
    },
    point(id: number, x: number, y: number) {
      const bounds = surface(id).element.getBoundingClientRect()
      return { x: bounds.left + x, y: bounds.top + y }
    },
    hit(id: number, x: number, y: number) {
      const bounds = surface(id).element.getBoundingClientRect(),
        hit = document.elementFromPoint(bounds.left + x, bounds.top + y)?.closest<HTMLElement>('.game-window')
      return Number(hit?.dataset.windowId ?? 0)
    },
    snapshot(id: number) {
      const current = surface(id), canvas = current.canvas.getBoundingClientRect(), outer = current.element.getBoundingClientRect()
      return { epoch: current.surfaceEpoch, clip: getComputedStyle(current.element).clipPath,
        outer: { x: outer.x, y: outer.y, width: outer.width, height: outer.height },
        canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height },
        definitions: document.querySelectorAll('clipPath').length }
    },
    pointer: () => pointer.map((entry) => ({ ...entry })),
    actions: () => actions.map((entry) => ({ ...entry })),
    clear: () => { pointer.length = 0; actions.length = 0 },
    dispose() { windows.dispose(); abort.abort(); stage.remove() },
  }
}

declare global {
  interface Window { windowRegionHost: ReturnType<typeof installWindowRegionHost> }
}
