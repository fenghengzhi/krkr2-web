import type { MenuPopupIdentity, MenuSnapshot, MenuView } from '../engine/scene/menus.ts'
import type { WindowView } from '../engine/scene/window.ts'
import { menuAccessMatch } from './menu-access.ts'

const caption = (text: string) =>
  text
    .split('\t', 1)[0]!
    .replace(/\(&[^)]\)/g, '')
    .replace(/&&|&/g, (marker) => (marker === '&&' ? '&' : ''))
const shortcutHint = (item: MenuView) => item.shortcut || item.caption.split('\t')[1] || ''
// A snapshot can replace a popup with one from another Window before its old
// component renders. Preserve the external focus target across that handoff.
const popupFocusOrigins = new WeakMap<HTMLElement, HTMLElement | null>()
const popupFocusOrigin = (element: Element | null): HTMLElement | null => {
  if (!(element instanceof HTMLElement)) return null
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const previous = popupFocusOrigins.get(ancestor)
    if (previous !== undefined) return previous
  }
  return element
}
const canRestoreFocus = (element: HTMLElement) =>
  element.isConnected &&
  !element.closest('[inert], [hidden], [aria-disabled="true"]') &&
  !element.matches(':disabled') &&
  element.getClientRects().length > 0 &&
  getComputedStyle(element).visibility === 'visible'

