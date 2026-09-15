import type { WindowView } from '../engine/scene/window.ts'
import './game-windows.css'

export interface WindowHostView extends WindowView {
  stayOnTop?: boolean
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
}

type WindowHostIdentity = { windowId: number; surfaceEpoch: number }
export type WindowHostAction = WindowHostIdentity &
  (
    | { type: 'activate' | 'close' | 'exitFullScreen' }
    | { type: 'move'; left: number; top: number }
    | { type: 'resize'; width: number; height: number }
  )

export interface GameWindowSurface extends WindowHostIdentity {
  readonly canvas: HTMLCanvasElement
  readonly element: HTMLElement
  readonly menu: HTMLElement
  /** Canvas, video slot and BrowserInput's textarea share this positioned parent. */
  readonly content: HTMLElement
  readonly videoPlane: HTMLElement
}

export interface GameWindows {
  /** Repeated attachment is idempotent; a retired or superseded epoch has no canvas. */
  attach(windowId: number, surfaceEpoch: number): HTMLCanvasElement | undefined
  detach(windowId: number, surfaceEpoch: number): void
  /** Supply the epoch when forwarding asynchronous protocol events. */
  update(windowId: number, view: WindowHostView, active: boolean, surfaceEpoch?: number): void
  get(windowId: number, surfaceEpoch?: number): GameWindowSurface | undefined
  dispose(): void
}

interface WindowElement extends GameWindowSurface {
  readonly abort: AbortController
  readonly observer: ResizeObserver
  readonly body: HTMLElement
  readonly title: HTMLElement
  readonly close: HTMLButtonElement
  readonly leaveFullscreen: HTMLButtonElement
  readonly resize: HTMLElement
  readonly primary: boolean
  view: WindowHostView
  active: boolean
  order: number
  fullscreenOrder: number
  fullscreenSuppressed: boolean
  gesture?: () => void
  preview?: { left: number; top: number; width: number; height: number }
}

const defaultView = (): WindowHostView => ({
  width: 800,
  height: 600,
  left: 0,
  top: 0,
  caption: 'krkr2-web',
  visible: false,
  borderStyle: 2,
  innerSunken: false,
  showScrollBars: true,
  focusable: true,
  fullScreen: false,
  layerLeft: 0,
  layerTop: 0,
  zoomNumer: 1,
  zoomDenom: 1,
  mouseCursorState: 0,
})

/** Page-local windows own DOM only. Surface identity never retains a script object.
 * The player closes input/video controllers before detaching their DOM surface. */
