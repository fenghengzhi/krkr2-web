import {
  createGameWindows,
  type WindowHostAction,
  type WindowHostView,
} from '../../src/app/game-windows.ts'
import { WindowState } from '../../src/engine/scene/window.ts'
import type { WindowMoveMessage } from '../../src/engine/ports/window-move.ts'
import { createGameMenus } from '../../src/app/game-menus.ts'

function observePointerCapture(target: HTMLElement) {
  const limit = 96,
    entries: Record<string, unknown>[] = [],
    abort = new AbortController(),
    methods = ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const,
    descriptors = methods.map((name) => Object.getOwnPropertyDescriptor(target, name)),
    nativeHas = target.hasPointerCapture,
    nativeSet = target.setPointerCapture,
    nativeRelease = target.releasePointerCapture,
    describe = (value: EventTarget | null) =>
      value instanceof Element
        ? `${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ''}${Array.from(value.classList, (name) => `.${name}`).join('')}`
        : value === window
          ? 'window'
          : String(value),
    errorDetails = (error: unknown) => ({
      name: error instanceof Error || error instanceof DOMException ? error.name : typeof error,
      message:
        error instanceof Error || error instanceof DOMException ? error.message : String(error),
      isDOMException: error instanceof DOMException,
    })
  let phase = 'setup',
    pointer: number | undefined,
    dropped = 0
  const captureState = (
      pointerId = pointer,
    ): {
      nativeHasCapture?: boolean
      nativeHasCaptureError?: ReturnType<typeof errorDetails>
    } => {
      if (pointerId === undefined) return {}
      try {
        return { nativeHasCapture: nativeHas.call(target, pointerId) }
      } catch (error) {
        return { nativeHasCaptureError: errorDetails(error) }
      }
    },
    record = (entry: Record<string, unknown>) => {
      if (entries.length === limit) {
        dropped++
        return
      }
      entries.push({ sequence: entries.length, phase, captureTarget: describe(target), ...entry })
    },
    release = function (this: Element, pointerId: number) {
      try {
        nativeRelease.call(this, pointerId)
        record({
          type: 'call',
          name: 'releasePointerCapture',
          pointerId,
          receiver: describe(this),
          ...captureState(pointerId),
        })
      } catch (error) {
        record({
          type: 'call',
          name: 'releasePointerCapture',
          pointerId,
          receiver: describe(this),
          error: errorDetails(error),
          ...captureState(pointerId),
        })
        throw error
      }
    }
  target.hasPointerCapture = function (pointerId) {
    try {
      const result = nativeHas.call(this, pointerId)
      record({
        type: 'call',
        name: 'hasPointerCapture',
        pointerId,
        receiver: describe(this),
        result,
      })
      return result
    } catch (error) {
      record({
        type: 'call',
        name: 'hasPointerCapture',
        pointerId,
        receiver: describe(this),
        error: errorDetails(error),
      })
      throw error
    }
  }
  target.setPointerCapture = function (pointerId) {
    try {
      nativeSet.call(this, pointerId)
      record({
        type: 'call',
        name: 'setPointerCapture',
        pointerId,
        receiver: describe(this),
        ...captureState(pointerId),
      })
    } catch (error) {
      record({
        type: 'call',
        name: 'setPointerCapture',
        pointerId,
        receiver: describe(this),
        error: errorDetails(error),
        ...captureState(pointerId),
      })
      throw error
    }
  }
  target.releasePointerCapture = release
  for (const name of [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'gotpointercapture',
    'lostpointercapture',
  ])
    window.addEventListener(
      name,
      (event) => {
        const next = event as PointerEvent
        if (
          next.type === 'pointerdown' &&
          next.target instanceof Node &&
          target.contains(next.target)
        )
          pointer = next.pointerId
        if (next.pointerId !== pointer) return
        // The observer's currentTarget is window. The product handler's
        // currentTarget/capture receiver is the header or resize handle, while a
        // move's original event.target is the title child inside that header.
        record({
          type: 'event',
          name: next.type,
          pointerId: next.pointerId,
          pointerType: next.pointerType,
          isTrusted: next.isTrusted,
          buttons: next.buttons,
          clientX: next.clientX,
          clientY: next.clientY,
          eventTarget: describe(next.target),
          observerCurrentTarget: describe(next.currentTarget),
          ...captureState(next.pointerId),
        })
      },
      { capture: true, signal: abort.signal },
    )
  return {
    phase(value: string) {
      phase = value
      record({ type: 'marker', name: value, pointerId: pointer, ...captureState() })
    },
    injectReleaseFailure(name: 'NotFoundError' | 'Error') {
      // This is explicitly synthetic: the real gesture has native capture,
      // but this scoped release call throws before invoking the native method.
      target.releasePointerCapture = function (pointerId) {
        const error =
          name === 'NotFoundError'
            ? new DOMException('Synthetic expired pointer during releasePointerCapture', name)
            : new Error('Synthetic unexpected releasePointerCapture failure')
        record({
          type: 'synthetic-release',
          name: 'releasePointerCapture',
          pointerId,
          receiver: describe(this),
          nativeReleaseInvoked: false,
          error: errorDetails(error),
          ...captureState(pointerId),
        })
        throw error
      }
    },
    restoreRelease() {
      target.releasePointerCapture = release
      record({
        type: 'marker',
        name: 'native-release-restored',
        pointerId: pointer,
        ...captureState(),
      })
    },
    snapshot: () => ({
      limit,
      dropped,
      pointerId: pointer,
      ...captureState(),
      entries: entries.map((entry) => ({ ...entry })),
    }),
    restore() {
      abort.abort()
      methods.forEach((name, index) => {
        const descriptor = descriptors[index]
        if (descriptor) Object.defineProperty(target, name, descriptor)
        else Reflect.deleteProperty(target, name)
      })
    },
  }
}

