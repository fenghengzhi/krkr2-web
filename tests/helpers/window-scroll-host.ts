import { createGameWindows, type WindowHostView } from '../../src/app/game-windows.ts'
import { WindowState } from '../../src/engine/scene/window.ts'
import { scrollWindowGeometry } from '../../src/engine/scene/window-geometry.ts'
import type { WindowGeometryScroll } from '../../src/engine/ports/window-geometry.ts'

/** Real host/CSS/layout scroll; only the producer of Window snapshots is
 * controlled to reproduce a state update before the browser's scroll event. */
export async function installWindowScrollHost() {
  const stage = document.createElement('div'), canvas = document.createElement('canvas'), abort = new AbortController(),
    observations: WindowGeometryScroll[] = []
  stage.className = 'stage'
  stage.style.cssText = 'position:relative;width:800px;height:400px'
  stage.append(canvas); document.body.append(stage)
  const windows = createGameWindows(stage, canvas, () => {})
  let view: WindowHostView = { ...new WindowState().view(), visible: true, caption: 'Scroll presentation', left: 0, top: 0 }
  windows.attach(1, 1)
  const measure = async (revision: number, primary: { width: number; height: number }, resetScroll: boolean) => {
    const geometry = await windows.measureGeometry({ requestId: revision, windowId: 1, revision,
      view, menus: {}, primary, innerRequest: { width: 220, height: 140 },
      operation: 'inner', size: { width: 220, height: 140 }, resetScroll }, 1, abort.signal)
    view = { ...view, width: geometry.outer.width, height: geometry.outer.height, geometry }
    canvas.width = geometry.viewport.width; canvas.height = geometry.viewport.height
    windows.update(1, view, true, 1)
  }
  try { await measure(1, { width: 440, height: 280 }, true) }
  catch (error) {
    try { windows.dispose() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Scroll host setup and cleanup failed', { cause: error }) }
    finally { stage.remove() }
    throw error
  }
  const scrollbox = windows.get(1, 1)!.element.querySelector<HTMLElement>('.game-window-scrollbox')!
  const unsubscribe = windows.subscribeGeometryScroll((event) => observations.push({ ...event }))
  const position = () => [scrollbox.scrollLeft, scrollbox.scrollTop]
  return {
    repeatDuringLocalScroll() {
      scrollbox.scrollTo(30, 40)
      const before = position()
      // Same task: the browser has changed its real scroll offsets, but has
      // not yet dispatched the scroll event to the subscribed engine port.
      const eventsBefore = observations.length
      windows.update(1, { ...view, caption: 'Same geometry, new caption' }, false, 1)
      return { before, after: position(), eventsBefore, eventsAfter: observations.length }
    },
    publish(x: number, y: number) {
      view = { ...view, geometry: scrollWindowGeometry(view.geometry!, x, y) }
      windows.update(1, view, true, 1)
      return position()
    },
    async shrink() { await measure(2, { width: 80, height: 60 }, false); return position() },
    async restore() { await measure(3, { width: 440, height: 280 }, true); return position() },
    replace() {
      windows.detach(1, 1); windows.attach(1, 2)
      view = { ...view, geometry: { ...scrollWindowGeometry(view.geometry!, 7, 9), surfaceEpoch: 2 } }
      windows.update(1, view, true, 2)
      const replacement = windows.get(1, 2)!.element.querySelector<HTMLElement>('.game-window-scrollbox')!
      return [replacement.scrollLeft, replacement.scrollTop]
    },
    position,
    observations: () => observations.map((entry) => ({ ...entry })),
    dispose() { unsubscribe(); abort.abort(); try { windows.dispose() } finally { stage.remove() } },
  }
}

declare global { interface Window { windowScrollHost: Awaited<ReturnType<typeof installWindowScrollHost>> } }
