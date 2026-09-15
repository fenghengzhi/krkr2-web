import type { MenuPopupIdentity, MenuSnapshot, MenuView } from '../engine/scene/menus.ts'

const caption = (text: string) =>
  text
    .split('\t', 1)[0]!
    .replace(/\(&[^)]\)/g, '')
    .replace(/&&|&/g, (marker) => (marker === '&&' ? '&' : ''))
const shortcut = (item: MenuView) => item.shortcut || item.caption.split('\t')[1] || ''
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
  choose: (id: number, popup?: MenuPopupIdentity) => void,
  dismiss: (popup?: MenuPopupIdentity) => void,
  options: { active?: () => boolean } = {},
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
  const select = (id: number) => {
    if (disposed || modal || !running || document.hidden || (eventDisabled && !current.popup))
      return
    for (const details of container.querySelectorAll('details')) details.open = false
    choose(id, current.popup)
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
        const key = shortcut(item)
        const hint = button.lastElementChild as HTMLElement
        hint.hidden = !key
        text(hint, key)
      }
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
  const render = () => {
    if (disposed) return
    const visible = current.root?.visible && current.root.children.some((item) => item.visible)
    container.hidden = !visible
    build(bar, visible ? current.root!.children : [], current.root?.enabled)
    const popup = current.popup,
      menu = popup && find(current.root, popup.id)
    if (!modal && popup && menu) {
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
      const bounds = canvas()?.getBoundingClientRect() ?? container.getBoundingClientRect()
      panel.style.left = `${Math.min(innerWidth - 20, Math.max(0, bounds.left + (popup.x * bounds.width) / dimensions.width))}px`
      panel.style.top = `${Math.min(innerHeight - 20, Math.max(0, bounds.top + (popup.y * bounds.height) / dimensions.height))}px`
      panel.style.transform = `translate(${popup.flags & 8 ? '-100%' : popup.flags & 4 ? '-50%' : '0'},${popup.flags & 32 ? '-100%' : popup.flags & 16 ? '-50%' : '0'})`
      if (fresh) panel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    } else {
      // A child modal owns focus. Its parent's popup may still be unwinding
      // in the engine, but must no longer cover or cancel the child in the DOM.
      removePopup(!modal)
    }
  }
  const keydown = (event: KeyboardEvent) => {
    if (disposed || modal) return
    if (event.target instanceof Element && event.target.closest('.game-clipboard')) return
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      // A script can show a popup on a window which did not own keyboard
      // activation. Its blocking request must still accept cancellation.
      if (!current.popup && options.active?.() === false) return
      for (const details of container.querySelectorAll('details')) details.open = false
      if (current.popup) {
        event.preventDefault()
        dismiss(current.popup)
      }
      return
    }
    if (
      options.active?.() === false ||
      !running ||
      document.hidden ||
      eventDisabled ||
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
      const parts = shortcut(item).toLowerCase().split('+')
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
    const item = current.root && visit(current.root)
    if (item) {
      event.preventDefault()
      select(item.id)
    }
  }
  window.addEventListener('keydown', keydown, { capture: true })
  return {
    dispose() {
      if (disposed) return
      disposed = true
      window.removeEventListener('keydown', keydown, { capture: true })
      container.replaceChildren()
      container.hidden = true
      removePopup()
      const popup = current.popup
      current = {}
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
