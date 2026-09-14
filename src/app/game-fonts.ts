import type { FontDescriptor, FontPreview, FontSelectionRequest } from '../engine/ports/fonts.ts'
import { canReadLocalFonts, readLocalFonts } from '../backends/text/browser/local-fonts.ts'
import { cssFontFamily } from '../backends/text/browser/families.ts'

interface FontActions {
  choose(id: number, face: string | null): Promise<unknown> | undefined
  preview(
    id: number,
    face: string,
    kind: 'sample' | 'label',
  ): Promise<FontPreview | null> | undefined
  system(fonts: FontDescriptor[]): Promise<unknown> | undefined
  stop(): Promise<void>
}
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  return node
}
export function createGameFonts(actions: FontActions) {
  let current: FontSelectionRequest | null = null,
    dialog: HTMLDialogElement | undefined,
    choices: HTMLDivElement | undefined,
    preview: HTMLCanvasElement | undefined,
    status: HTMLElement | undefined,
    confirm: HTMLButtonElement | undefined,
    selected = '',
    wantedPreview = '',
    busy = false,
    epoch = 0,
    controller: AbortController | undefined,
    previousFocus: HTMLElement | null = null
  const rows = new Map<string, HTMLButtonElement>(),
    labels: string[] = []
  const showError = (error: unknown) => {
    if (status) status.textContent = error instanceof Error ? error.message : String(error)
  }
  const paint = (canvas: HTMLCanvasElement, image: FontPreview) => {
    canvas.dataset.fontFace = image.face
    canvas.width = image.width
    canvas.height = image.height
    canvas
      .getContext('2d')!
      .putImageData(
        new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
        0,
        0,
      )
  }
  const pump = async () => {
    if (busy || !current) return
    const request = current,
      version = epoch,
      face = wantedPreview || labels.shift(),
      kind = wantedPreview ? 'sample' : 'label'
    wantedPreview = ''
    if (!face) return
    busy = true
    try {
      const image = await actions.preview(request.id, face, kind)
      if (epoch !== version || !current || current.id !== request.id || !image) return
      if (kind === 'sample' && selected === face && preview) paint(preview, image)
      else if (kind === 'label') {
        const row = rows.get(face)
        if (row) {
          const canvas = element('canvas')
          canvas.setAttribute('aria-hidden', 'true')
          paint(canvas, image)
          row.replaceChildren(canvas)
        }
      }
    } catch (error) {
      if (epoch === version && current && kind === 'sample') showError(error)
    } finally {
      busy = false
      if (current && (wantedPreview || labels.length)) void pump()
    }
  }
  const select = (name: string) => {
    selected = name
    for (const [face, row] of rows) row.setAttribute('aria-selected', String(face === name))
    if (confirm) confirm.disabled = !rows.has(name)
    wantedPreview = name
    void pump()
  }
  const dismiss = () => {
    if (current) void actions.choose(current.id, null)?.catch(showError)
  }
  const close = () => {
    epoch++
    current = null
    controller?.abort()
    controller = undefined
    wantedPreview = ''
    labels.length = 0
    rows.clear()
    dialog?.close()
    dialog?.remove()
    dialog = undefined
    choices = undefined
    preview = undefined
    confirm = undefined
    status = undefined
    if (previousFocus?.isConnected) previousFocus.focus()
    previousFocus = null
  }
  const renderChoices = () => {
    if (!current || !choices) return
    rows.clear()
    labels.length = 0
    choices.replaceChildren()
    for (const font of current.choices) {
      const row = element('button', font.name)
      row.type = 'button'
      row.className = 'font-choice'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-label', font.name)
      row.title =
        font.source === 'game'
          ? '游戏字体'
          : font.source === 'system'
            ? '本机字体'
            : '浏览器通用字体'
      row.addEventListener('click', () => select(font.name))
      row.addEventListener('dblclick', () => {
        if (current) void actions.choose(current.id, font.name)?.catch(showError)
      })
      if (current.flags & 256) {
        if (font.source === 'game') labels.push(font.name)
        else row.style.fontFamily = cssFontFamily(font.name) + ', sans-serif'
      }
      rows.set(font.name, row)
      choices.append(row)
    }
    if (!rows.has(selected))
      selected = rows.has(current.font.face) ? current.font.face : (current.choices[0]?.name ?? '')
    if (!rows.size && status)
      status.textContent = '没有符合筛选条件的字体。可以读取本机字体，或取消选择。'
    select(selected)
  }
  return {
    update(request: FontSelectionRequest | null) {
      if (!request) {
        close()
        return
      }
      if (current?.id === request.id && dialog) {
        current = request
        renderChoices()
        return
      }
      close()
      current = request
      selected = request.font.face
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog = element('dialog')
      dialog.className = 'game-font-dialog'
      dialog.id = 'game-font-dialog'
      const heading = element('h2', request.caption || '选择字体')
      heading.id = 'font-dialog-title'
      dialog.setAttribute('aria-labelledby', heading.id)
      const prompt = element('p', request.prompt)
      prompt.id = 'font-dialog-prompt'
      dialog.setAttribute('aria-describedby', prompt.id)
      choices = element('div')
      choices.className = 'font-choices'
      choices.setAttribute('role', 'listbox')
      choices.setAttribute('aria-label', '字体')
      choices.addEventListener('keydown', (event) => {
        const names = [...rows.keys()],
          index = names.indexOf(selected)
        let next = index
        if (event.key === 'ArrowDown') next = Math.min(names.length - 1, index + 1)
        else if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = names.length - 1
        else return
        event.preventDefault()
        const name = names[next]
        if (name) {
          select(name)
          rows.get(name)?.focus()
        }
      })
      preview = element('canvas')
      preview.className = 'font-sample'
      preview.setAttribute('aria-label', '字体预览')
      status = element('p')
      status.className = 'font-status'
      status.setAttribute('role', 'status')
      const read = element('button', '读取本机字体')
      read.type = 'button'
      read.disabled = !canReadLocalFonts()
      read.addEventListener('click', () => {
        if (!current) return
        const version = epoch
        controller?.abort()
        controller = new AbortController()
        read.disabled = true
        void readLocalFonts(controller.signal, (done, total) => {
          if (version === epoch && status) status.textContent = `读取本机字体 ${done}/${total}`
        })
          .then((fonts) => {
            if (version === epoch && current) return actions.system(fonts)
          })
          .then(() => {
            if (version === epoch && status && rows.size) status.textContent = '字体列表已更新。'
          })
          .catch((error) => {
            if (version === epoch) showError(error)
          })
          .finally(() => {
            if (version === epoch) read.disabled = !canReadLocalFonts()
          })
      })
      if (!canReadLocalFonts())
        status.textContent = '此浏览器无法直接列出本机字体，可以选择游戏字体或通用字体。'
      const footer = element('div')
      footer.className = 'font-actions'
      const stop = element('button', '停止游戏')
      stop.type = 'button'
      stop.addEventListener('click', () => {
        void actions.stop().catch(showError)
      })
      const cancel = element('button', '取消')
      cancel.type = 'button'
      cancel.addEventListener('click', dismiss)
      confirm = element('button', '确定')
      confirm.type = 'button'
      confirm.addEventListener('click', () => {
        if (current && selected) void actions.choose(current.id, selected)?.catch(showError)
      })
      footer.append(read, stop, cancel, confirm)
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault()
        dismiss()
      })
      dialog.addEventListener('keydown', (event) => {
        if (
          event.key === 'Enter' &&
          !event.isComposing &&
          choices?.contains(event.target as Node)
        ) {
          event.preventDefault()
          if (current && selected) void actions.choose(current.id, selected)?.catch(showError)
        }
      })
      dialog.append(heading, prompt, choices, preview, status, footer)
      document.body.append(dialog)
      renderChoices()
      dialog.showModal()
      rows.get(selected)?.focus()
    },
    close,
  }
}
