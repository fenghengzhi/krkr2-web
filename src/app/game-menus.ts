import type { MenuSnapshot, MenuView } from '../engine/scene/menus.ts'

const caption = (text: string) =>
  text
    .split('\t', 1)[0]!
    .replace(/\(&[^)]\)/g, '')
    .replace(/&&|&/g, (marker) => (marker === '&&' ? '&' : ''))
const shortcut = (item: MenuView) => item.shortcut || item.caption.split('\t')[1] || ''

export function createGameMenus(
  container: HTMLElement,
  canvas: () => HTMLCanvasElement | null,
  choose: (id: number) => void,
  dismiss: () => void,
) {
  let current: MenuSnapshot = {},
    running = false,
    eventDisabled = false,
    dimensions = { width: 800, height: 600 }
  let overlay: HTMLDivElement | undefined
  let modal = false
  const select = (id: number) => {
    if (modal || !running || document.hidden || (eventDisabled && !current.popup)) return
    for (const details of container.querySelectorAll('details')) details.open = false
    choose(id)
  }
  const build = (items: MenuView[], enabled = true, popup = false): HTMLElement => {
    const group = document.createElement('div')
    group.className = 'game-menu-group'
    for (const item of items) {
      if (!item.visible) continue
      const active = !modal && enabled && item.enabled && running && (popup || !eventDisabled)
      if (item.caption === '-') {
        group.append(document.createElement('hr'))
        continue
      }
      if (item.children.length) {
        const details = document.createElement('details'),
          summary = document.createElement('summary')
        summary.textContent = caption(item.caption)
        summary.setAttribute('aria-disabled', String(!active))
        if (!active) summary.addEventListener('click', (event) => event.preventDefault())
        details.append(summary, build(item.children, active, popup))
        group.append(details)
      } else {
        const button = document.createElement('button')
        button.type = 'button'
        button.disabled = !active
        button.textContent = `${item.checked ? (item.radio ? '● ' : '✓ ') : ''}${caption(item.caption)}`
        if (item.checked || item.radio) button.setAttribute('aria-pressed', String(item.checked))
        const key = shortcut(item)
        if (key) {
          const hint = document.createElement('kbd')
          hint.textContent = key
          button.append(hint)
        }
        button.addEventListener('click', () => select(item.id))
        group.append(button)
      }
    }
    return group
  }
  const find = (item: MenuView | undefined, id: number): MenuView | undefined =>
    item?.id === id ? item : item?.children.map((child) => find(child, id)).find(Boolean)
  const render = () => {
    container.replaceChildren()
    const visible = current.root?.visible && current.root.children.some((item) => item.visible)
    container.hidden = !visible
    if (visible) container.append(build(current.root!.children, current.root!.enabled))
    overlay?.remove()
    overlay = undefined
    const popup = current.popup,
      menu = popup && find(current.root, popup.id)
    if (popup && menu) {
      overlay = document.createElement('div')
      overlay.className = 'game-menu-overlay'
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) dismiss()
      })
      const panel = build(menu.children, menu.enabled, true)
      panel.classList.add('game-menu-popup')
      panel.setAttribute('aria-label', caption(menu.caption))
      const bounds = canvas()?.getBoundingClientRect() ?? container.getBoundingClientRect()
      panel.style.left = `${Math.min(innerWidth - 20, Math.max(0, bounds.left + (popup.x * bounds.width) / dimensions.width))}px`
      panel.style.top = `${Math.min(innerHeight - 20, Math.max(0, bounds.top + (popup.y * bounds.height) / dimensions.height))}px`
      panel.style.transform = `translate(${popup.flags & 8 ? '-100%' : popup.flags & 4 ? '-50%' : '0'},${popup.flags & 32 ? '-100%' : popup.flags & 16 ? '-50%' : '0'})`
      overlay.append(panel)
      document.body.append(overlay)
      panel.querySelector('button')?.focus()
    }
  }
  const keydown = (event: KeyboardEvent) => {
    if (modal) return
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      for (const details of container.querySelectorAll('details')) details.open = false
      if (current.popup) {
        event.preventDefault()
        dismiss()
      }
      return
    }
    if (
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
    modal(active: boolean) {
      if (modal !== active) {
        modal = active
        render()
      }
    },
    update(menus: MenuSnapshot) {
      current = menus
      render()
    },
    state(active: boolean, width = 800, height = 600, disabled = false) {
      const changed = running !== active || eventDisabled !== disabled
      running = active
      eventDisabled = disabled
      dimensions = { width, height }
      if (changed) render()
    },
  }
}
