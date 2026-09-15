import {
  createGameWindows,
  type WindowHostAction,
  type WindowHostView,
} from '../../src/app/game-windows.ts'
import { WindowState } from '../../src/engine/scene/window.ts'

/** Real page windows and pointer capture; only the Session action sink is observed. */
export function installModalWindowHost() {
  const stage = document.createElement('div'),
    initialCanvas = document.createElement('canvas'),
    actions: WindowHostAction[] = [],
    views = new Map<number, WindowHostView>([
      [
        11,
        {
          ...new WindowState().view(),
          caption: 'Parent window',
          visible: true,
          left: 20,
          top: 20,
          width: 320,
          height: 180,
        },
      ],
      [
        22,
        {
          ...new WindowState().view(),
          caption: 'Modal window',
          visible: true,
          left: 420,
          top: 60,
          width: 300,
          height: 200,
        },
      ],
    ])
  stage.className = 'stage'
  stage.style.cssText = 'position:relative;width:1000px;height:560px'
  stage.append(initialCanvas)
  document.querySelector('#after-windows')!.before(stage)
  const windows = createGameWindows(stage, initialCanvas, (action) => actions.push(action)),
    requiredView = (windowId: number) => {
      const view = views.get(windowId)
      if (!view) throw new Error(`Unknown fixture window ${windowId}`)
      return view
    },
    surface = (windowId: number) => {
      const value = windows.get(windowId, 1)
      if (!value) throw new Error(`Missing fixture surface ${windowId}`)
      return value
    }
  for (const [windowId, view] of views) {
    windows.attach(windowId, 1)
    windows.update(windowId, view, false, 1)
  }
  return {
    update(windowId: number, changes: Partial<WindowHostView>) {
      const view = { ...requiredView(windowId), ...changes }
      views.set(windowId, view)
      windows.update(windowId, view, false, 1)
    },
    actions: () => actions.map((action) => ({ ...action })),
    clearActions: () => {
      actions.length = 0
    },
    snapshot(windowId: number) {
      const { element, canvas } = surface(windowId),
        close = element.querySelector<HTMLButtonElement>('.game-window-close')!,
        leave = element.querySelector<HTMLButtonElement>('.game-window-leave-fullscreen')!
      return {
        view: { ...requiredView(windowId) },
        hidden: element.hidden,
        inert: element.inert,
        ariaDisabled: element.getAttribute('aria-disabled'),
        focusable: element.dataset.focusable,
        canvasTabIndex: canvas.tabIndex,
        closeTabIndex: close.tabIndex,
        leaveTabIndex: leave.tabIndex,
        closeDisabled: close.disabled,
        leaveDisabled: leave.disabled,
        dragging: element.classList.contains('game-window-dragging'),
        fullscreen: element.classList.contains('game-window-fullscreen'),
        zIndex: Number(element.style.zIndex),
        position: element.style.position,
        left: element.style.getPropertyValue('--game-window-left'),
        top: element.style.getPropertyValue('--game-window-top'),
        width: element.style.getPropertyValue('--game-window-width'),
        aspectRatio: canvas.style.aspectRatio,
      }
    },
    dispose() {
      windows.dispose()
      stage.remove()
    },
  }
}

declare global {
  interface Window {
    modalWindowHost: ReturnType<typeof installModalWindowHost>
  }
}
