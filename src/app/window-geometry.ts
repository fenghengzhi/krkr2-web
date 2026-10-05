import type { WindowGeometry, WindowGeometryRequest } from '../engine/ports/window-geometry.ts'
import { validateWindowGeometry, windowGeometryLimit } from '../engine/scene/window-geometry.ts'
import { deviceMulDiv } from '../engine/scene/draw-device.ts'
import { createGameMenus } from './game-menus.ts'

const rectangle = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const bounded = (value: number, min = 0, max = 0) =>
  Math.max(1, min, Math.min(max || windowGeometryLimit, Math.round(value)))

/** Measure the same page chrome at logical scale one. The isolated inert tree
 * cannot change a live Window while its worker is awaiting the reply. A hidden
 * Window still receives real CSS/menu/scrollbar measurements. */
export function measureWindowGeometry(
  stage: HTMLElement, request: WindowGeometryRequest, surfaceEpoch: number, signal: AbortSignal,
): WindowGeometry {
  signal.throwIfAborted()
  const document = stage.ownerDocument, browser = document.defaultView!, view = request.view,
    element = document.createElement('section'), header = document.createElement('div'),
    title = document.createElement('span'), close = document.createElement('button'),
    menu = document.createElement('div'), scrollbox = document.createElement('div'),
    spacer = document.createElement('div')
  element.className = 'game-window game-window-measure'
  element.dataset.border = String(view.borderStyle)
  element.inert = true
  element.setAttribute('aria-hidden', 'true')
  header.className = 'game-window-header'
  title.className = 'game-window-title'; title.textContent = view.caption
  close.className = 'game-window-close'; close.textContent = '×'
  header.append(title, close)
  menu.className = 'game-window-menu'
  scrollbox.className = 'game-window-scrollbox'
  spacer.className = 'game-window-scroll-space'
  scrollbox.append(spacer)
  element.append(header, menu, scrollbox)
  stage.append(element)
  const menus = createGameMenus(menu, () => null, () => {}, () => {})
  try {
    menus.update({ root: request.menus.root })
    const fullScreen = view.fullScreen, inset = view.innerSunken && !fullScreen ? 2 : 0
    let width = fullScreen ? browser.innerWidth : bounded(request.operation === 'inner'
        ? view.width : request.size?.width ?? view.width, view.minWidth, view.maxWidth),
      height = fullScreen ? browser.innerHeight : bounded(request.operation === 'inner'
        ? view.height : request.size?.height ?? view.height, view.minHeight, view.maxHeight)
    const chrome = () => {
      element.style.width = `${width}px`
      element.style.height = `${height}px`
      const borderX = element.clientLeft, borderY = element.clientTop,
        top = fullScreen ? 0 : borderY + header.offsetHeight + (menu.hidden ? 0 : menu.offsetHeight)
      return { borderX: fullScreen ? 0 : borderX, top,
        bottom: fullScreen ? 0 : borderY }
    }
    element.classList.toggle('game-window-fullscreen', fullScreen)
    // Inner setters specify the usable client rectangle before scrollbars.
    // Width is applied first so a wrapping menu contributes its actual height.
    let frame = chrome()
    if (!fullScreen && request.operation === 'inner') {
      if (request.size?.width !== undefined)
        width = bounded(request.size.width + inset * 2 + frame.borderX * 2, view.minWidth, view.maxWidth)
      frame = chrome()
      if (request.size?.height !== undefined)
        height = bounded(request.size.height + inset * 2 + frame.top + frame.bottom, view.minHeight, view.maxHeight)
      frame = chrome()
    }
    if (width > windowGeometryLimit || height > windowGeometryLimit)
      throw new RangeError('Window DOM geometry exceeds the surface limit')
    const outer = rectangle(0, 0, width, height),
      client = rectangle(Math.min(width, frame.borderX), Math.min(height, frame.top),
        Math.max(0, width - frame.borderX * 2), Math.max(0, height - frame.top - frame.bottom)),
      inner = rectangle(client.x + Math.min(inset, client.width), client.y + Math.min(inset, client.height),
        Math.max(0, client.width - inset * 2), Math.max(0, client.height - inset * 2)),
      actualZoom = fullScreen
        ? (width * request.innerRequest.height <= height * request.innerRequest.width
          ? { numer: width, denom: request.innerRequest.width }
          : { numer: height, denom: request.innerRequest.height })
        : { numer: view.zoomNumer, denom: view.zoomDenom },
      paintWidth = Math.max(0, deviceMulDiv(request.primary.width, actualZoom.numer, actualZoom.denom)),
      paintHeight = Math.max(0, deviceMulDiv(request.primary.height, actualZoom.numer, actualZoom.denom)),
      left = deviceMulDiv(view.layerLeft, actualZoom.numer, actualZoom.denom),
      top = deviceMulDiv(view.layerTop, actualZoom.numer, actualZoom.denom)
    let area = { ...inner }
    if (fullScreen) {
      const fitWidth = Math.trunc(request.innerRequest.width * actualZoom.numer / actualZoom.denom),
        fitHeight = Math.trunc(request.innerRequest.height * actualZoom.numer / actualZoom.denom)
      area = rectangle(Math.trunc((width - fitWidth) / 2), Math.trunc((height - fitHeight) / 2), fitWidth, fitHeight)
    }
    scrollbox.style.cssText = `left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px;overflow:${view.showScrollBars ? 'auto' : 'hidden'}`
    const extentX = Math.max(0, left + paintWidth), extentY = Math.max(0, top + paintHeight)
    spacer.style.width = `${extentX}px`; spacer.style.height = `${extentY}px`
    const viewport = rectangle(area.x, area.y, scrollbox.clientWidth, scrollbox.clientHeight),
      scrollbars = { horizontal: area.height - viewport.height, vertical: area.width - viewport.width },
      maxX = view.showScrollBars ? Math.max(0, scrollbox.scrollWidth - viewport.width) : 0,
      maxY = view.showScrollBars ? Math.max(0, scrollbox.scrollHeight - viewport.height) : 0
    // Engines have finite layout coordinate ranges. Reject a clipped CSS
    // extent instead of publishing a fictitious, unreachable scroll range.
    if (view.showScrollBars && (scrollbox.scrollWidth < Math.max(viewport.width, extentX) ||
        scrollbox.scrollHeight < Math.max(viewport.height, extentY)))
      throw new RangeError('Window scroll extent exceeds browser layout capacity')
    const previous = view.geometry?.scroll,
      x = request.resetScroll ? 0 : Math.min(maxX, previous?.x ?? 0),
      y = request.resetScroll ? 0 : Math.min(maxY, previous?.y ?? 0)
    signal.throwIfAborted()
    return validateWindowGeometry(request, {
      revision: request.revision, surfaceEpoch, platform: 'dom', outer, client, inner, viewport, actualZoom, scrollbars,
      scroll: { x, y, maxX, maxY },
      paintBox: rectangle(viewport.x + left - x, viewport.y + top - y, paintWidth, paintHeight),
    })
  } finally { try { menus.dispose() } finally { element.remove() } }
}