/** Real page windows and pointer capture; the Session action sink records commands. */
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
  const moves = new Map<number, { abort: AbortController; messages: WindowMoveMessage[];
    settled: boolean; error?: string }>()
  const menus = new Map<number, ReturnType<typeof createGameMenus>>(), menuSelections: number[] = []
  let nextMove = 1
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
    openPopup(windowId: number) {
      menus.get(windowId)?.dispose()
      const current = surface(windowId), item = (id: number, caption: string) => ({
        id, caption, enabled: true, visible: true, checked: false, radio: false, shortcut: '', children: [],
      }), root = { ...item(100, 'Move popup'), children: [item(101, 'Choose held game popup')] },
        menu = createGameMenus(current.element.querySelector<HTMLElement>('.game-window-menu')!,
          () => current.canvas, (id) => menuSelections.push(id), () => {})
      menus.set(windowId, menu)
      menu.state(true, requiredView(windowId).width, requiredView(windowId).height)
      menu.update({ root, popup: { windowId, requestId: 1, id: 100, x: 0, y: 0, flags: 0 } })
    },
    menuSelections: () => [...menuSelections],
    observePointerCapture(windowId: number, kind: 'move' | 'resize') {
      const target = surface(windowId).element.querySelector<HTMLElement>(
        kind === 'move' ? '.game-window-header' : '.game-window-resize',
      )!
      return observePointerCapture(target)
    },
    observeCanvasPointerCapture(windowId: number) {
      return observePointerCapture(surface(windowId).canvas)
    },
    beginScriptMove(windowId: number, pointerId: number) {
      const current = surface(windowId), view = requiredView(windowId), requestId = nextMove++,
        record = { abort: new AbortController(), messages: [] as WindowMoveMessage[],
          settled: false, error: undefined as string | undefined }
      moves.set(requestId, record)
      // Match the production Player -> BrowserInput handoff: revoke game
      // canvas capture, then let GameWindows own the still-held real pointer.
      current.canvas.releasePointerCapture(pointerId)
      void windows.beginMove({ requestId, windowId, left: view.left, top: view.top }, 1,
        (message) => { record.messages.push(message) }, record.abort.signal).then(
        () => { record.settled = true },
        (error: unknown) => { record.settled = true; record.error = String(error) },
      )
      return requestId
    },
    scriptMove(requestId: number) {
      const record = moves.get(requestId)
      if (!record) throw new Error(`Unknown fixture move ${requestId}`)
      return { settled: record.settled, error: record.error,
        messages: record.messages.map((message) => ({ ...message })) }
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
      for (const move of moves.values()) move.abort.abort()
      for (const menu of menus.values()) menu.dispose()
      menus.clear()
      windows.dispose()
      stage.remove()
    },
  }
}

declare global {
  interface Window {
    modalWindowHost: ReturnType<typeof installModalWindowHost>
    modalWindowCapture: ReturnType<typeof observePointerCapture>
  }
}
