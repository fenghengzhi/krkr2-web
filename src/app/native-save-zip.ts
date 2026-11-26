import { openNativeSaveZip } from '../player/native-saves.ts'
import { openSaveBackup } from '../player/save-backup.ts'
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
    <button type="button" id="choose-save-backup" class="file-button secondary" disabled>从浏览器备份选择存档目录</button>
    <input id="save-directory-backup" type="file" accept=".json,application/json" hidden>
    <section id="save-zip-panel" aria-label="导入 ZIP 中的存档目录" hidden>
      <label for="save-zip-directory">ZIP 内的存档目录</label><select id="save-zip-directory"></select>
      <p id="save-zip-summary" role="status"></p>
      <button type="button" id="import-save-zip-directory" class="file-button">导入此目录</button>
      <button type="button" id="cancel-save-zip" class="file-button secondary">取消</button>
    </section>`
  const choose = root.querySelector<HTMLButtonElement>('#choose-save-zip')!
  const input = root.querySelector<HTMLInputElement>('#save-directory-zip')!
  const chooseBackup = root.querySelector<HTMLButtonElement>('#choose-save-backup')!
  const backupInput = root.querySelector<HTMLInputElement>('#save-directory-backup')!
  const panel = root.querySelector<HTMLElement>('#save-zip-panel')!
  const directory = root.querySelector<HTMLSelectElement>('#save-zip-directory')!
  const summary = root.querySelector<HTMLElement>('#save-zip-summary')!
  const confirm = root.querySelector<HTMLButtonElement>('#import-save-zip-directory')!
  const cancel = root.querySelector<HTMLButtonElement>('#cancel-save-zip')!
  let session: SessionClient | undefined, busy = true, nativeFormat = true, revision = 0, pickerRevision: number | undefined
  let archive: Awaited<ReturnType<typeof openNativeSaveZip>> | undefined, fits = false
  let sourceKind: 'zip' | 'backup' = 'zip', sourceGameId: string | undefined, selectedDirectory = true
  const render = () => {
    choose.disabled = chooseBackup.disabled = busy || !session
    choose.hidden = !nativeFormat
    panel.hidden = !archive
    directory.disabled = cancel.disabled = busy
    confirm.disabled = busy || !fits
  }
  const reset = () => {
    revision++
    archive = undefined
    sourceGameId = undefined
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
    if (!selectedDirectory) list.append(new Option('请选择来源存档目录', '?'))
    for (const path of [...paths, ...children]) list.append(new Option(path || (sourceKind === 'zip' ? 'ZIP 根目录' : '备份根目录（全部文件）'), path))
    directory.replaceChildren(list)
    directory.value = selectedDirectory ? prefix : '?'
    fits = allowed && selectedDirectory
    summary.textContent = `${archive.name}${sourceGameId ? ' · 来源游戏 ' + sourceGameId : ''} · 共 ${count} 个文件，${(size / 1048576).toFixed(1)} MiB。` +
      (!selectedDirectory ? '请选择来源存档目录。所选目录的内容会写入当前游戏的存档目录，并替换同名文件。' : allowed ? '导入后保留子目录，替换当前游戏的同名存档。' :
        count ? '超出存档限额，请选择更小的子目录。' : '目录中没有存档文件。')
    render()
  }
  choose.addEventListener('click', () => { pickerRevision = revision; input.click() })
  input.addEventListener('cancel', () => { pickerRevision = undefined })
  chooseBackup.addEventListener('click', () => { pickerRevision = revision; backupInput.click() })
  backupInput.addEventListener('cancel', () => { pickerRevision = undefined })
  const open = (file: File, kind: 'zip' | 'backup' = 'zip') => {
    if (!session || busy || (kind === 'zip' && !nativeFormat)) return
    reset()
    sourceKind = kind
    selectedDirectory = kind === 'zip'
    root.querySelector('label[for="save-zip-directory"]')!.textContent = kind === 'zip' ? 'ZIP 内的存档目录' : '浏览器备份中的存档目录'
    panel.setAttribute('aria-label', kind === 'zip' ? '导入 ZIP 中的存档目录' : '迁移浏览器备份中的存档目录')
    const openedAt = revision
    options.run(async (_, check) => {
      const active = () => {
        check()
        if (openedAt !== revision) throw new Error('存档目录选择已关闭')
      }
      try {
        const index = kind === 'zip' ? await openNativeSaveZip(file, active, options.encoding()) : await openSaveBackup(file, active)
        active()
        archive = index
        sourceGameId = 'gameId' in index && typeof index.gameId === 'string' ? index.gameId : undefined
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
  backupInput.addEventListener('change', () => {
    const file = backupInput.files?.[0], selectedAt = pickerRevision
    backupInput.value = ''; pickerRevision = undefined
    if (file && selectedAt === revision) open(file, 'backup')
  })
  directory.addEventListener('change', () => {
    if (directory.value === '?') return
    selectedDirectory = true
    navigate(directory.value)
  })
  cancel.addEventListener('click', () => { reset(); (sourceKind === 'zip' ? choose : chooseBackup).focus() })
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
    update(current: SessionClient | undefined, blocked: boolean, native = true) {
      busy = blocked
      if (session !== current || nativeFormat !== native) { session = current; nativeFormat = native; reset() }
      else render()
    },
  }
}
