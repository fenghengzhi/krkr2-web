import { isHelpDocument, type HelpDocument } from '../engine/ports/help.ts'
import './game-help.css'

interface HelpView {
  readonly panel: HTMLElement
  readonly close: HTMLButtonElement
  readonly text: HTMLPreElement
  readonly events: AbortController
  readonly origin: HTMLElement | null
}

const canFocus = (element: HTMLElement) =>
  element.isConnected &&
  !element.closest('[inert], [hidden]') &&
  !element.matches(':disabled') &&
  element.getClientRects().length > 0 &&
  getComputedStyle(element).visibility === 'visible'

/** A session-owned, nonmodal readonly document. No script waits for its close button. */
export function createGameHelp(host: HTMLElement) {
  const document = host.ownerDocument
  let current: HelpView | undefined,
    disposed = false
  const owns = (view: HelpView, target: EventTarget | null) =>
    target instanceof Node && view.panel.isConnected && view.panel.contains(target)
  const remove = (view: HelpView, restore: boolean) => {
    const focused = owns(view, document.activeElement)
    view.events.abort()
    view.panel.remove()
    // Closing a help control can restore the focus it borrowed, but merely
    // showing a script-requested document never takes focus from the game.
    if (restore && focused && view.origin && canFocus(view.origin))
      view.origin.focus({ preventScroll: true })
  }
  const clear = (restore: boolean) => {
    const view = current
    if (!view) return
    current = undefined
    remove(view, restore)
  }
  const show = (content: HelpDocument | null): void => {
    if (content === null) {
      clear(false)
      return
    }
    if (disposed) throw new DOMException('Help presentation is closed', 'AbortError')
    if (!isHelpDocument(content)) throw new DOMException('Invalid help document', 'DataError')
    if (!host.isConnected || host.closest('[inert], [hidden]'))
      throw new DOMException('Help presentation is not visible', 'InvalidStateError')
    // A normal DOM panel cannot acknowledge visibility behind the browser's
    // modal top layer. Do not create a second modal scope to bypass this limit.
    if (document.querySelector('dialog:modal'))
      throw new DOMException('Help presentation is blocked by a modal dialog', 'InvalidStateError')
    const previous = current,
      focused = document.activeElement,
      ownedFocus = !!previous && owns(previous, focused),
      origin = ownedFocus
        ? previous!.origin
        : focused instanceof HTMLElement
          ? focused
          : null,
      panel = document.createElement('section'),
      heading = document.createElement('h2'),
      path = document.createElement('p'),
      text = document.createElement('pre'),
      close = document.createElement('button'),
      events = new AbortController(),
      view: HelpView = { panel, close, text, events, origin }
    panel.className = 'game-help'
    panel.setAttribute('role', 'region')
    panel.setAttribute('aria-label', '游戏帮助：' + content.title)
    heading.className = 'game-help-title'
    heading.textContent = content.title
    path.className = 'game-help-path'
    path.textContent = content.path
    text.className = 'game-help-text'
    text.textContent = content.text
    text.tabIndex = 0
    text.setAttribute('aria-label', '帮助正文')
    close.className = 'game-help-close'
    close.type = 'button'
    close.dataset.action = 'close'
    close.textContent = '关闭帮助'
    close.addEventListener('click', () => {
      if (!disposed && current === view) clear(true)
    }, { signal: events.signal })
    panel.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        if (!disposed && current === view) clear(true)
      }
    }, { signal: events.signal })
    panel.addEventListener('keyup', (event) => event.stopPropagation(), { signal: events.signal })
    panel.append(heading, path, text, close)
    clear(false)
    current = view
    try {
      host.append(panel)
      if (disposed || current !== view)
        throw new DOMException('Help presentation was retired while opening', 'AbortError')
      if (
        !panel.isConnected ||
        panel.closest('[inert], [hidden]') ||
        panel.getClientRects().length === 0 ||
        getComputedStyle(panel).visibility !== 'visible'
      )
        throw new DOMException('Help presentation is not visible', 'InvalidStateError')
      // Showing a document should reveal it without taking keyboard focus.
      // A fullscreen surface uses the fixed CSS presentation instead.
      panel.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      if (ownedFocus) {
        const target = previous && focused === previous.close ? close : text
        target.focus({ preventScroll: true })
      }
    } catch (error) {
      if (current === view) current = undefined
      remove(view, false)
      throw error
    }
  }
  return {
    show,
    ownsFocus(target: EventTarget | null): boolean {
      return !disposed && !!current && owns(current, target)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      clear(false)
    },
  }
}