export function createGameMenus(
  container: HTMLElement,
  canvas: () => HTMLCanvasElement | null,
  choose: (id: number, popup?: MenuPopupIdentity, shortcutEvent?: KeyboardEvent) => void,
  dismiss: (popup?: MenuPopupIdentity) => void,
  options: { active?: () => boolean; windowView?: () => WindowView | undefined;
    /** Actual presented menu loop, independent of Window.mouseCursorState. */
    opened?: (opened: boolean) => void } = {},
) {
  let current: MenuSnapshot = {},
    running = false,
    eventDisabled = false,
    dimensions = { width: 800, height: 600 }
  let overlay: HTMLDivElement | undefined
  let popupPanel: HTMLElement | undefined
  let popupRequest: number | undefined
  let modal = false
  let disposed = false
  let menuOpened = false
  let barFocus: HTMLElement | null | undefined
  const itemViews = new WeakMap<HTMLElement, MenuView>()
  const rememberBarFocus = () => {
    if (!container.contains(document.activeElement)) barFocus = popupFocusOrigin(document.activeElement)
  }
  const publishOpened = () => {
    const expanded = !container.hidden && [...container.querySelectorAll('details[open]')].some((node) => {
      for (let parent = node.parentElement; parent && parent !== container; parent = parent.parentElement)
        if (parent instanceof HTMLDetailsElement && !parent.open) return false
      return true
    }), next = !disposed && !modal && running && !document.hidden &&
      (!!overlay || (!eventDisabled && (expanded || (barFocus !== undefined && container.contains(document.activeElement)))))
    if (next === menuOpened) return
    menuOpened = next
    options.opened?.(next)
  }
  // toggle does not bubble. Capturing it observes native pointer/keyboard
  // details activation as well as nested and programmatic open changes.
  container.addEventListener('toggle', publishOpened, true)
  container.addEventListener('pointerdown', rememberBarFocus, true)
  const closeBar = (restore = true) => {
    const inside = container.contains(document.activeElement), previous = barFocus
    for (const details of container.querySelectorAll('details')) details.open = false
    barFocus = undefined
    publishOpened()
    if (restore && inside && previous && canRestoreFocus(previous)) previous.focus({ preventScroll: true })
  }
  const removePopup = (restoreFocus = true) => {
    const previous = overlay && popupFocusOrigins.get(overlay),
      restore = restoreFocus && overlay?.contains(document.activeElement)
    if (overlay) {
      popupFocusOrigins.delete(overlay)
      overlay.remove()
    }
    overlay = undefined
    popupPanel = undefined
    popupRequest = undefined
    if (restore && previous && canRestoreFocus(previous)) previous.focus({ preventScroll: true })
  }
  const select = (id: number, shortcutEvent?: KeyboardEvent) => {
    if (disposed || modal || !running || document.hidden || (eventDisabled && !current.popup))
      return
    closeBar()
    choose(id, current.popup, shortcutEvent)
  }
  // A snapshot can arrive while a menu is open or a pointer is held down.
  // Keep each item's DOM node so updates preserve focus and pending clicks.
  const groups = new WeakMap<HTMLElement, Map<number, HTMLElement>>()
  const groupElement = () => {
    const group = document.createElement('div')
    group.className = 'game-menu-group'
    return group
  }
  const text = (element: Element, value: string) => {
    if (element.textContent !== value) element.textContent = value
  }
  const build = (
    group: HTMLElement,
    items: MenuView[],
    enabled = true,
    popup?: MenuPopupIdentity,
  ) => {
    let nodes = groups.get(group)
    if (!nodes) groups.set(group, (nodes = new Map()))
    const visible = new Set<number>()
    let index = 0
    for (const item of items) {
      if (!item.visible) continue
      visible.add(item.id)
      const active = !modal && enabled && item.enabled && running && (!!popup || !eventDisabled)
      const kind = item.caption === '-' ? 'HR' : item.children.length ? 'DETAILS' : 'BUTTON'
      let node = nodes.get(item.id)
      if (node?.tagName !== kind) {
        node?.remove()
        node = document.createElement(kind.toLowerCase())
        nodes.set(item.id, node)
        if (kind === 'DETAILS') {
          const summary = document.createElement('summary')
          summary.addEventListener('click', (event) => {
            if (summary.getAttribute('aria-disabled') === 'true') event.preventDefault()
          })
          node.append(summary, groupElement())
        } else if (kind === 'BUTTON') {
          ;(node as HTMLButtonElement).type = 'button'
          node.append(document.createElement('span'), document.createElement('kbd'))
          node.addEventListener('click', (event) => {
            // Removed popup panels and retired windows may still have queued
            // browser events or external element references. A retired panel
            // must not select against a replacement request, even if reattached.
            const target = event.currentTarget as HTMLElement
            if (!target.isConnected || nodes?.get(item.id) !== target) return
            if (
              popup
                ? current.popup?.requestId !== popup.requestId ||
                  current.popup?.windowId !== popup.windowId ||
                  !popupPanel?.contains(target)
                : !container.contains(target)
            )
              return
            select(item.id)
          })
        }
      }
      if (kind === 'DETAILS') {
        const details = node as HTMLDetailsElement,
          summary = details.firstElementChild!
        text(summary, caption(item.caption))
        summary.setAttribute('aria-disabled', String(!active))
        if (!active) details.open = false
        build(details.lastElementChild as HTMLElement, item.children, active, popup)
      } else if (kind === 'BUTTON') {
        const button = node as HTMLButtonElement
        button.disabled = !active
        text(
          button.firstElementChild!,
          `${item.checked ? (item.radio ? '● ' : '✓ ') : ''}${caption(item.caption)}`,
        )
        if (item.checked || item.radio) button.setAttribute('aria-pressed', String(item.checked))
        else button.removeAttribute('aria-pressed')
        const key = shortcutHint(item)
        const hint = button.lastElementChild as HTMLElement
        hint.hidden = !key
        text(hint, key)
      }
      itemViews.set(node, item)
      if (group.children[index] !== node) group.insertBefore(node, group.children[index] ?? null)
      index++
    }
    for (const [id, node] of nodes) {
      if (visible.has(id)) continue
      node.remove()
      nodes.delete(id)
    }
  }
  const find = (item: MenuView | undefined, id: number): MenuView | undefined =>
    item?.id === id ? item : item?.children.map((child) => find(child, id)).find(Boolean)
  const bar = groupElement()
  const windowId = canvas()?.dataset.windowId
  if (windowId !== undefined) container.dataset.windowId = windowId
  container.replaceChildren(bar)
  const control = (node: HTMLElement): HTMLElement => node instanceof HTMLDetailsElement
    ? node.firstElementChild as HTMLElement : node
  const entries = (group: HTMLElement): HTMLElement[] => [...group.children].filter((node): node is HTMLElement =>
    node instanceof HTMLElement && (node instanceof HTMLDetailsElement
      ? node.firstElementChild?.getAttribute('aria-disabled') === 'false'
      : node instanceof HTMLButtonElement && !node.disabled))
  const focus = (node: HTMLElement) => control(node).focus({ preventScroll: true })
  const enter = (node: HTMLElement, last = false) => {
    if (!(node instanceof HTMLDetailsElement)) { focus(node); return }
    for (const sibling of node.parentElement?.children ?? [])
      if (sibling instanceof HTMLDetailsElement && sibling !== node) sibling.open = false
    node.open = true; publishOpened()
    const children = entries(node.lastElementChild as HTMLElement)
    focus((last ? children.at(-1) : children[0]) ?? node)
  }
  const activate = (node: HTMLElement, event: KeyboardEvent) => {
    if (node instanceof HTMLDetailsElement) enter(node)
    else {
      const item = itemViews.get(node)
      if (item) select(item.id, event)
    }
  }
  const focusedItem = (): HTMLElement | undefined => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || (!container.contains(active) && !popupPanel?.contains(active))) return
    if (active instanceof HTMLButtonElement) return active
    if (active.tagName === 'SUMMARY' && active.parentElement instanceof HTMLDetailsElement) return active.parentElement
  }
  const render = () => {
    if (disposed) return
    const visible = current.root?.visible && current.root.children.some((item) => item.visible)
    container.hidden = !visible
    build(bar, visible ? current.root!.children : [], current.root?.enabled)
    const popup = current.popup,
      menu = popup && find(current.root, popup.id)
    if (running && !modal && popup && menu) {
      const fresh = !overlay || popupRequest !== popup.requestId
      if (fresh) {
        const previous = popupFocusOrigin(document.activeElement)
        removePopup(false)
        overlay = document.createElement('div')
        popupFocusOrigins.set(overlay, previous)
        overlay.className = 'game-menu-overlay'
        overlay.dataset.windowId = String(popup.windowId)
        overlay.dataset.requestId = String(popup.requestId)
        const element = overlay
        overlay.addEventListener('click', (event) => {
          if (
            !disposed &&
            !modal &&
            overlay === element &&
            element.isConnected &&
            event.target === element
          )
            dismiss(popup)
        })
        popupRequest = popup.requestId
        popupPanel = groupElement()
        popupPanel.classList.add('game-menu-popup')
        overlay.append(popupPanel)
        document.body.append(overlay)
      }
      const panel = popupPanel!
      build(panel, menu.children, menu.enabled, popup)
      panel.setAttribute('aria-label', caption(menu.caption))
      const bounds = canvas()?.getBoundingClientRect() ?? container.getBoundingClientRect(),
        view = options.windowView?.(), geometry = view?.geometry,
        outer = container.closest<HTMLElement>('.game-window')?.getBoundingClientRect()
      let x = bounds.left + popup.x * bounds.width / Math.max(1, dimensions.width),
        y = bounds.top + popup.y * bounds.height / Math.max(1, dimensions.height)
      if (geometry?.platform === 'dom' && outer) {
        const sx = outer.width / geometry.outer.width, sy = outer.height / geometry.outer.height
        // KRKR2's windowed popup receives Form client coordinates, independent
        // of sunken borders, PaintBox origin and scroll. Fullscreen instead has
        // a separate native menu-owner Form; this page uses its visible menu
        // container as the corresponding host origin (not a Win32 clamp claim).
        if (view?.fullScreen && !container.hidden) {
          const owner = container.getBoundingClientRect()
          x = owner.left + (container.clientLeft + popup.x) * sx
          y = owner.top + (container.clientTop + popup.y) * sy
        } else {
          x = outer.left + (geometry.client.x + popup.x) * sx
          y = outer.top + (geometry.client.y + popup.y) * sy
        }
      }
      panel.style.left = `${Math.min(innerWidth - 20, Math.max(0, x))}px`
      panel.style.top = `${Math.min(innerHeight - 20, Math.max(0, y))}px`
      panel.style.transform = `translate(${popup.flags & 8 ? '-100%' : popup.flags & 4 ? '-50%' : '0'},${popup.flags & 32 ? '-100%' : popup.flags & 16 ? '-50%' : '0'})`
      if (fresh) panel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    } else {
      // A child modal owns focus. Its parent's popup may still be unwinding
      // in the engine, but must no longer cover or cancel the child in the DOM.
      removePopup(!modal)
    }
    if (!visible || !running || eventDisabled || modal) closeBar(!modal)
    publishOpened()
  }
  const keydown = (event: KeyboardEvent) => {
    if (disposed || modal) return
    if (event.target instanceof Element && event.target.closest('.game-clipboard, .game-help'))
      return
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    const popupTarget = event.target instanceof Node && !!popupPanel?.contains(event.target),
      barTarget = event.target instanceof Node && container.contains(event.target),
      gameTarget = event.target === canvas() || (event.target instanceof HTMLTextAreaElement &&
        event.target.classList.contains('game-text-input') && event.target.parentElement === canvas()?.parentElement)
    if (event.key === 'Escape') {
      // A script can show a popup on a window which did not own keyboard
      // activation. Its blocking request must still accept cancellation.
      if (!current.popup && (options.active?.() === false || (!gameTarget && !barTarget))) return
      const node = focusedItem(), parent = node?.parentElement?.parentElement
      if (parent instanceof HTMLDetailsElement) {
        event.preventDefault(); parent.open = false; focus(parent); publishOpened(); return
      }
      const owned = !!node || [...container.querySelectorAll('details')].some((item) => item.open)
      closeBar()
      if (owned) event.preventDefault()
      if (current.popup) {
        event.preventDefault()
        dismiss(current.popup)
      }
      return
    }
    if (
      (options.active?.() === false && !popupTarget) ||
      !running ||
      document.hidden ||
      (eventDisabled && !popupTarget) ||
      event.target instanceof HTMLInputElement ||
      (event.target instanceof HTMLTextAreaElement &&
        !(
          event.target.classList.contains('game-text-input') &&
          event.target.parentElement === canvas()?.parentElement
        )) ||
      (event.target instanceof HTMLElement && event.target.isContentEditable)
    )
      return
    const matches = (item: MenuView): boolean => {
      // Caption text after a tab is a display hint. In particular, setting
      // MenuItem.shortcut="" must disable the command even if that hint stays.
      const parts = item.shortcut.toLowerCase().split('+')
      const key = parts.pop()
      return (
        !!key &&
        key === event.key.toLowerCase() &&
        parts.includes('ctrl') === event.ctrlKey &&
        parts.includes('shift') === event.shiftKey &&
        parts.includes('alt') === event.altKey &&
        !event.metaKey
      )
    }
    const visit = (item: MenuView): MenuView | undefined => {
      if (!item.enabled || !item.visible) return
      if (!item.children.length && matches(item)) return item
      return item.children.map(visit).find(Boolean)
    }
    const shortcutRoot = current.popup ? find(current.root, current.popup.id) : current.root,
      item = shortcutRoot && visit(shortcutRoot)
    if (item) {
      event.preventDefault()
      select(item.id, event)
      return
    }
    // Win32/VCL captions declare access keys independently of shortcuts.
    // Ctrl+Alt (including AltGr), composition and host text fields retain
    // their ordinary input route; no browser accesskey attribute is installed.
    if (event.ctrlKey || event.metaKey || event.getModifierState('AltGraph')) return
    if (!gameTarget && !popupTarget && !barTarget) return
    if (!current.popup && event.altKey && event.key.length === 1 && current.root?.visible && current.root.enabled) {
      const top = entries(bar)
      let currentTop = focusedItem()
      while (currentTop && currentTop.parentElement !== bar) {
        const parent = currentTop.parentElement?.parentElement
        currentTop = parent instanceof HTMLDetailsElement ? parent : undefined
      }
      const match = menuAccessMatch(top.map((node) => itemViews.get(node)!.caption), event.key, top.indexOf(currentTop!))
      if (!match) return
      event.preventDefault(); rememberBarFocus()
      const node = top[match.index]!
      if (match.unique) activate(node, event); else focus(node)
      publishOpened()
      return
    }
    if (event.altKey || event.shiftKey) return
    let node = focusedItem()
    if (!current.popup && event.key === 'F10' && current.root?.visible && current.root.enabled && entries(bar).length) {
      event.preventDefault()
      if (node) closeBar()
      else { rememberBarFocus(); focus(entries(bar)[0]!); publishOpened() }
      return
    }
    if (!node) return
    const group = node.parentElement!, siblings = entries(group), index = siblings.indexOf(node), topLevel = group === bar
    if (index < 0) return
    const move = (step: number) => focus(siblings[(index + step + siblings.length) % siblings.length]!)
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(node, event); return }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); focus((event.key === 'Home' ? siblings[0] : siblings.at(-1))!); return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      if (topLevel) enter(node, event.key === 'ArrowUp')
      else move(event.key === 'ArrowUp' ? -1 : 1)
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      if (event.key === 'ArrowRight' && !topLevel && node instanceof HTMLDetailsElement) { enter(node); return }
      const parent = group.parentElement
      if (!topLevel && parent instanceof HTMLDetailsElement && parent.parentElement !== bar) {
        if (event.key === 'ArrowLeft') { parent.open = false; focus(parent); publishOpened() }
        return
      }
      const top = entries(bar), currentTop = topLevel ? node : parent,
        at = top.findIndex((item) => item === currentTop)
      if (at >= 0) {
        const next = top[(at + (event.key === 'ArrowLeft' ? -1 : 1) + top.length) % top.length]!
        if (topLevel) focus(next); else enter(next)
      }
      return
    }
    if (event.key.length === 1) {
      const match = menuAccessMatch(siblings.map((item) => itemViews.get(item)!.caption), event.key, index)
      if (!match) return
      event.preventDefault(); node = siblings[match.index]!
      if (match.unique) activate(node, event); else focus(node)
    }
  }
  window.addEventListener('keydown', keydown, { capture: true })
  return {
    dispose() {
      if (disposed) return
      disposed = true
      window.removeEventListener('keydown', keydown, { capture: true })
      container.removeEventListener('toggle', publishOpened, true)
      container.removeEventListener('pointerdown', rememberBarFocus, true)
      closeBar(false)
      container.replaceChildren()
      container.hidden = true
      removePopup()
      const popup = current.popup
      current = {}
      publishOpened()
      if (popup) dismiss(popup)
    },
    modal(active: boolean) {
      if (disposed) return
      if (modal !== active) {
        modal = active
        render()
      }
    },
    update(menus: MenuSnapshot) {
      if (disposed) return
      current = menus
      render()
    },
    state(active: boolean, width = 800, height = 600, disabled = false) {
      if (disposed) return
      const changed = running !== active || eventDisabled !== disabled
      running = active
      eventDisabled = disabled
      dimensions = { width, height }
      if (changed || current.popup) render()
    },
  }
}
