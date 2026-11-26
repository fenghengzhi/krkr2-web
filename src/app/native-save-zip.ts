import { openNativeSaveZip } from '../player/native-saves.ts'
import type { ZipNameEncoding } from '../formats/zip/names.ts'
import type { SessionClient } from '../player/session-client.ts'

export function createNativeSaveZipPicker(root: HTMLElement, options: {
  encoding(): ZipNameEncoding
  run(action: (session: SessionClient, check: () => void) => Promise<void>): void
  imported(): void
}) {
  root.innerHTML = `
    <button type="button" id="choose-save-zip" class="file-button secondary" disabled>从 ZIP 中选择存档目录</button>
    <input id="save-directory-zip" type="file" accept=".zip,application/zip" hidden>
    <section id="save-zip-panel" aria-label="导入 ZIP 中的存档目录" hidden>
      <label for="save-zip-directory">ZIP 内的存档目录</label><select id="save-zip-directory"></select>
      <p id="save-zip-summary" role="status"></p>
      <button type="button" id="import-save-zip-directory" class="file-button">导入此目录</button>
      <button type="button" id="cancel-save-zip" class="file-button secondary">取消</button>
    </section>`
  const choose = root.querySelector<HTMLButtonElement>('#choose-save-zip')!
  const input = root.querySelector<HTMLInputElement>('#save-directory-zip')!
  const panel = root.querySelector<HTMLElement>('#save-zip-panel')!
  const directory = root.querySelector<HTMLSelectElement>('#save-zip-directory')!
  const summary = root.querySelector<HTMLElement>('#save-zip-summary')!
  const confirm = root.querySelector<HTMLButtonElement>('#import-save-zip-directory')!
  const cancel = root.querySelector<HTMLButtonElement>('#cancel-save-zip')!
  let session: SessionClient | undefined, busy = true, revision = 0, pickerRevision: number | undefined
  let archive: Awaited<ReturnType<typeof openNativeSaveZip>> | undefined, fits = false
  const render = () => {
    choose.disabled = busy || !session
    panel.hidden = !archive
    directory.disabled = cancel.disabled = busy
    confirm.disabled = busy || !fits
  }
  const reset = () => {
    revision++
    archive = undefined
    fits = false
    directory.replaceChildren()
    summary.textContent = ''
    render()
  }
  const navigate = (prefix: string) => {
    if (!archive) return
    const { children, count, size, fits: allowed } = archive.directory(prefix)
    const paths = ['']
    for (let slash = prefix.indexOf('/'); slash >= 0; slash = prefix.indexOf('/', slash + 1))
      paths.push(prefix.slice(0, slash + 1))
    const list = document.createDocumentFragment()
    for (const path of [...paths, ...children]) list.append(new Option(path || 'ZIP 根目录', path))
    directory.replaceChildren(list)
    directory.value = prefix
    fits = allowed
    summary.textContent = `${archive.name} · 共 ${count} 个文件，${(size / 1048576).toFixed(1)} MiB。` +
      (allowed ? '导入后保留子目录，替换当前游戏的同名存档。' :
        count ? '超出存档限额，请选择更小的子目录。' : '目录中没有存档文件。')
    render()
  }
  choose.addEventListener('click', () => { pickerRevision = revision; input.click() })
  input.addEventListener('cancel', () => { pickerRevision = undefined })
  const open = (file: File) => {
    if (!session || busy) return
    reset()
    const openedAt = revision
    options.run(async (_, check) => {
      const active = () => {
        check()
        if (openedAt !== revision) throw new Error('存档目录选择已关闭')
      }
      try {
        const index = await openNativeSaveZip(file, active, options.encoding())
        active()
        archive = index
        navigate('')
      } catch (error) { if (openedAt === revision) throw error }
    })
  }
  input.addEventListener('change', () => {
    const file = input.files?.[0], selectedAt = pickerRevision
    input.value = ''
    pickerRevision = undefined
    if (file && selectedAt === revision) open(file)
  })
  directory.addEventListener('change', () => navigate(directory.value))
  cancel.addEventListener('click', () => { reset(); choose.focus() })
  confirm.addEventListener('click', () => {
    const selected = archive, prefix = directory.value, openedAt = revision
    if (!selected || confirm.disabled) return
    options.run(async (current, check) => {
      try {
        const entries = await selected.read(prefix)
        check()
        if (openedAt !== revision) return
        await current.importSaves(entries, 'data-directory')
        check()
        if (openedAt === revision) { reset(); options.imported() }
      } catch (error) { if (openedAt === revision) throw error }
    })
  })
  return {
    reset, open,
    update(current: SessionClient | undefined, blocked: boolean) {
      busy = blocked
      if (session !== current) { session = current; reset() }
      else render()
    },
  }
}