export function createGameWindows(
  stage: HTMLElement,
  initialCanvas: HTMLCanvasElement,
  onAction: (action: WindowHostAction) => void,
): GameWindows {
  const document = stage.ownerDocument,
    browser = document.defaultView!,
    abort = new AbortController(),
    windows = new Map<number, WindowElement>(),
    epochs = new Map<number, { epoch: number; retired: boolean }>(),
    pending = new Map<number, { view: WindowHostView; active: boolean; surfaceEpoch?: number }>()
  let disposed = false,
    initialUsed = false,
    order = 0,
    fullscreenOrder = 0,
    fullscreen: WindowElement | undefined,
    bodyOverflow: string | undefined
  stage.classList.add('game-desktop')

  const live = (surface: WindowElement) =>
    !disposed &&
    windows.get(surface.windowId) === surface &&
    epochs.get(surface.windowId)?.epoch === surface.surfaceEpoch &&
    !epochs.get(surface.windowId)?.retired
  const interactive = (surface: WindowElement) =>
    live(surface) && surface.view.visible && !surface.view.blocked
  const emit = (
    surface: WindowElement,
    action:
      | { type: 'activate' | 'close' | 'exitFullScreen' }
      | { type: 'move'; left: number; top: number }
      | { type: 'resize'; width: number; height: number },
  ) => {
    if (live(surface))
      onAction({ ...action, windowId: surface.windowId, surfaceEpoch: surface.surfaceEpoch })
  }
  const fit = (surface: WindowElement) => {
    if (fullscreen !== surface) {
      surface.content.style.width = ''
      return
    }
    // Fit the actual element box. Letterboxing inside canvas would break pointer,
    // IME and video mappings, which all use its CSS dimensions and offsets.
    const width = Math.min(
      surface.body.clientWidth,
      (surface.body.clientHeight * surface.view.width) / surface.view.height,
    )
    surface.content.style.width = `${Math.max(0, width)}px`
  }
  const layout = (surface: WindowElement) => {
    const { element, canvas, view } = surface,
      geometry = surface.preview ?? view,
      embedded = windows.size === 1 && surface.primary,
      isFullscreen = fullscreen === surface
    element.hidden = !view.visible
    element.inert = !!view.blocked
    element.setAttribute('aria-disabled', String(!!view.blocked))
    element.classList.toggle('game-window-embedded', embedded)
    element.classList.toggle('game-window-active', surface.active)
    element.classList.toggle('game-window-sunken', view.innerSunken)
    element.classList.toggle('game-window-fullscreen', isFullscreen)
    element.dataset.border = String(view.borderStyle)
    element.dataset.active = String(surface.active)
    element.dataset.focusable = String(view.focusable)
    element.dataset.blocked = String(!!view.blocked)
    element.dataset.zoom = `${view.zoomNumer}/${view.zoomDenom}`
    element.style.setProperty('--game-window-width', `${geometry.width}px`)
    element.style.setProperty('--game-window-left', `${geometry.left}px`)
    element.style.setProperty('--game-window-top', `${geometry.top}px`)
    surface.title.textContent = view.caption
    element.setAttribute('aria-label', view.caption || '游戏窗口')
    canvas.setAttribute('aria-label', view.caption ? `游戏画布：${view.caption}` : '游戏画布')
    canvas.tabIndex = view.focusable && view.visible && !view.blocked ? 0 : -1
    surface.close.tabIndex = view.focusable && !view.blocked ? 0 : -1
    surface.leaveFullscreen.tabIndex = view.focusable && !view.blocked ? 0 : -1
    surface.close.disabled = !!view.blocked
    surface.leaveFullscreen.disabled = !!view.blocked
    canvas.style.aspectRatio = `${geometry.width} / ${geometry.height}`
    // Game zoom transforms layers in the renderer; responsive CSS does not
    // change logical size and must never report a Window.resize by itself.
    surface.content.style.overflow = view.showScrollBars ? 'auto' : 'hidden'
    surface.leaveFullscreen.hidden = !isFullscreen
    // Keep the legacy exit selector unique even when several windows exist.
    surface.leaveFullscreen.classList.toggle('leave-fullscreen', isFullscreen)
    surface.resize.hidden = embedded || isFullscreen || ![2, 5].includes(view.borderStyle)
    fit(surface)
  }
  const synchronize = () => {
    const previous = fullscreen,
      candidates = [...windows.values()].filter(
        (surface) =>
          surface.view.fullScreen && surface.view.visible && !surface.fullscreenSuppressed,
      )
    fullscreen = candidates.sort((a, b) => b.fullscreenOrder - a.fullscreenOrder)[0]
    if (previous !== fullscreen) for (const surface of windows.values()) surface.gesture?.()
    if (previous && previous !== fullscreen && live(previous) && previous.view.fullScreen) {
      previous.fullscreenSuppressed = true
      emit(previous, { type: 'exitFullScreen' })
    }
    if (fullscreen && bodyOverflow === undefined) {
      bodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    } else if (!fullscreen && bodyOverflow !== undefined) {
      if (document.body.style.overflow === 'hidden') document.body.style.overflow = bodyOverflow
      bodyOverflow = undefined
    }
    stage.classList.toggle('game-desktop-multiple', windows.size > 1)
    stage.classList.toggle('game-desktop-fullscreen', !!fullscreen)
    stage.classList.toggle('window-fullscreen', !!fullscreen)
    // These describe the sole surface for existing single-window consumers;
    // each floating window remains responsible for its own appearance.
    const sole = windows.size === 1 ? windows.values().next().value : undefined
    if (sole?.primary) sole.gesture?.()
    stage.classList.toggle('window-sunken', !!sole?.view.innerSunken)
    if (sole) stage.dataset.border = String(sole.view.borderStyle)
    else delete stage.dataset.border
    const stack = [...windows.values()].sort(
      (a, b) =>
        Number(!!b.view.blocked) - Number(!!a.view.blocked) ||
        Number(a === fullscreen) - Number(b === fullscreen) ||
        Number(!!a.view.stayOnTop) - Number(!!b.view.stayOnTop) ||
        a.order - b.order,
    )
    for (const [index, surface] of stack.entries()) {
      // The fullscreen desktop can outlive page scrolling. A modal above its
      // blocked owner shares the viewport origin. Cancel any pointer preview
      // before changing coordinate systems; unblocking restores page layout.
      const position =
        fullscreen?.view.blocked && !surface.view.blocked && fullscreen !== surface ? 'fixed' : ''
      if (surface.element.style.position !== position) {
        surface.gesture?.()
        surface.element.style.position = position
      }
      surface.element.style.zIndex = String(index + 1)
      layout(surface)
    }
  }
  const apply = (surface: WindowElement, view: WindowHostView, active: boolean) => {
    const gestureProperties = [
      'left',
      'top',
      'width',
      'height',
      'borderStyle',
      'minWidth',
      'minHeight',
      'maxWidth',
      'maxHeight',
      'fullScreen',
    ] as const
    if (
      !view.visible ||
      !view.focusable ||
      !!view.blocked !== !!surface.view.blocked ||
      gestureProperties.some((property) => view[property] !== surface.view[property])
    )
      surface.gesture?.()
    if (view.fullScreen && !surface.view.fullScreen) {
      surface.fullscreenOrder = ++fullscreenOrder
      surface.fullscreenSuppressed = false
    } else if (!view.fullScreen) surface.fullscreenSuppressed = false
    if (active && !surface.active) surface.order = ++order
    surface.view = { ...view }
    surface.active = active
    synchronize()
  }
  const activate = (surface: WindowElement) => {
    if (interactive(surface) && surface.view.focusable && !surface.active)
      emit(surface, { type: 'activate' })
  }
  const gesture = (surface: WindowElement, event: PointerEvent, resizing: boolean) => {
    if (
      !interactive(surface) ||
      event.button !== 0 ||
      fullscreen === surface ||
      // Responsive embedded playback has a fixed page origin. Script position
      // remains intact and becomes the DOM position only in floating mode.
      (windows.size === 1 && surface.primary) ||
      surface.view.borderStyle === 0 ||
      (resizing && ![2, 5].includes(surface.view.borderStyle))
    )
      return
    event.preventDefault()
    event.stopPropagation()
    surface.gesture?.()
    const target = event.currentTarget as HTMLElement,
      pointer = event.pointerId,
      start = { ...surface.view },
      origin = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop },
      bounds = surface.canvas.getBoundingClientRect(),
      sx = bounds.width ? start.width / bounds.width : 1,
      sy = bounds.height ? start.height / bounds.height : 1,
      gestureAbort = new AbortController(),
      options = { signal: gestureAbort.signal, capture: true }
    let complete = false
    const finish = (commit: boolean) => {
      if (complete) return
      complete = true
      const result = surface.preview
      surface.preview = undefined
      surface.gesture = undefined
      gestureAbort.abort()
      surface.element.classList.remove('game-window-dragging')
      if (target.hasPointerCapture(pointer)) target.releasePointerCapture(pointer)
      if (!live(surface)) return
      if (commit && result && interactive(surface)) {
        if (resizing) {
          surface.view = { ...surface.view, width: result.width, height: result.height }
          emit(surface, { type: 'resize', width: result.width, height: result.height })
        } else {
          surface.view = { ...surface.view, left: result.left, top: result.top }
          emit(surface, { type: 'move', left: result.left, top: result.top })
        }
      }
      layout(surface)
    }
    surface.gesture = () => finish(false)
    surface.element.classList.add('game-window-dragging')
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return
      if (!interactive(surface)) return finish(false)
      next.preventDefault()
      next.stopPropagation()
      const dx = next.clientX - origin.x + stage.scrollLeft - origin.left,
        dy = next.clientY - origin.y + stage.scrollTop - origin.top,
        bounded = (value: number, min = 0, max = 0) =>
          Math.max(1, min, Math.min(max || 4096, Math.round(value)))
      surface.preview = resizing
        ? {
            left: start.left,
            top: start.top,
            width: bounded(start.width + dx * sx, start.minWidth, start.maxWidth),
            height: bounded(start.height + dy * sy, start.minHeight, start.maxHeight),
          }
        : {
            left: Math.round(start.left + dx),
            top: Math.round(start.top + dy),
            width: start.width,
            height: start.height,
          }
      layout(surface)
    }
    browser.addEventListener('pointermove', move, options)
    browser.addEventListener(
      'pointerup',
      (next) => {
        if (next.pointerId !== pointer) return
        move(next)
        finish(true)
      },
      options,
    )
    browser.addEventListener(
      'pointercancel',
      (next) => {
        if (next.pointerId === pointer) finish(false)
      },
      options,
    )
    // Only losing the browser window cancels a captured gesture. Capturing
    // descendant blur would also cancel it when a menu or textarea loses focus.
    browser.addEventListener('blur', () => finish(false), {
      signal: gestureAbort.signal,
      capture: false,
    })
    target.addEventListener('lostpointercapture', () => finish(false), options)
    try {
      target.setPointerCapture(pointer)
    } catch {
      finish(false)
    }
  }
  const remove = (surface: WindowElement) => {
    surface.gesture?.()
    surface.abort.abort()
    surface.observer.disconnect()
    windows.delete(surface.windowId)
    surface.element.remove()
    if (fullscreen === surface) fullscreen = undefined
  }
  const node = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string) => {
    const element = document.createElement(tag)
    element.className = className
    return element
  }
  browser.addEventListener(
    'keydown',
    (event) => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        event.defaultPrevented ||
        !fullscreen ||
        !interactive(fullscreen)
      )
        return
      event.preventDefault()
      emit(fullscreen, { type: 'exitFullScreen' })
    },
    { signal: abort.signal },
  )
  return {
    attach(windowId, surfaceEpoch) {
      if (disposed) return
      const known = epochs.get(windowId)
      if (known && (surfaceEpoch < known.epoch || (surfaceEpoch === known.epoch && known.retired)))
        return
      const buffered = pending.get(windowId)
      if (buffered?.surfaceEpoch !== undefined && surfaceEpoch < buffered.surfaceEpoch) return
      const existing = windows.get(windowId)
      if (existing?.surfaceEpoch === surfaceEpoch) return existing.canvas
      if (existing) remove(existing)
      epochs.set(windowId, { epoch: surfaceEpoch, retired: false })
      const primary = !initialUsed,
        canvas = primary ? initialCanvas : document.createElement('canvas'),
        element = node('section', 'game-window'),
        header = node('div', 'game-window-header'),
        title = node('span', 'game-window-title'),
        close = node('button', 'game-window-close'),
        leaveFullscreen = node('button', 'game-window-leave-fullscreen'),
        menu = node('div', 'game-window-menu'),
        body = node('div', 'game-window-body'),
        content = node('div', 'game-window-content'),
        videoPlane = node('div', 'game-window-video-plane'),
        resize = node('div', 'game-window-resize'),
        surfaceAbort = new AbortController()
      initialUsed = true
      canvas.classList.add('game-window-canvas')
      element.dataset.windowId = String(windowId)
      element.dataset.surfaceEpoch = String(surfaceEpoch)
      canvas.dataset.windowId = String(windowId)
      canvas.dataset.surfaceEpoch = String(surfaceEpoch)
      element.setAttribute('role', 'group')
      close.type = 'button'
      close.textContent = '×'
      close.setAttribute('aria-label', '关闭游戏窗口')
      leaveFullscreen.type = 'button'
      leaveFullscreen.textContent = '退出全屏'
      leaveFullscreen.hidden = true
      menu.hidden = true
      resize.setAttribute('aria-hidden', 'true')
      header.append(title, leaveFullscreen, close)
      content.append(canvas, videoPlane)
      body.append(content)
      element.append(header, menu, body, resize)
      stage.append(element)
      const surface: WindowElement = {
        windowId,
        surfaceEpoch,
        canvas,
        element,
        menu,
        content,
        videoPlane,
        abort: surfaceAbort,
        observer: new ResizeObserver(() => fit(surface)),
        body,
        title,
        close,
        leaveFullscreen,
        resize,
        primary,
        view: defaultView(),
        active: false,
        order: ++order,
        fullscreenOrder: 0,
        fullscreenSuppressed: false,
      }
      windows.set(windowId, surface)
      surface.observer.observe(body)
      const options = { signal: surfaceAbort.signal }
      element.addEventListener('pointerdown', () => activate(surface), {
        ...options,
        capture: true,
      })
      element.addEventListener('focusin', () => activate(surface), options)
      header.addEventListener(
        'pointerdown',
        (event) => {
          if ((event.target as Element).closest('button')) {
            if (!surface.view.focusable) event.preventDefault()
            return
          }
          gesture(surface, event, false)
        },
        options,
      )
      resize.addEventListener('pointerdown', (event) => gesture(surface, event, true), options)
      // Chrome clicks never become a canvas click or bubble into game key bindings.
      for (const control of [header, resize]) {
        for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup'])
          control.addEventListener(
            type,
            (event) => {
              if ((event as KeyboardEvent).key !== 'Escape') event.stopPropagation()
            },
            options,
          )
      }
      close.addEventListener(
        'click',
        () => {
          if (interactive(surface)) emit(surface, { type: 'close' })
        },
        options,
      )
      leaveFullscreen.addEventListener(
        'click',
        () => {
          if (interactive(surface)) emit(surface, { type: 'exitFullScreen' })
        },
        options,
      )
      pending.delete(windowId)
      if (
        buffered &&
        (buffered.surfaceEpoch === undefined || buffered.surfaceEpoch === surfaceEpoch)
      )
        apply(surface, buffered.view, buffered.active)
      else synchronize()
      return canvas
    },
    detach(windowId, surfaceEpoch) {
      if (disposed) return
      const known = epochs.get(windowId)
      if (known && surfaceEpoch < known.epoch) return
      epochs.set(windowId, { epoch: surfaceEpoch, retired: true })
      const buffered = pending.get(windowId)
      if (buffered?.surfaceEpoch === undefined || buffered.surfaceEpoch <= surfaceEpoch)
        pending.delete(windowId)
      const surface = windows.get(windowId)
      if (surface) remove(surface)
      synchronize()
    },
    update(windowId, view, active, surfaceEpoch) {
      if (disposed) return
      const known = epochs.get(windowId)
      if (
        known &&
        (surfaceEpoch === undefined
          ? known.retired
          : surfaceEpoch < known.epoch || (surfaceEpoch === known.epoch && known.retired))
      )
        return
      const buffered = pending.get(windowId)
      if (
        surfaceEpoch !== undefined &&
        buffered?.surfaceEpoch !== undefined &&
        surfaceEpoch < buffered.surfaceEpoch
      )
        return
      const surface = windows.get(windowId)
      // A future view does not remove live input/video controllers. Only an
      // explicit attach/detach lifecycle may replace their DOM parent.
      if (surface && (surfaceEpoch === undefined || surfaceEpoch === surface.surfaceEpoch))
        apply(surface, view, active)
      else pending.set(windowId, { view: { ...view }, active, surfaceEpoch })
    },
    get(windowId, surfaceEpoch) {
      const surface = windows.get(windowId)
      return surface && (surfaceEpoch === undefined || surface.surfaceEpoch === surfaceEpoch)
        ? surface
        : undefined
    },
    dispose() {
      if (disposed) return
      disposed = true
      abort.abort()
      for (const surface of windows.values()) remove(surface)
      pending.clear()
      epochs.clear()
      synchronize()
      stage.classList.remove(
        'game-desktop',
        'game-desktop-multiple',
        'game-desktop-fullscreen',
        'window-fullscreen',
        'window-sunken',
      )
    },
  }
}
