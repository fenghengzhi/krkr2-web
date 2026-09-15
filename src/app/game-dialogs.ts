import type { SystemDialogRequest } from '../engine/ports/system-dialogs.ts'

interface DialogActions {
  choose(id: number, value: string | null): Promise<unknown> | undefined
  stop(): Promise<void>
}

interface DialogView {
  request: SystemDialogRequest
  dialog: HTMLDialogElement
  heading: HTMLHeadingElement
  prompt: HTMLParagraphElement
  input?: HTMLInputElement
  status: HTMLParagraphElement
  confirm: HTMLButtonElement
  cancel?: HTMLButtonElement
  stop: HTMLButtonElement
  focus: HTMLElement | null
  selection?: [number, number, 'forward' | 'backward' | 'none']
  pending: boolean
  composing: boolean
  composingKey: boolean
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

/** Present only the top scope while retaining edits for every live parent. */
export function createGameDialogs(actions: DialogActions) {
  const views = new Map<number, DialogView>()
  let current: DialogView | undefined,
    origin: HTMLElement | null = null,
    disposed = false,
    enabled = true,
    stopping = false,
    focusVersion = 0,
    hiddenFocusVersion: number | undefined
  const focusChanged = () => {
    focusVersion++
  }
  document.addEventListener('focusin', focusChanged)
  const canRestoreHiddenFocus = () =>
    hiddenFocusVersion !== undefined &&
    hiddenFocusVersion === focusVersion &&
    (document.activeElement === document.body ||
      document.activeElement === document.documentElement)
  const live = (view: DialogView) => !disposed && views.get(view.request.id) === view
  const active = (view: DialogView) =>
    live(view) && current === view && view.dialog.isConnected && view.dialog.open
  const controls = (view: DialogView) => {
    const focused = document.activeElement,
      ownedFocus = focused instanceof HTMLElement && view.dialog.contains(focused)
    view.confirm.disabled = !enabled || stopping || view.pending
    if (view.cancel) view.cancel.disabled = !enabled || stopping || view.pending
    if (view.input) view.input.readOnly = !enabled || stopping || view.pending
    view.stop.disabled = stopping
    view.dialog.setAttribute('aria-busy', String(stopping || view.pending))
    if (ownedFocus && !canFocus(focused)) {
      const target = view.input ?? (view.stop.disabled ? view.status : view.stop)
      if (canFocus(target)) target.focus({ preventScroll: true })
    }
  }
  const error = (view: DialogView, reason: unknown) => {
    if (live(view))
      view.status.textContent = reason instanceof Error ? reason.message : String(reason)
  }
  const choose = async (view: DialogView, value: string | null) => {
    if (
      !active(view) ||
      !enabled ||
      view.pending ||
      stopping ||
      view.composing ||
      view.composingKey
    )
      return
    view.pending = true
    view.status.textContent = '正在提交…'
    controls(view)
    try {
      const operation = actions.choose(view.request.id, value)
      if (!operation) throw new Error('游戏会话已结束。')
      const accepted = await operation
      // A pause or a new child scope can win the race to the Worker. An
      // ignored response leaves this same live request available to retry.
      if (accepted === false && live(view)) {
        view.pending = false
        view.status.textContent = ''
        controls(view)
      }
      // A transport reply does not retire the request. A parent can be ready
      // while a child still owns the engine's modal scope.
    } catch (reason) {
      if (!live(view)) return
      view.pending = false
      controls(view)
      error(view, reason)
    }
  }
  const stop = async (view: DialogView) => {
    if (!active(view) || stopping) return
    stopping = true
    for (const retained of views.values()) controls(retained)
    view.status.textContent = '正在停止游戏…'
    try {
      await actions.stop()
    } catch (reason) {
      if (disposed) return
      stopping = false
      for (const retained of views.values()) controls(retained)
      error(view, reason)
    }
  }
  const hide = () => {
    const view = current
    if (!view) return false
    const focused = document.activeElement,
      ownedFocus = focused instanceof HTMLElement && view.dialog.contains(focused)
    if (ownedFocus) {
      view.focus = focused
      focused.blur()
    }
    if (view.input)
      view.selection = [
        view.input.selectionStart ?? 0,
        view.input.selectionEnd ?? 0,
        view.input.selectionDirection ?? 'none',
      ]
    // Removal clears the native modal/top-layer state. Calling close first
    // would restore the browser's saved focus even after blur, briefly focusing
    // an external Window while its child modal is being installed.
    view.dialog.remove()
    view.dialog.close()
    view.composing = false
    view.composingKey = false
    current = undefined
    hiddenFocusVersion = ownedFocus ? focusVersion : undefined
    return ownedFocus
  }
  const create = (request: SystemDialogRequest): DialogView => {
    const dialog = element('dialog'),
      form = element('form'),
      heading = element('h2', request.caption),
      prompt = element('p', request.text),
      status = element('p'),
      footer = element('div'),
      confirm = element('button', '确定'),
      stopButton = element('button', '停止游戏')
    dialog.className = 'game-system-dialog'
    dialog.dataset.requestId = String(request.id)
    dialog.dataset.kind = request.kind
    heading.id = `system-dialog-title-${request.id}`
    prompt.id = `system-dialog-prompt-${request.id}`
    if (request.caption) dialog.setAttribute('aria-labelledby', heading.id)
    dialog.setAttribute('aria-describedby', prompt.id)
    // An explicitly empty caption stays empty; the dialog still has a useful
    // accessible name when a script deliberately supplies no visible title.
    if (!request.caption)
      dialog.setAttribute('aria-label', request.kind === 'inform' ? '消息' : '输入文字')
    status.className = 'system-dialog-status'
    status.setAttribute('role', 'status')
    status.tabIndex = -1
    footer.className = 'system-dialog-actions'
    confirm.type = 'submit'
    confirm.dataset.action = 'confirm'
    stopButton.type = 'button'
    stopButton.dataset.action = 'stop'
    const view: DialogView = {
      request,
      dialog,
      heading,
      prompt,
      status,
      confirm,
      stop: stopButton,
      focus: null,
      pending: false,
      composing: false,
      composingKey: false,
    }
    form.append(heading, prompt)
    footer.append(stopButton)
    if (request.kind === 'input-string') {
      const input = element('input'),
        label = element('label', '输入内容'),
        cancel = element('button', '取消')
      input.type = 'text'
      input.value = request.value
      input.id = `system-dialog-value-${request.id}`
      input.autocomplete = 'off'
      input.spellcheck = false
      input.setAttribute('aria-describedby', prompt.id)
      label.htmlFor = input.id
      view.input = input
      view.cancel = cancel
      cancel.type = 'button'
      cancel.dataset.action = 'cancel'
      cancel.addEventListener('click', () => void choose(view, null))
      form.append(label, input)
      footer.append(cancel)
    }
    footer.append(confirm)
    form.append(status, footer)
    dialog.append(form)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void choose(view, view.input?.value ?? '')
    })
    stopButton.addEventListener('click', () => void stop(view))
    dialog.addEventListener('compositionstart', () => {
      view.composing = true
    })
    dialog.addEventListener('compositionend', () => {
      view.composing = false
    })
    dialog.addEventListener('keyup', (event) => {
      event.stopPropagation()
      view.composingKey = false
    })
    dialog.addEventListener('keydown', (event) => {
      // Game keyboard handlers must not also interpret keys owned by the dialog.
      event.stopPropagation()
      view.composingKey = event.isComposing || event.keyCode === 229
      if (view.composing || view.composingKey) return
      if (event.key === 'Escape') {
        event.preventDefault()
        void choose(view, null)
      }
    })
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      void choose(view, null)
    })
    return view
  }
  return {
    update(request: SystemDialogRequest | null, pendingIds: readonly number[]) {
      if (disposed) return
      const retained = new Set(pendingIds),
        next = request && retained.has(request.id) ? request : null
      if (current && next?.id === current.request.id) {
        // Request arguments are immutable, and an equal-id refresh must not
        // replace the live input or reset its selection and pending receipt.
        for (const [id] of views) if (!retained.has(id)) views.delete(id)
        return
      }
      const hadViews = views.size > 0,
        hadCurrent = !!current,
        ownedFocus = hide()
      for (const [id, view] of views) {
        if (retained.has(id)) continue
        view.dialog.remove()
        views.delete(id)
      }
      if (!next) {
        if (!retained.size) {
          if ((ownedFocus || canRestoreHiddenFocus()) && origin && canFocus(origin))
            origin.focus({ preventScroll: true })
          origin = null
          hiddenFocusVersion = undefined
        }
        return
      }
      if (!hadViews || (!hadCurrent && !views.size))
        origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
      let view = views.get(next.id)
      if (!view) {
        view = create(next)
        views.set(next.id, view)
      }
      current = view
      hiddenFocusVersion = undefined
      document.body.append(view.dialog)
      controls(view)
      view.dialog.showModal()
      const focus = view.focus && canFocus(view.focus) ? view.focus : (view.input ?? view.confirm)
      if (canFocus(focus)) focus.focus({ preventScroll: true })
      if (view.input && view.selection) view.input.setSelectionRange(...view.selection)
    },
    state(active: boolean) {
      if (disposed) return
      enabled = active
      for (const view of views.values()) controls(view)
    },
    dispose() {
      if (disposed) return
      const ownedFocus = hide()
      disposed = true
      document.removeEventListener('focusin', focusChanged)
      for (const view of views.values()) view.dialog.remove()
      views.clear()
      if ((ownedFocus || canRestoreHiddenFocus()) && origin && canFocus(origin))
        origin.focus({ preventScroll: true })
      origin = null
      hiddenFocusVersion = undefined
    },
  }
}
