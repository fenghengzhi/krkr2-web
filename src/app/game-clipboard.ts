import { BrowserClipboard } from '../backends/clipboard/browser.ts'
import type { ClipboardError, ClipboardPort } from '../engine/ports/clipboard.ts'
import { assertClipboardText } from '../engine/ports/clipboard.ts'
import type { ClipboardRequest, ClipboardResponse, ClipboardResult } from '../protocol/clipboard.ts'
import { isClipboardRequestShape } from '../protocol/clipboard.ts'
import './game-clipboard.css'

interface ClipboardActions {
  complete(response: ClipboardResponse): boolean | void
  stop(): void | Promise<void>
  /** Gate the containing native dialog while its script waits for this request. */
  pending?(active: boolean): void
}

interface ClipboardView {
  readonly request: ClipboardRequest
  readonly panel: HTMLElement
  readonly status: HTMLElement
  readonly buttons: HTMLElement
  readonly perform: HTMLButtonElement
  readonly cancel: HTMLButtonElement
  readonly stop: HTMLButtonElement
  readonly origin: HTMLElement | null
  readonly abort: AbortController
  started: boolean
  settled: boolean
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  return node
}

const canFocus = (node: HTMLElement) =>
  node.isConnected &&
  !node.closest('[inert], [hidden], [aria-disabled="true"]') &&
  !node.matches(':disabled') &&
  node.getClientRects().length > 0 &&
  getComputedStyle(node).visibility === 'visible'

const errorDetails = (reason: unknown): ClipboardError => {
  let details: ClipboardError | undefined
  if (reason && typeof reason === 'object') {
    const error = reason as { name?: unknown; message?: unknown }
    if (typeof error.name === 'string' && typeof error.message === 'string')
      details = { name: error.name, message: error.message }
  }
  details ??= { name: 'Error', message: String(reason) }
  try {
    assertClipboardText(details.name)
    assertClipboardText(details.message)
    return details
  } catch {
    return {
      name: 'QuotaExceededError',
      message: 'Clipboard error description exceeds the text limit',
    }
  }
}

