import { BrowserClipboard } from '../backends/clipboard/browser.ts'
import { BrowserPadDownloads } from '../backends/pad/browser.ts'
import { cssFontFamily } from '../backends/text/browser/families.ts'
import type { PadHost, PadHostClient } from '../player/pad-host.ts'
import type { PadAck, PadMessage, PadSaveRequest, PadView } from '../protocol/pad.ts'

type Action = PadMessage extends infer M
  ? M extends PadMessage
    ? Omit<M, 'generation' | 'id' | 'epoch' | 'seq' | 'baseTextEpoch'>
    : never
  : never
type Selection = [number, number, 'forward' | 'backward' | 'none']
type Geometry = Pick<PadView, 'left' | 'top' | 'width' | 'height'>
interface Edit {
  start: number
  removed: string
  inserted: string
  before: Selection
  after: Selection
}
interface Editor {
  model: PadView
  node: HTMLElement
  title: HTMLElement
  textarea: HTMLTextAreaElement
  caret: HTMLElement
  status: HTMLElement
  footer: HTMLElement
  notice: HTMLElement
  menu: HTMLElement
  buttons: Map<string, HTMLButtonElement>
  resize: HTMLElement
  abort: AbortController
  seq: number
  lastEditSeq: number
  localText: string
  before: Selection
  pendingEdit: string | undefined
  pendingSelection: Selection | undefined
  flow: Promise<void> | undefined
  composing: boolean
  canceledComposition: boolean
  history: Edit[]
  redo: Edit[]
  historyUnits: number
  operation: number
  order: number
  pinned: boolean
  maximizing: boolean
  restoreFocus: boolean
  fontWanted?: string
  fontSettled?: string
  fontLoading: boolean
  fontFace?: FontFace
  fontLease?: object
  geometry?: Geometry
  restoreGeometry?: Geometry
  cancelGesture?: () => void
}
interface SaveView {
  request: PadSaveRequest
  node: HTMLDialogElement
  input: HTMLInputElement
  confirm: HTMLButtonElement
  cancel: HTMLButtonElement
  stop: HTMLButtonElement
  status: HTMLElement
  origin: HTMLElement | null
  selection?: Selection
  pending: boolean
  composing: boolean
  received: Set<number>
  focus: HTMLElement | null
  inputSelection?: Selection
  restoreOrigin: boolean
}
const lf = (text: string) => text.replace(/\r\n?/g, '\n')
const selection = (textarea: HTMLTextAreaElement): Selection => [
  textarea.selectionStart,
  textarea.selectionEnd,
  textarea.selectionDirection,
]
const color = (value: number) => `#${(value & 0xffffff).toString(16).padStart(6, '0')}`
const errorText = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)
const historyLimit = 1_048_576
const canFocus = (node: HTMLElement) =>
  node.isConnected &&
  !node.closest('[inert], [hidden]') &&
  !node.matches(':disabled') &&
  node.getClientRects().length > 0

/** Independent auxiliary text editors. Keyboard listeners stay on their own
 * surfaces, so the game input coordinator never receives Pad keystrokes. */
