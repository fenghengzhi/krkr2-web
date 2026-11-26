import type { SaveTransferSource } from '../engine/ports/saves.ts'
import type { SessionClient } from '../player/session-client.ts'

const chooseDirectory = '?'

function sourceDirectories(paths: string[]): string[] {
  const directories = new Set([''])
  for (const path of paths) {
    for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1))
      directories.add(path.slice(0, slash + 1))
  }
  return [...directories].sort()
}

export function createSaveTransfer(root: HTMLElement, options: {
  titleFor: (id: string) => string | undefined
  run: (action: (session: SessionClient, check: () => void) => Promise<void>) => void
}) {
  root.innerHTML = `
    <button type="button" id="open-save-transfer" class="file-button secondary" aria-controls="transfer-panel" aria-expanded="false" disabled>从其他版本复制存档</button>
    <section id="transfer-panel" aria-label="从其他版本复制存档" hidden>
      <label for="transfer-source">来源游戏版本</label><select id="transfer-source"></select>
      <label for="transfer-directory">来源存档目录</label><select id="transfer-directory"></select>
      <p id="transfer-destination" class="muted"></p>
      <label class="background-setting"><input type="checkbox" id="transfer-replace"> 替换当前游戏的同名文件</label>
      <button type="button" id="confirm-save-transfer" class="file-button">复制到当前游戏</button>
      <button type="button" id="close-save-transfer" class="file-button secondary">关闭</button>
      <p id="transfer-status" role="status"></p>
    </section>`
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!
  const open = get<HTMLButtonElement>('open-save-transfer'), panel = get('transfer-panel')
  const source = get<HTMLSelectElement>('transfer-source'), directory = get<HTMLSelectElement>('transfer-directory')
  const replace = get<HTMLInputElement>('transfer-replace'), confirm = get<HTMLButtonElement>('confirm-save-transfer')
  const close = get<HTMLButtonElement>('close-save-transfer'), status = get('transfer-status'), destination = get('transfer-destination')
  let session: SessionClient | undefined, blocked = true, loading = false, revision = 0
  let versions: SaveTransferSource[] = []
  const render = () => {
    open.disabled = !session || blocked || !panel.hidden
    source.disabled = blocked || loading || !versions.length
    directory.disabled = blocked || loading || !source.value || directory.options.length < 2
    confirm.disabled = directory.disabled || directory.value === chooseDirectory
    replace.disabled = confirm.disabled
    close.disabled = blocked
  }
  const clearDirectory = () => {
    directory.replaceChildren(new Option('请选择目录', chooseDirectory))
    replace.checked = false
    destination.textContent = ''
    status.textContent = ''
  }
  const reset = () => {
    revision++
    versions = []
    loading = false
    source.replaceChildren(new Option('请选择来源版本', ''))
    clearDirectory()
    panel.hidden = true
    open.setAttribute('aria-expanded', 'false')
  }
  reset()
  close.addEventListener('click', () => { reset(); render(); open.focus() })
  open.addEventListener('click', async () => {
    if (!session || blocked) return
    const epoch = ++revision
    panel.hidden = false
    open.setAttribute('aria-expanded', 'true')
    status.textContent = '正在读取此浏览器中已保存的版本…'
    loading = true
    render()
    try {
      const rows = await session.listSaveVersions()
      if (epoch !== revision) return
      versions = rows
      for (const { gameId, profile } of rows) {
        const title = options.titleFor(gameId) || profile?.title || '历史存档'
        source.add(new Option(title + ' · ' + gameId.slice(5, 15), gameId))
      }
      status.textContent = rows.length ? '请选择要复制存档的游戏版本。' : '此浏览器中还没有其他版本的存档。'
    } catch (error) {
      if (epoch === revision) status.textContent = String(error)
    } finally {
      if (epoch === revision) { loading = false; render() }
    }
  })
  source.addEventListener('change', async () => {
    const epoch = ++revision, id = source.value
    clearDirectory()
    if (!id || !session) { render(); return }
    loading = true
    status.textContent = '正在读取来源目录…'
    render()
    try {
      const response = await session.saveVersionPaths(id)
      if (epoch !== revision) return
      const directories = response.paths.length ? sourceDirectories(response.paths) : []
      for (const path of directories) directory.add(new Option(path || '根目录（全部文件）', path))
      const profile = versions.find((row) => row.gameId === id)?.profile
      const saved = directories.find((path) => path.toLowerCase() === profile?.directory.toLowerCase())
      const conventional = directories.filter((path) => /(?:^|\/)savedata\/$/i.test(path))
      directory.value = saved ?? (conventional.length === 1 ? conventional[0]! : chooseDirectory)
      destination.textContent = '复制到当前游戏的 ' + (response.destination || '根目录')
      status.textContent = directories.length ? '将复制所选目录及其子目录中的文件。' : '该版本已没有存档文件。'
    } catch (error) {
      if (epoch === revision) status.textContent = String(error)
    } finally {
      if (epoch === revision) { loading = false; render() }
    }
  })
  directory.addEventListener('change', () => {
    replace.checked = false
    status.textContent = ''
    render()
  })
  confirm.addEventListener('click', () => {
    if (confirm.disabled) return
    const epoch = revision, id = source.value, path = directory.value, overwrite = replace.checked
    options.run(async (current, check) => {
      try {
        status.textContent = '正在复制存档…'
        const result = await current.copyVersionSaves(id, path, overwrite)
        check()
        if (epoch === revision)
          status.textContent = `已复制 ${result.copied} 个文件，保留 ${result.kept} 个同名文件。请通过游戏的读档功能恢复进度。`
      } catch (error) {
        if (epoch === revision) status.textContent = String(error)
        throw error
      }
    })
  })
  return {
    update(current: SessionClient | undefined, paused: boolean, busy: boolean) {
      const next = paused ? current : undefined
      if (next !== session) reset()
      session = next
      blocked = busy
      render()
    },
  }
}