/** Explicit user actions for clipboard access; this host never opens a modal scope. */
export function createGameClipboard(
  actions: ClipboardActions,
  adapter: ClipboardPort = new BrowserClipboard(),
) {
  let current: ClipboardView | undefined,
    notice: ClipboardView | undefined,
    disposed = false,
    stopping = false,
    adapterClosed = false,
    pending = false,
    generation: number | undefined,
    highestId = 0
  const modals: HTMLDialogElement[] = []
  const events = new AbortController()
  const setPending = (value: boolean): unknown[] => {
    if (pending === value) return []
    pending = value
    try {
      actions.pending?.(value)
      return []
    } catch (error) {
      return [error]
    }
  }
  const closeAdapter = () => {
    if (adapterClosed) return
    adapterClosed = true
    adapter.close()
  }
  const live = (view: ClipboardView) => !disposed && !stopping && current === view && !view.settled
  const placementHost = () => {
    // :modal reflects the actual browser top layer, unlike an [open] dialog
    // which may be nonmodal. Retain admission order when several are live.
    const active = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')]
    for (let i = modals.length - 1; i >= 0; i--)
      if (!active.includes(modals[i]!)) modals.splice(i, 1)
    for (const modal of active) if (!modals.includes(modal)) modals.push(modal)
    // On initial admission, DOM order alone cannot tell the order in which
    // already-open dialogs entered the top layer. Its focus identifies the
    // current interactive dialog; browser-inert lower dialogs cannot own it.
    const focused = document.activeElement?.closest<HTMLDialogElement>('dialog:modal')
    if (focused && active.includes(focused)) {
      modals.splice(modals.indexOf(focused), 1)
      modals.push(focused)
    }
    return modals.at(-1) ?? document.body
  }
  const canAct = (view: ClipboardView) =>
    live(view) &&
    view.panel.isConnected &&
    view.panel.parentElement === placementHost() &&
    !view.panel.closest('[inert], [hidden]')

  const refreshPlacement = () => {
    if (disposed) return
    const host = placementHost()
    for (const view of [current, notice]) {
      if (!view || view.panel.parentElement === host) continue
      const focused = document.activeElement,
        owned = focused instanceof HTMLElement && view.panel.contains(focused)
      host.append(view.panel)
      // Moving the same panel into a changed top layer must not lose an edit
      // or a keyboard user's place. Never focus it merely because it appeared.
      if (owned && canFocus(focused)) focused.focus({ preventScroll: true })
    }
  }
  const observer = new MutationObserver(refreshPlacement)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  })
  document.addEventListener('focusin', refreshPlacement, { signal: events.signal })

  const remove = (view: ClipboardView, restore: boolean) => {
    const focused = document.activeElement,
      owned = focused instanceof HTMLElement && view.panel.contains(focused)
    view.abort.abort()
    view.panel.remove()
    const host = placementHost()
    if (
      restore &&
      owned &&
      view.origin &&
      (host === document.body || host.contains(view.origin)) &&
      canFocus(view.origin)
    )
      view.origin.focus({ preventScroll: true })
  }
  const clearNotice = (restore = false) => {
    if (!notice) return
    const old = notice
    notice = undefined
    remove(old, restore)
  }
  const retire = (restore: boolean) => {
    if (!current) return
    const old = current
    current = undefined
    old.settled = true
    setPending(false)
    remove(old, restore)
  }
  const showError = (view: ClipboardView, error: ClipboardError) => {
    if (notice !== view) clearNotice()
    notice = view
    view.panel.dataset.state = 'error'
    view.panel.setAttribute('aria-busy', 'false')
    view.status.textContent = `${error.name}: ${error.message}`
    if (view.started && view.request.op === 'write-text')
      view.status.textContent += ' 已发出的写入无法撤回，剪贴板内容仍可能改变。'
    const close = element('button', '关闭提示')
    close.type = 'button'
    close.dataset.action = 'close'
    close.addEventListener('click', () => clearNotice(true), { signal: view.abort.signal })
    const focused = document.activeElement,
      owned = focused instanceof HTMLElement && view.buttons.contains(focused)
    view.buttons.replaceChildren(close)
    refreshPlacement()
    if (owned && canFocus(close)) close.focus({ preventScroll: true })
  }
  const finish = (view: ClipboardView, response: ClipboardResponse) => {
    if (!live(view)) return
    view.settled = true
    if (!response.ok) showError(view, response.error)
    const errors = setPending(false)
    if (disposed || current !== view) return
    current = undefined
    if (errors.length && response.ok) showError(view, errorDetails(errors[0]))
    let accepted: boolean | void = undefined
    try {
      accepted = actions.complete(response)
    } catch (reason) {
      if (!disposed && !current && highestId === view.request.id && !view.abort.signal.aborted)
        showError(view, errorDetails(reason))
    } finally {
      // complete may synchronously retire or dispose this host, or show a new
      // request. Its return must never resurrect this view or steal new focus.
      if (disposed || current || highestId !== view.request.id || accepted === false) {
        if (notice === view) notice = undefined
        remove(view, !disposed && !current)
      } else if (notice !== view) remove(view, true)
    }
  }
  const fail = (view: ClipboardView, reason: unknown) =>
    finish(view, {
      generation: view.request.generation,
      id: view.request.id,
      ok: false,
      error: errorDetails(reason),
    })

  const perform = (view: ClipboardView) => {
    if (!canAct(view) || view.started) return
    view.started = true
    const owned = document.activeElement === view.perform
    view.perform.disabled = true
    if (owned && canFocus(view.cancel)) view.cancel.focus({ preventScroll: true })
    view.panel.dataset.state = 'running'
    view.panel.setAttribute('aria-busy', 'true')
    view.status.textContent =
      view.request.op === 'write-text'
        ? '正在写入剪贴板…已发出的写入无法撤回。'
        : '正在读取剪贴板…如浏览器提示粘贴，请在提示中继续。'
    if (!canAct(view)) {
      if (live(view)) {
        view.started = false
        view.perform.disabled = false
        view.panel.dataset.state = 'waiting'
        view.panel.setAttribute('aria-busy', 'false')
        view.status.textContent = '请选择操作。每次请求都需要你的点击。'
      }
      return
    }
    let work: Promise<ClipboardResult>
    try {
      // Do not await a Worker round trip or another permission API here. The
      // platform call must start synchronously in this actual click handler.
      work =
        view.request.op === 'has-text'
          ? adapter.hasText().then((hasText) => ({ op: 'has-text', hasText }))
          : view.request.op === 'read-text'
            ? adapter.readText().then((content) => ({ op: 'read-text', content }))
            : adapter.writeText(view.request.text).then(() => ({ op: 'write-text' }))
    } catch (reason) {
      fail(view, reason)
      return
    }
    void work.then(
      (result) =>
        finish(view, {
          generation: view.request.generation,
          id: view.request.id,
          ok: true,
          result,
        }),
      (reason) => fail(view, reason),
    )
  }
  const cancel = (view: ClipboardView) => {
    if (!canAct(view)) return
    fail(view, new DOMException('Clipboard request cancelled by the user', 'AbortError'))
  }
  const stop = (view: ClipboardView) => {
    if (!canAct(view)) return
    stopping = true
    retire(false)
    clearNotice()
    const errors: unknown[] = []
    try {
      closeAdapter()
    } catch (error) {
      errors.push(error)
    }
    const failed = (reason: unknown) => {
      if (disposed) return
      // The request's listeners were retired before Stop. A cleanup failure
      // gets an independent, close-only notice; it cannot revive that request.
      const result = create(view.request)
      result.started = view.started
      result.settled = true
      showError(result, errorDetails(reason))
    }
    try {
      void Promise.resolve(actions.stop()).then(
        () => {
          if (errors.length) failed(errors[0])
        },
        (reason) =>
          failed(
            errors.length
              ? new AggregateError([...errors, reason], 'Clipboard cleanup failed')
              : reason,
          ),
      )
    } catch (reason) {
      failed(reason)
    }
  }
  const create = (request: ClipboardRequest, includePreview = true): ClipboardView => {
    const panel = element('section'),
      heading = element('h2', '游戏请求使用剪贴板'),
      prompt = element(
        'p',
        request.op === 'write-text'
          ? '复制会用游戏提供的文本替换剪贴板内容。'
          : request.op === 'has-text'
            ? '检查剪贴板是否包含纯文本。此操作需要浏览器读取权限。'
            : '读取剪贴板中的纯文本，并将内容交给当前游戏。',
      ),
      status = element('p'),
      buttons = element('div'),
      performButton = element(
        'button',
        request.op === 'write-text'
          ? '复制文本'
          : request.op === 'has-text'
            ? '检查文本格式'
            : '读取剪贴板',
      ),
      cancelButton = element('button', '取消'),
      stopButton = element('button', '停止游戏'),
      abort = new AbortController()
    panel.className = 'game-clipboard'
    panel.dataset.requestId = String(request.id)
    panel.dataset.generation = String(request.generation)
    panel.dataset.operation = request.op
    panel.dataset.state = 'waiting'
    panel.setAttribute('role', 'region')
    panel.setAttribute('aria-label', '游戏剪贴板请求')
    status.className = 'game-clipboard-status'
    status.setAttribute('role', 'status')
    status.textContent = '请选择操作。每次请求都需要你的点击。'
    buttons.className = 'game-clipboard-actions'
    for (const [button, action] of [
      [performButton, 'perform'],
      [cancelButton, 'cancel'],
      [stopButton, 'stop'],
    ] as const) {
      button.type = 'button'
      button.dataset.action = action
    }
    const view: ClipboardView = {
      request: { ...request },
      panel,
      status,
      buttons,
      perform: performButton,
      cancel: cancelButton,
      stop: stopButton,
      origin: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      abort,
      started: false,
      settled: false,
    }
    panel.append(heading, prompt)
    if (includePreview && request.op === 'write-text') {
      const limit = 2000,
        length = request.text.length
      const preview = element('details'),
        summary = element('summary', `查看将要复制的文本（共 ${length} 个 UTF-16 单位）`),
        note = element(
          'p',
          length > limit
            ? `仅预览前 ${limit} 个 UTF-16 单位；复制仍使用完整文本。`
            : '已显示全部文本。',
        ),
        text = element('pre', request.text.slice(0, limit))
      note.className = 'game-clipboard-preview-note'
      text.className = 'game-clipboard-preview'
      preview.append(summary, note, text)
      panel.append(preview)
    }
    buttons.append(stopButton, cancelButton, performButton)
    panel.append(status, buttons)
    performButton.addEventListener('click', () => perform(view), { signal: abort.signal })
    cancelButton.addEventListener('click', () => cancel(view), { signal: abort.signal })
    stopButton.addEventListener('click', () => stop(view), { signal: abort.signal })
    panel.addEventListener(
      'keydown',
      (event) => {
        event.stopPropagation()
        if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault()
          if (live(view)) cancel(view)
          else if (notice === view) clearNotice(true)
        }
      },
      { signal: abort.signal },
    )
    panel.addEventListener('keyup', (event) => event.stopPropagation(), { signal: abort.signal })
    return view
  }

  return {
    show(request: ClipboardRequest | null) {
      if (disposed || stopping) return
      if (!request) {
        retire(true)
        return
      }
      if (!isClipboardRequestShape(request)) return
      if (generation !== undefined && request.generation !== generation) return
      if (request.id <= highestId) return
      generation = request.generation
      highestId = request.id
      retire(false)
      clearNotice()
      if (request.op === 'write-text') {
        try {
          assertClipboardText(request.text)
        } catch (error) {
          // Retain only this failed request's identity, not an oversized text
          // payload. No action can execute once fail replaces its controls.
          current = create({ ...request, text: '' }, false)
          fail(current, error)
          return
        }
      }
      current = create(request)
      refreshPlacement()
      const view = current,
        errors = setPending(true)
      if (errors.length) fail(view, errors[0])
    },
    ownsFocus(target: EventTarget | null) {
      return (
        !disposed &&
        target instanceof Node &&
        !![current, notice].find((view) => view?.panel.isConnected && view.panel.contains(target))
      )
    },
    refreshPlacement,
    dispose() {
      if (disposed) return
      disposed = true
      observer.disconnect()
      events.abort()
      retire(false)
      clearNotice()
      modals.length = 0
      closeAdapter()
    },
  }
}