export function createGamePads(stage: HTMLElement): PadHost {
  const document = stage.ownerDocument,
    browser = document.defaultView!,
    editors = new Map<number, Editor>(),
    fontLeases = new Map<object, number>(),
    fontQueue = new Set<Editor>(),
    clipboard = new BrowserClipboard(),
    downloads = new BrowserPadDownloads(document)
  let client: PadHostClient | undefined,
    disposed = false,
    stopping = false,
    order = 0,
    fontOrder = 0,
    fontActive = 0,
    restoreTarget: { node: HTMLElement; selection?: Selection } | undefined,
    save: SaveView | undefined
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ) => {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const live = (view: Editor) => !disposed && !stopping && editors.get(view.model.id) === view
  const editable = (view: Editor) => live(view) && view.model.visible && !view.model.blocked
  const writable = (view: Editor) => editable(view) && !view.model.readOnly
  const identity = (view: Editor) => ({
    generation: client!.generation,
    id: view.model.id,
    epoch: view.model.epoch,
    seq: ++view.seq,
    baseTextEpoch: view.model.textEpoch,
  })
  const report = (view: Editor, reason: unknown) => {
    if (live(view)) view.notice.textContent = errorText(reason)
  }
  const stack = () => {
    const ordered = [...editors.values()].sort(
      (a, b) => Number(a.pinned) - Number(b.pinned) || a.order - b.order,
    )
    ordered.forEach((view, index) => {
      view.node.style.zIndex = String(view.model.blocked ? 0 : index + 1000)
    })
  }
  const updateCaret = (view: Editor) => {
    const text = view.textarea.value.slice(0, view.textarea.selectionStart),
      line = text.split('\n').length,
      column = text.length - text.lastIndexOf('\n')
    view.caret.textContent = `${line} 行，${column} 列`
    view.before = selection(view.textarea)
  }
  const setSelection = (view: Editor, range: Selection) => view.textarea.setSelectionRange(...range)
  const pending = (view: Editor) => {
    view.node.dataset.editPending = String(!!view.flow || view.pendingEdit !== undefined)
  }
  const resetComposition = (view: Editor) => {
    if (!view.composing) return
    view.composing = false
    view.canceledComposition = true
    if (document.activeElement === view.textarea) {
      view.textarea.blur()
      if (editable(view) && canFocus(view.textarea)) view.textarea.focus({ preventScroll: true })
    }
  }
  const geometry = (view: Editor) => {
    const current = view.geometry ?? view.model
    view.node.style.left = `${current.left}px`
    view.node.style.top = `${current.top}px`
    view.node.style.width = `${Math.max(0, current.width)}px`
    view.node.style.height = `${Math.max(0, current.height)}px`
  }
  const controls = (view: Editor) => {
    for (const [name, button] of view.buttons) {
      button.disabled =
        !editable(view) ||
        name === 'execute' ||
        (name === 'maximize' && view.maximizing) ||
        (['cut', 'paste', 'undo', 'redo'].includes(name) && view.model.readOnly) ||
        (name === 'undo' && !view.history.length) ||
        (name === 'redo' && !view.redo.length)
    }
    view.buttons.get('pin')?.setAttribute('aria-pressed', String(view.pinned))
  }
  const drainFonts = () => {
    queueMicrotask(() => {
      if (disposed || stopping) return
      for (const view of [...fontQueue]) {
        fontQueue.delete(view)
        view.fontSettled = undefined
        if (live(view)) refreshFont(view)
      }
    })
  }
  const releaseFontLease = (lease: object | undefined) => {
    if (lease && fontLeases.delete(lease)) drainFonts()
  }
  const releaseFont = (view: Editor) => {
    if (view.fontFace) document.fonts.delete(view.fontFace)
    view.fontFace = undefined
    releaseFontLease(view.fontLease)
    view.fontLease = undefined
  }
  const refreshFont = (view: Editor) => {
    const model = view.model,
      wanted =
        model.visible && client?.font
          ? JSON.stringify([model.epoch, model.fontFace, model.fontBold, model.fontItalic])
          : undefined
    if (view.fontWanted !== wanted) {
      view.fontWanted = wanted
      view.fontSettled = undefined
      releaseFont(view)
    }
    if (!wanted) {
      fontQueue.delete(view)
      view.node.dataset.fontState = 'fallback'
      return
    }
    if (view.fontFace)
      view.textarea.style.fontFamily = `${cssFontFamily(view.fontFace.family)}, serif`
    if (view.fontLoading || view.fontSettled === wanted) return
    // Reserve the maximum RPC payload before requesting it. Waiting entries
    // retain identities only; loaded and in-flight font input stays <= 64 MiB.
    const reserve = 16 * 1024 * 1024,
      used = [...fontLeases.values()].reduce((sum, bytes) => sum + bytes, 0)
    if (used + reserve > 64 * 1024 * 1024) {
      if (fontActive) {
        fontQueue.add(view)
        view.node.dataset.fontState = 'loading'
      } else {
        fontQueue.add(view)
        view.fontSettled = wanted
        view.node.dataset.fontState = 'failed'
        report(
          view,
          new RangeError(
            'Pad font loading exceeds the 64 MiB session budget (16 MiB request reservation)',
          ),
        )
      }
      return
    }
    fontQueue.delete(view)
    const lease = {}
    fontLeases.set(lease, reserve)
    fontActive++
    let retained = false
    view.fontLoading = true
    view.node.dataset.fontState = 'loading'
    const session = client!,
      active = () =>
        live(view) && client === session && view.fontWanted === wanted && view.model.visible
    void Promise.resolve()
      .then(() => (active() ? session.font!(model.id, model.epoch) : null))
      .then(async (resource) => {
        if (!active()) return
        if (!resource) {
          view.fontSettled = wanted
          view.node.dataset.fontState = 'fallback'
          return
        }
        if (resource.bytes.byteLength > 16 * 1024 * 1024)
          throw new RangeError('Pad font exceeds the 16 MiB budget')
        fontLeases.set(lease, resource.bytes.byteLength)
        drainFonts()
        const bytes = new Uint8Array(resource.bytes.byteLength)
        bytes.set(resource.bytes)
        const face = new FontFace(
          `krkr-pad-${session.generation}-${model.id}-${++fontOrder}`,
          bytes.buffer,
          { weight: resource.bold ? '700' : '400', style: resource.italic ? 'italic' : 'normal' },
        )
        await face.load()
        if (!active()) return
        releaseFont(view)
        document.fonts.add(face)
        view.fontFace = face
        view.fontLease = lease
        retained = true
        view.fontSettled = wanted
        view.textarea.style.fontFamily = `${cssFontFamily(face.family)}, serif`
        view.node.dataset.fontState = 'ready'
      })
      .catch((reason) => {
        if (active()) {
          view.fontSettled = wanted
          view.node.dataset.fontState = 'failed'
          report(view, reason)
        }
      })
      .finally(() => {
        fontActive--
        if (!retained) releaseFontLease(lease)
        view.fontLoading = false
        if (live(view)) refreshFont(view)
        drainFonts()
      })
  }
  const apply = (view: Editor, model: PadView) => {
    if (!live(view) || model.revision < view.model.revision || model.epoch < view.model.epoch)
      return
    const old = view.model,
      reset = model.textEpoch !== old.textEpoch || model.epoch !== old.epoch,
      losing = !model.visible || model.blocked,
      cancelEditing = losing || (model.readOnly && !old.readOnly)
    if ((losing || reset) && view.cancelGesture) view.cancelGesture()
    if (losing && view.node.contains(document.activeElement)) {
      view.restoreFocus = model.visible
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }
    view.model = { ...model }
    view.seq = Math.max(view.seq, model.acceptedEditSeq)
    if (reset) {
      resetComposition(view)
      view.operation++
      view.pendingEdit = undefined
      view.pendingSelection = undefined
      view.history = []
      view.redo = []
      view.historyUnits = 0
      view.lastEditSeq = model.acceptedEditSeq
    }
    if (cancelEditing) {
      resetComposition(view)
      view.operation++
      view.menu.hidden = true
      view.pendingEdit = undefined
      view.pendingSelection = undefined
    }
    if (
      reset ||
      cancelEditing ||
      (!view.composing &&
        view.pendingEdit === undefined &&
        model.acceptedEditSeq >= view.lastEditSeq)
    ) {
      const value = lf(model.text)
      if (view.localText !== value) {
        // A modal/readonly transition can reject an unfinished composition
        // without changing textEpoch. Its undo deltas must not survive rollback.
        view.history = []
        view.redo = []
        view.historyUnits = 0
      }
      if (view.textarea.value !== value) {
        const range = selection(view.textarea)
        view.textarea.value = value
        setSelection(view, range)
      }
      view.localText = value
    }
    view.node.hidden = !model.visible
    view.node.inert = model.blocked
    view.node.dataset.epoch = String(model.epoch)
    view.node.dataset.textEpoch = String(model.textEpoch)
    view.node.dataset.revision = String(model.revision)
    view.node.dataset.acceptedEditSeq = String(model.acceptedEditSeq)
    view.node.dataset.blocked = String(model.blocked)
    view.node.dataset.border = String(model.borderStyle)
    // The observed reference SDK ignores opacity writes.
    view.node.style.opacity = '1'
    view.node.setAttribute('aria-label', model.title || 'Pad 文本编辑器')
    view.title.textContent = model.title
    view.textarea.setAttribute('aria-label', `${model.title || 'Pad'} 正文`)
    view.textarea.readOnly = model.readOnly
    view.textarea.wrap = model.wordWrap ? 'soft' : 'off'
    view.textarea.style.whiteSpace = model.wordWrap ? 'pre-wrap' : 'pre'
    view.textarea.style.overflowX =
      model.wordWrap || ![1, 3].includes(model.showScrollBars) ? 'hidden' : 'scroll'
    view.textarea.style.overflowY = [2, 3].includes(model.showScrollBars) ? 'scroll' : 'hidden'
    view.textarea.style.color = color(model.inkColor)
    view.textarea.style.backgroundColor = color(model.color)
    view.textarea.style.fontFamily = `${cssFontFamily(model.fontFace)}, serif`
    refreshFont(view)
    // Logical font values remain in the worker. Rendering pathological sizes
    // uses a finite fallback, never an unbounded browser font allocation.
    view.textarea.style.fontSize = `${model.fontHeight > 0 && model.fontHeight <= 512 ? model.fontHeight : 12}px`
    view.textarea.style.fontWeight = model.fontBold ? '700' : '400'
    view.textarea.style.fontStyle = model.fontItalic ? 'italic' : 'normal'
    view.textarea.style.textDecoration =
      [model.fontUnderline && 'underline', model.fontStrikeOut && 'line-through']
        .filter(Boolean)
        .join(' ') || 'none'
    view.footer.style.visibility = model.showStatusBar ? 'visible' : 'hidden'
    view.status.textContent = model.statusText
    view.resize.hidden = ![2, 5].includes(model.borderStyle)
    if (
      old.left !== model.left ||
      old.top !== model.top ||
      old.width !== model.width ||
      old.height !== model.height ||
      old.borderStyle !== model.borderStyle
    ) {
      view.cancelGesture?.()
      view.geometry = undefined
      view.restoreGeometry = undefined
    }
    geometry(view)
    controls(view)
    updateCaret(view)
    if (
      !losing &&
      view.restoreFocus &&
      canFocus(view.textarea) &&
      (document.activeElement === document.body ||
        document.activeElement === document.documentElement)
    ) {
      view.restoreFocus = false
      view.textarea.focus({ preventScroll: true })
    }
  }
  const send = async (view: Editor, action: Action): Promise<PadAck> => {
    if (!client || !live(view)) return { status: 'ignored' }
    const message = { ...identity(view), ...action } as PadMessage
    if (action.kind === 'edit') view.lastEditSeq = message.seq
    const ack = await client.send(message)
    if (live(view) && ack.view)
      // ACKs and presentations use separate channels. Only presentations own
      // modal eligibility; an older same-revision ACK must not undo a block.
      apply(view, { ...ack.view, blocked: view.model.blocked })
    return ack
  }
  const flush = (view: Editor): Promise<void> => {
    if (view.flow) return view.flow
    if (!live(view)) return Promise.resolve()
    const work = async () => {
      while (
        editable(view) &&
        (view.pendingEdit !== undefined || view.pendingSelection !== undefined)
      ) {
        const text = view.pendingEdit,
          range = view.pendingSelection,
          epoch = view.model.epoch,
          textEpoch = view.model.textEpoch
        view.pendingEdit = undefined
        view.pendingSelection = undefined
        let ack: PadAck
        try {
          ack =
            text !== undefined
              ? await send(view, { kind: 'edit', text })
              : await send(view, { kind: 'selection', start: range![0], end: range![1] })
        } catch (reason) {
          if (
            live(view) &&
            view.model.epoch === epoch &&
            view.model.textEpoch === textEpoch &&
            text !== undefined
          )
            view.pendingEdit = view.pendingEdit ?? view.localText
          throw reason
        }
        if (view.model.epoch !== epoch || view.model.textEpoch !== textEpoch) continue
        if (ack.status === 'ignored' && live(view)) {
          view.pendingEdit = undefined
          view.pendingSelection = undefined
          if (ack.view) {
            view.localText = lf(ack.view.text)
            view.textarea.value = view.localText
          }
          view.history = []
          view.redo = []
          view.historyUnits = 0
          view.notice.textContent = '这次编辑未被会话接受；已恢复当前正文。'
          controls(view)
          updateCaret(view)
        }
      }
    }
    view.flow = work()
      .catch((reason) => {
        report(view, reason)
        throw reason
      })
      .finally(() => {
        view.flow = undefined
        pending(view)
      })
    pending(view)
    return view.flow
  }
  const flushQuiet = (view: Editor) => {
    void flush(view).catch(() => {})
  }
  const record = (view: Editor, before: string, after: string, range: Selection) => {
    let start = 0,
      end = 0
    while (start < before.length && start < after.length && before[start] === after[start]) start++
    while (
      end < before.length - start &&
      end < after.length - start &&
      before[before.length - 1 - end] === after[after.length - 1 - end]
    )
      end++
    const edit: Edit = {
        start,
        removed: before.slice(start, before.length - end),
        inserted: after.slice(start, after.length - end),
        before: range,
        after: selection(view.textarea),
      },
      units = edit.removed.length + edit.inserted.length
    view.redo = []
    if (units > historyLimit) {
      view.history = []
      view.historyUnits = 0
      return
    }
    view.history.push(edit)
    view.historyUnits += units
    while (view.history.length > 50 || view.historyUnits > historyLimit) {
      const first = view.history.shift()!
      view.historyUnits -= first.removed.length + first.inserted.length
    }
  }
  const changed = (view: Editor, remember = true) => {
    if (!writable(view) || view.canceledComposition) {
      view.textarea.value = view.localText
      return
    }
    // Pad's observed NUL terminator also applies to user edits. Normalize
    // before recording undo, so an accepted ACK cannot invalidate its deltas.
    const text = view.textarea.value.split('\0', 1)[0]!
    if (text !== view.textarea.value) view.textarea.value = text
    if (text.length > 10_000_000) {
      view.textarea.value = view.localText
      report(view, new RangeError('Pad text exceeds the 10,000,000 UTF-16 unit budget'))
      return
    }
    if (text !== view.localText) {
      if (remember) record(view, view.localText, text, view.before)
      view.localText = text
      view.pendingEdit = text
      view.notice.textContent = ''
      if (!view.composing) flushQuiet(view)
    }
    updateCaret(view)
    controls(view)
  }
  const replace = (view: Editor, text: string) => {
    if (!writable(view)) return
    view.canceledComposition = false
    view.before = selection(view.textarea)
    view.textarea.setRangeText(lf(text), view.before[0], view.before[1], 'end')
    changed(view)
  }
  const undo = (view: Editor, backwards: boolean) => {
    if (!writable(view) || view.composing) return
    const edit = (backwards ? view.history : view.redo).pop()
    if (!edit) return
    view.canceledComposition = false
    const remove = backwards ? edit.inserted : edit.removed,
      insert = backwards ? edit.removed : edit.inserted
    view.textarea.value =
      view.localText.slice(0, edit.start) +
      insert +
      view.localText.slice(edit.start + remove.length)
    setSelection(view, backwards ? edit.before : edit.after)
    if (backwards) {
      view.redo.push(edit)
      view.historyUnits -= edit.removed.length + edit.inserted.length
    } else {
      view.history.push(edit)
      view.historyUnits += edit.removed.length + edit.inserted.length
    }
    changed(view, false)
  }
  const clipboardAction = (view: Editor, action: 'copy' | 'cut' | 'paste') => {
    if (!editable(view) || (action !== 'copy' && !writable(view))) return
    const range = selection(view.textarea)
    // RichEdit Copy/Cut with an empty selection is a no-op. Do not replace
    // the user's existing clipboard with an empty string.
    if (action !== 'paste' && range[0] === range[1]) return
    const epoch = view.model.epoch,
      textEpoch = view.model.textEpoch,
      original = view.localText,
      operation = ++view.operation,
      valid = () =>
        editable(view) &&
        view.operation === operation &&
        view.model.epoch === epoch &&
        view.model.textEpoch === textEpoch &&
        view.localText === original
    // Begin the real API call synchronously in this button's user activation.
    const work =
      action === 'paste'
        ? clipboard.readText()
        : clipboard.writeText(original.slice(range[0], range[1]))
    void work.then(
      (result) => {
        if (!valid()) return
        if (action === 'copy') view.notice.textContent = '已复制。'
        else {
          // A fulfilled API promise does not own the user's later selection
          // or focus. Apply editing results only to the still-active editor
          // and the exact range that initiated the operation.
          if (
            !writable(view) ||
            !view.node.contains(document.activeElement) ||
            selection(view.textarea).some((value, index) => value !== range[index])
          )
            return
          if (action === 'cut') replace(view, '')
          else if (result && 'hasText' in result && result.hasText) replace(view, result.text)
          view.textarea.focus({ preventScroll: true })
        }
      },
      (reason) => {
        if (valid()) report(view, reason)
      },
    )
  }
  const openSave = async (view: Editor) => {
    if (!editable(view) || view.composing || save) return
    try {
      await flush(view)
      if (editable(view) && !save) await send(view, { kind: 'save-open' })
    } catch (reason) {
      report(view, reason)
    }
  }
  const restoreSaveFocus = () => {
    if (!restoreTarget) return
    const { node, selection: range } = restoreTarget
    if (!node.isConnected || node.closest('[hidden]')) {
      restoreTarget = undefined
      return
    }
    // A receipt can arrive before a child releases the shared scope. Keep the origin
    // until the authoritative unblock, and never focus an inert editor.
    if (!canFocus(node)) return
    restoreTarget = undefined
    if (
      document.activeElement !== document.body &&
      document.activeElement !== document.documentElement
    )
      return
    node.focus({ preventScroll: true })
    if (node instanceof HTMLTextAreaElement && range) node.setSelectionRange(...range)
  }
  const hideSave = (current: SaveView) => {
    const ownsFocus = current.node.contains(document.activeElement)
    if (ownsFocus) {
      current.focus = document.activeElement as HTMLElement
      current.restoreOrigin = true
    }
    current.inputSelection = [
      current.input.selectionStart ?? 0,
      current.input.selectionEnd ?? 0,
      current.input.selectionDirection ?? 'none',
    ]
    current.node.remove()
    current.node.close()
  }
  const showSave = (current: SaveView) => {
    if (current.node.open) return
    document.body.append(current.node)
    current.node.showModal()
    const target = current.focus && canFocus(current.focus) ? current.focus : current.input
    target.focus({ preventScroll: true })
    if (current.inputSelection) current.input.setSelectionRange(...current.inputSelection)
    else current.input.select()
  }
  const closeSave = (restore: boolean) => {
    const current = save
    if (!current) return
    save = undefined
    hideSave(current)
    if (restore && current.restoreOrigin && current.origin)
      restoreTarget = { node: current.origin, selection: current.selection }
    restoreSaveFocus()
  }
  const saveControls = (current: SaveView) => {
    current.confirm.disabled = current.pending || stopping || current.request.receipt !== undefined
    current.cancel.disabled = current.pending || stopping || current.request.receipt !== undefined
    current.input.readOnly = current.pending || stopping || current.request.receipt !== undefined
    current.stop.disabled = stopping
    current.node.setAttribute('aria-busy', String(current.pending || stopping))
  }
  const chooseSave = async (current: SaveView, confirm: boolean) => {
    if (
      disposed ||
      stopping ||
      save !== current ||
      !current.node.open ||
      current.pending ||
      current.composing ||
      current.request.receipt !== undefined
    )
      return
    const view = editors.get(current.request.padId)
    if (!view || view.model.epoch !== current.request.epoch) return
    current.pending = true
    current.status.textContent = '正在提交…'
    saveControls(current)
    try {
      const ack = await send(
        view,
        confirm
          ? { kind: 'save-confirm', requestId: current.request.id, fileName: current.input.value }
          : { kind: 'save-cancel', requestId: current.request.id },
      )
      if (save === current && ack.status === 'ignored') {
        current.pending = false
        current.status.textContent = '请求当前不可用，请重试。'
        saveControls(current)
      }
    } catch (reason) {
      if (save !== current) return
      current.pending = false
      current.status.textContent = errorText(reason)
      saveControls(current)
    }
  }
  const stop = async () => {
    if (stopping || disposed || !client) return
    const session = client
    stopping = true
    // Retire browser capabilities before waiting for the worker's terminal
    // release. Late clipboard/save results cannot act on the next session.
    clipboard.close()
    downloads.dispose()
    fontQueue.clear()
    for (const view of editors.values()) {
      view.operation++
      view.cancelGesture?.()
      view.pendingEdit = undefined
      view.pendingSelection = undefined
      view.node.inert = true
      view.fontWanted = undefined
      releaseFont(view)
    }
    if (save) {
      save.status.textContent = '正在停止游戏…'
      saveControls(save)
    }
    try {
      await session.stop()
    } catch (reason) {
      if (save) save.status.textContent = errorText(reason)
    }
  }
  const createSave = (request: PadSaveRequest): SaveView => {
    const node = element('dialog', 'game-pad-save'),
      form = element('form', 'game-pad-save-form'),
      heading = element('h2', '', '保存 Pad 文本'),
      label = element('label', '', '文件名'),
      input = element('input', ''),
      encoding = element('p', '', 'UTF-8 · CRLF 换行 · 无 BOM'),
      status = element('p', 'game-pad-save-status'),
      footer = element('div', 'game-pad-save-actions'),
      confirm = element('button', '', '下载'),
      cancel = element('button', '', '取消'),
      stopButton = element('button', '', '停止游戏'),
      origin =
        editors.get(request.padId)?.textarea ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    node.dataset.requestId = String(request.id)
    node.dataset.padId = String(request.padId)
    node.setAttribute('aria-label', '保存 Pad 文本')
    input.id = `pad-save-name-${client!.generation}-${request.id}`
    input.value = request.fileName
    input.autocomplete = 'off'
    input.spellcheck = false
    label.htmlFor = input.id
    status.setAttribute('role', 'status')
    confirm.type = 'submit'
    cancel.type = stopButton.type = 'button'
    confirm.dataset.action = 'confirm'
    cancel.dataset.action = 'cancel'
    stopButton.dataset.action = 'stop'
    footer.append(stopButton, cancel, confirm)
    form.append(heading, label, input, encoding, status, footer)
    node.append(form)
    const current: SaveView = {
      request,
      node,
      input,
      confirm,
      cancel,
      stop: stopButton,
      status,
      origin,
      selection: origin instanceof HTMLTextAreaElement ? selection(origin) : undefined,
      pending: false,
      composing: false,
      received: new Set(),
      focus: null,
      restoreOrigin: true,
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void chooseSave(current, true)
    })
    cancel.addEventListener('click', () => void chooseSave(current, false))
    stopButton.addEventListener('click', () => void stop())
    node.addEventListener('cancel', (event) => {
      event.preventDefault()
      void chooseSave(current, false)
    })
    node.addEventListener('compositionstart', () => {
      current.composing = true
    })
    node.addEventListener('compositionend', () => {
      current.composing = false
    })
    node.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        void chooseSave(current, false)
      }
    })
    node.addEventListener('keyup', (event) => event.stopPropagation())
    return current
  }
  const receiveDownload = (current: SaveView) => {
    const request = current.request,
      receipt = request.receipt,
      view = editors.get(request.padId)
    if (
      receipt === undefined ||
      current.received.has(receipt) ||
      save !== current ||
      !current.node.open ||
      !view ||
      !live(view) ||
      !view.model.visible ||
      view.model.epoch !== request.epoch
    )
      return
    current.received.add(receipt)
    current.pending = true
    saveControls(current)
    let ok = true,
      error: string | undefined
    try {
      downloads.download(request.fileName, request.text)
      current.status.textContent = '已交给浏览器下载。'
    } catch (reason) {
      ok = false
      error = errorText(reason)
      current.status.textContent = error
    }
    void send(view, { kind: 'save-outcome', requestId: request.id, receipt, ok, error }).catch(
      (reason) => {
        if (save === current) current.status.textContent = errorText(reason)
      },
    )
  }
  const gesture = (view: Editor, event: PointerEvent, resizing: boolean) => {
    if (
      !editable(view) ||
      event.button !== 0 ||
      view.model.borderStyle === 0 ||
      (resizing && ![2, 5].includes(view.model.borderStyle))
    )
      return
    event.preventDefault()
    event.stopPropagation()
    view.cancelGesture?.()
    view.restoreGeometry = undefined
    const target = event.currentTarget as HTMLElement,
      pointer = event.pointerId,
      x = event.clientX,
      y = event.clientY,
      start: Geometry = {
        left: view.model.left,
        top: view.model.top,
        width: view.model.width,
        height: view.model.height,
      },
      abort = new AbortController(),
      options = { signal: abort.signal }
    let ended = false
    const end = (commit: boolean) => {
      if (ended) return
      ended = true
      const result = view.geometry
      view.geometry = undefined
      view.cancelGesture = undefined
      abort.abort()
      if (target.hasPointerCapture(pointer)) target.releasePointerCapture(pointer)
      geometry(view)
      if (commit && result && editable(view))
        void send(view, { kind: 'geometry', mode: resizing ? 'resize' : 'move', ...result }).catch(
          (reason) => report(view, reason),
        )
    }
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return
      if (!editable(view)) {
        end(false)
        return
      }
      const dx = Math.round(next.clientX - x),
        dy = Math.round(next.clientY - y)
      view.geometry = resizing
        ? {
            ...start,
            width: Math.max(70, start.width + dx),
            height: Math.max(100, start.height + dy),
          }
        : { ...start, left: start.left + dx, top: start.top + dy }
      geometry(view)
    }
    view.cancelGesture = () => end(false)
    target.addEventListener('pointermove', move, options)
    target.addEventListener(
      'pointerup',
      (next) => {
        if (next.pointerId === pointer) {
          move(next)
          end(true)
        }
      },
      options,
    )
    target.addEventListener('pointercancel', () => end(false), options)
    target.addEventListener('lostpointercapture', () => end(false), options)
    browser.addEventListener('blur', () => end(false), options)
    try {
      target.setPointerCapture(pointer)
    } catch {
      end(false)
    }
  }
  const maximize = (view: Editor) => {
    if (!editable(view) || view.maximizing) return
    view.maximizing = true
    controls(view)
    const epoch = view.model.epoch,
      restore = view.restoreGeometry,
      next = restore ?? {
        left: 0,
        top: 0,
        width: Math.max(70, stage.clientWidth),
        height: Math.max(
          100,
          Math.min(browser.innerHeight, stage.clientHeight || browser.innerHeight),
        ),
      },
      original = {
        left: view.model.left,
        top: view.model.top,
        width: view.model.width,
        height: view.model.height,
      }
    void send(view, { kind: 'geometry', mode: restore ? 'restore' : 'resize', ...next })
      .then(
        (ack) => {
          if (
            live(view) &&
            view.model.visible &&
            view.model.epoch === epoch &&
            ack.status === 'accepted' &&
            ack.view?.revision === view.model.revision &&
            (['left', 'top', 'width', 'height'] as const).every(
              (key) => view.model[key] === next[key],
            )
          )
            view.restoreGeometry = restore ? undefined : original
        },
        (reason) => report(view, reason),
      )
      .finally(() => {
        view.maximizing = false
        if (live(view)) controls(view)
      })
  }
  const create = (model: PadView): Editor => {
    const node = element('section', 'game-pad'),
      header = element('div', 'game-pad-header'),
      title = element('span', 'game-pad-title'),
      toolbar = element('div', 'game-pad-toolbar'),
      textarea = element('textarea', 'game-pad-text'),
      footer = element('div', 'game-pad-footer'),
      caret = element('span', 'game-pad-caret'),
      status = element('span', 'game-pad-status'),
      notice = element('div', 'game-pad-notice'),
      menu = element('div', 'game-pad-menu'),
      resize = element('div', 'game-pad-resize'),
      buttons = new Map<string, HTMLButtonElement>(),
      abort = new AbortController(),
      options = { signal: abort.signal }
    node.dataset.padId = String(model.id)
    node.dataset.generation = String(client!.generation)
    node.setAttribute('role', 'group')
    textarea.spellcheck = false
    textarea.autocomplete = 'off'
    textarea.setAttribute('autocapitalize', 'off')
    textarea.value = lf(model.text)
    notice.setAttribute('role', 'status')
    menu.hidden = true
    menu.setAttribute('role', 'group')
    menu.setAttribute('aria-label', 'Pad 编辑操作')
    resize.setAttribute('aria-label', '调整 Pad 大小')
    const view: Editor = {
      model: { ...model },
      node,
      title,
      textarea,
      caret,
      status,
      footer,
      notice,
      menu,
      buttons,
      resize,
      abort,
      seq: model.acceptedEditSeq,
      lastEditSeq: model.acceptedEditSeq,
      localText: textarea.value,
      before: [0, 0, 'none'],
      pendingEdit: undefined,
      pendingSelection: undefined,
      flow: undefined,
      composing: false,
      canceledComposition: false,
      history: [],
      redo: [],
      historyUnits: 0,
      operation: 0,
      order: ++order,
      pinned: false,
      maximizing: false,
      restoreFocus: false,
      fontLoading: false,
    }
    const button = (name: string, text: string, parent: HTMLElement, action: () => void) => {
      const control = element('button', '', text)
      control.type = 'button'
      control.dataset.action = name
      control.addEventListener(
        'click',
        () => {
          if (editable(view)) action()
        },
        options,
      )
      buttons.set(name, control)
      parent.append(control)
      return control
    }
    header.append(title)
    button('maximize', '□', header, () => maximize(view)).setAttribute(
      'aria-label',
      '最大化或还原 Pad',
    )
    button('close', '×', header, () => {
      void flush(view)
        .then(() => (editable(view) ? send(view, { kind: 'close' }) : undefined))
        .catch((reason) => report(view, reason))
    }).setAttribute('aria-label', '关闭 Pad')
    button('save', '保存', toolbar, () => void openSave(view))
    const menuButton = button('menu', '编辑', toolbar, () => {
      menu.hidden = !menu.hidden
      if (!menu.hidden) buttons.get('copy')?.focus()
    })
    menuButton.setAttribute('aria-haspopup', 'true')
    button('pin', '置顶', toolbar, () => {
      view.pinned = !view.pinned
      controls(view)
      stack()
    })
    button('execute', '执行', toolbar, () => {})
    button('undo', '撤销', menu, () => undo(view, true))
    button('redo', '重做', menu, () => undo(view, false))
    button('cut', '剪切', menu, () => clipboardAction(view, 'cut'))
    button('copy', '复制', menu, () => clipboardAction(view, 'copy'))
    button('paste', '粘贴', menu, () => clipboardAction(view, 'paste'))
    button('select-all', '全选', menu, () => {
      textarea.focus()
      textarea.select()
      updateCaret(view)
    })
    footer.append(caret, status)
    node.append(header, toolbar, textarea, footer, notice, menu, resize)
    const select = () => {
      updateCaret(view)
      if (!editable(view) || view.composing) return
      view.pendingSelection = selection(textarea)
      flushQuiet(view)
    }
    textarea.addEventListener('select', select, options)
    textarea.addEventListener('click', select, options)
    textarea.addEventListener('keyup', select, options)
    textarea.addEventListener(
      'beforeinput',
      (event) => {
        if (!writable(view)) {
          event.preventDefault()
          return
        }
        const input = event as InputEvent
        if (view.canceledComposition) {
          if (input.inputType === 'insertFromPaste' || input.inputType === 'insertFromDrop')
            view.canceledComposition = false
          else {
            event.preventDefault()
            return
          }
        }
        if (input.inputType === 'historyUndo' || input.inputType === 'historyRedo') {
          event.preventDefault()
          undo(view, input.inputType === 'historyUndo')
        }
        view.before = selection(textarea)
      },
      options,
    )
    textarea.addEventListener('input', () => changed(view), options)
    textarea.addEventListener(
      'compositionstart',
      () => {
        if (writable(view)) {
          view.composing = true
          view.canceledComposition = false
          view.before = selection(textarea)
        }
      },
      options,
    )
    textarea.addEventListener(
      'compositionend',
      () => {
        view.composing = false
        if (view.canceledComposition || !writable(view)) {
          textarea.value = view.localText
          return
        }
        changed(view)
        flushQuiet(view)
      },
      options,
    )
    textarea.addEventListener(
      'pointerdown',
      () => {
        if (writable(view) && !view.composing) view.canceledComposition = false
      },
      options,
    )
    textarea.addEventListener(
      'keydown',
      (event) => {
        if (event.isComposing || event.keyCode === 229 || view.composing) return
        view.canceledComposition = false
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          const key = event.key.toLowerCase()
          if (key === 's') {
            event.preventDefault()
            void openSave(view)
          } else if (key === 'z' || key === 'y') {
            event.preventDefault()
            undo(view, key === 'z' && !event.shiftKey)
          } else if (key === 'enter') event.preventDefault()
        } else if (event.key === 'Tab' && !event.altKey) {
          event.preventDefault()
          replace(view, '\t')
        }
      },
      options,
    )
    node.addEventListener(
      'keydown',
      (event) => {
        event.stopPropagation()
        if (
          !event.defaultPrevented &&
          !event.isComposing &&
          event.keyCode !== 229 &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          event.key.toLowerCase() === 's'
        ) {
          event.preventDefault()
          void openSave(view)
        }
        if (event.key === 'Escape' && !event.isComposing && !menu.hidden) {
          event.preventDefault()
          menu.hidden = true
          textarea.focus({ preventScroll: true })
        }
      },
      options,
    )
    node.addEventListener('keyup', (event) => event.stopPropagation(), options)
    node.addEventListener('keypress', (event) => event.stopPropagation(), options)
    node.addEventListener(
      'focusin',
      () => {
        view.order = ++order
        stack()
      },
      options,
    )
    node.addEventListener(
      'pointerdown',
      (event) => {
        view.order = ++order
        stack()
        if (editable(view) && !(event.target as Element).closest('button, textarea, input'))
          textarea.focus({ preventScroll: true })
      },
      options,
    )
    textarea.addEventListener(
      'contextmenu',
      (event) => {
        if (!editable(view)) return
        event.preventDefault()
        menu.hidden = false
        menu.style.left = `${Math.max(0, Math.min(event.clientX - node.getBoundingClientRect().left, node.clientWidth - 160))}px`
        menu.style.top = `${Math.max(0, Math.min(event.clientY - node.getBoundingClientRect().top, node.clientHeight - 180))}px`
        buttons.get('copy')?.focus()
      },
      options,
    )
    header.addEventListener(
      'pointerdown',
      (event) => {
        if (!(event.target as Element).closest('button')) gesture(view, event, false)
      },
      options,
    )
    header.addEventListener(
      'dblclick',
      (event) => {
        if (!(event.target as Element).closest('button')) maximize(view)
      },
      options,
    )
    resize.addEventListener('pointerdown', (event) => gesture(view, event, true), options)
    stage.append(node)
    return view
  }
  const remove = (view: Editor) => {
    view.operation++
    view.cancelGesture?.()
    view.abort.abort()
    view.fontWanted = undefined
    fontQueue.delete(view)
    releaseFont(view)
    view.pendingEdit = undefined
    view.pendingSelection = undefined
    view.history = []
    view.redo = []
    editors.delete(view.model.id)
    view.node.remove()
  }
  return {
    attach(next) {
      if (disposed) throw new Error('Pad host is disposed')
      if (client === next) return
      if (client) throw new Error('Pad host already belongs to a session')
      client = next
      stage.classList.add('game-pad-desktop')
    },
    update(presentation) {
      if (disposed || stopping || !client) return
      const next = presentation.save
      if (next && save?.request.id !== next.id) {
        closeSave(false)
        save = createSave(next)
      }
      // Establish the top dialog's focus before making its Pad inert. A child
      // scope only suspends the same dialog; its filename and receipt survive.
      if (next && save) showSave(save)
      const ids = new Set(presentation.pads.map((model) => model.id))
      for (const view of editors.values()) if (!ids.has(view.model.id)) remove(view)
      for (const model of presentation.pads) {
        let view = editors.get(model.id)
        if (!view) {
          view = create(model)
          editors.set(model.id, view)
        }
        apply(view, model)
      }
      if (!next) {
        if (save && presentation.pendingSaveId === save.request.id) hideSave(save)
        else closeSave(true)
      } else if (save && save.request.id === next.id) {
        const changedError = next.error !== save.request.error
        save.request = { ...next }
        if (next.error !== undefined) {
          save.pending = false
          save.status.textContent = next.error
        } else if (changedError) save.status.textContent = ''
        saveControls(save)
        receiveDownload(save)
      }
      stack()
      restoreSaveFocus()
    },
    async flush() {
      await Promise.all([...editors.values()].map(flush))
    },
    dispose() {
      if (disposed) return
      closeSave(false)
      for (const view of editors.values()) remove(view)
      clipboard.close()
      downloads.dispose()
      fontQueue.clear()
      client = undefined
      restoreTarget = undefined
      disposed = true
    },
  }
}
