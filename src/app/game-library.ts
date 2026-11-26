import { LibraryClient } from '../player/library-client.ts'
import { createCddaSettings, formatCddaSettings, parseCddaSettings } from './cdda-settings.ts'
import type {
  LibraryGame,
  LibraryImport,
  LibraryProgress,
  LibraryStatus,
} from '../protocol/library.ts'

type CurrentGame = Omit<LibraryImport, 'operation'>
interface Options {
  changed?(): void
  current(): CurrentGame | undefined
  canPlay(): boolean
  play(game: LibraryGame): Promise<void>
  beforeRemove(game: LibraryGame): Promise<void>
  report(error: unknown): void
}
const amount = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`
export function createGameLibrary(root: HTMLElement, options: Options) {
  root.innerHTML = `<div class="library-heading"><div><p class="eyebrow">GAME LIBRARY</p><h2>游戏库</h2></div><button id="refresh-library">刷新列表</button></div><p id="library-status" role="status">正在检查浏览器存储…</p><form id="library-save-form"><label for="library-title">游戏名称</label><div class="library-save-row"><input id="library-title" maxlength="200" placeholder="使用当前游戏名称"><button id="save-library" disabled>保存当前游戏</button><button id="cancel-library" type="button" hidden>取消导入</button></div></form><progress id="library-progress" max="1" value="0" hidden aria-label="游戏库导入进度"></progress><p id="library-operation" role="status"></p><div id="library-games" class="library-games"></div><div class="library-foot"><span>移除游戏资源时保留存档。清除站点数据会同时清除游戏库和存档。</span><button id="persist-library" disabled>请求保留浏览器数据</button></div>`
  const el = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  let state: LibraryStatus | undefined,
    operation: string | undefined,
    revision = 0,
    reusedBytes = 0
  let changing = false
  let remoteOperation = false, userCancelled = false
  let shownGames = ''
  const client = new LibraryClient((progress: LibraryProgress) => {
    if (progress.operation !== operation) return
    const bar = el<HTMLProgressElement>('library-progress')
    bar.hidden = false
    bar.max = Math.max(1, progress.total)
    bar.value = progress.completed
    reusedBytes = Math.max(reusedBytes, progress.reused ?? 0)
    el('library-operation').textContent =
      (progress.phase === 'preparing'
        ? '正在准备来源…'
        : progress.phase === 'committing'
          ? '正在提交游戏目录…'
          : `正在保存 ${progress.file} · ${amount(progress.completed)} / ${amount(progress.total)}`) +
      (reusedBytes ? ` · 已复用 ${amount(reusedBytes)}` : '')
  })
  const updates =
    typeof BroadcastChannel === 'undefined'
      ? undefined
      : new BroadcastChannel('krkr2-library:v1:updates')
  const update = () => {
    const current = options.current()
    el<HTMLInputElement>('library-title').placeholder = current?.title ?? '使用当前游戏名称'
    el<HTMLButtonElement>('save-library').disabled =
      !state?.available || !!operation || changing || !current
    el<HTMLInputElement>('library-title').disabled = !!operation || changing
    el<HTMLButtonElement>('cancel-library').hidden = !operation
    el('cancel-library').textContent = remoteOperation ? '停止下载' : '取消导入'
    el<HTMLButtonElement>('persist-library').disabled =
      !state?.available || !!state.persisted || typeof navigator.storage?.persist !== 'function'
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-library-action]'))
      button.disabled = !!operation || changing || !options.canPlay()
    options.changed?.()
  }
  const refresh = async () => {
    const version = ++revision
    const latest = await client.call('list')
    if (version !== revision) return
    state = latest
    el('library-status').textContent = !state.available
      ? (state.reason ?? '此浏览器暂不支持游戏库。')
      : `${state.games.length} 个游戏${state.downloads?.length ? ` · ${state.downloads.length} 个未完成下载` : ''} · 资源 ${amount(state.games.reduce((sum, game) => sum + game.size, 0))}${state.usage !== undefined && state.quota !== undefined ? ` · 站点已用 ${amount(state.usage)} / 约 ${amount(state.quota)}` : ''}${state.persisted ? ' · 已获准保留数据' : ''}`
    const games = el('library-games')
    const signature = JSON.stringify([state.games, state.downloads ?? []])
    // Focus/BroadcastChannel refreshes must not detach a pressed button or a
    // focused editor when the catalog has not changed.
    if (signature === shownGames) {
      update()
      return
    }
    shownGames = signature
    const drafts = new Map<string, { title: string; entry: string; backend: string; discs: string }>()
    for (const row of games.querySelectorAll<HTMLElement>('[data-library-id]')) {
      if (!row.querySelector('details')?.open) continue
      const inputs = row.querySelectorAll('input')
      drafts.set(row.dataset.libraryId!, {
        title: inputs[0]!.value,
        entry: inputs[1]!.value,
        backend: row.querySelector('select')!.value,
        discs: row.querySelector('textarea')!.value,
      })
    }
    games.replaceChildren()
    for (const game of state.games) {
      const row = document.createElement('article')
      row.className = 'library-game'
      row.dataset.libraryId = game.id
      const info = document.createElement('div'),
        title = document.createElement('h3'),
        description = document.createElement('p')
      title.textContent = game.title
      description.textContent = `${amount(game.size)} · ${game.fileCount} 个源文件 · ${game.project ? game.project.directory || './' : '文件集合'} · ${game.entry}`
      info.append(title, description)
      const controls = document.createElement('div')
      controls.className = 'library-controls'
      const button = (name: string, task: () => Promise<void>) => {
        const node = document.createElement('button')
        node.textContent = name
        node.dataset.libraryAction = name
        node.addEventListener('click', () => {
          void task().catch(options.report)
        })
        return node
      }
      controls.append(
        button('启动', () => options.play(game)),
        button('移除资源', async () => {
          changing = true
          update()
          try {
            await options.beforeRemove(game)
            await client.call('remove', game.id)
            updates?.postMessage('changed')
            await refresh()
          } finally {
            changing = false
            update()
          }
        }),
      )
      const details = document.createElement('details'),
        label = document.createElement('summary')
      const draft = drafts.get(game.id)
      details.open = !!draft
      label.textContent = '启动设置'
      details.append(label)
      const form = document.createElement('form')
      form.className = 'library-settings'
      const name = document.createElement('input')
      name.value = draft?.title ?? game.title
      name.maxLength = 200
      name.required = true
      name.setAttribute('aria-label', '库中游戏名称')
      const entry = document.createElement('input')
      entry.value = draft?.entry ?? game.entry
      entry.required = true
      entry.setAttribute('aria-label', '库中启动脚本')
      const backend = document.createElement('select')
      backend.setAttribute('aria-label', '库中执行后端')
      for (const [value, title] of [
        ['auto', '自动选择'],
        ['asyncify', 'Asyncify'],
        ['jspi', 'JSPI'],
      ]) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = title
        backend.append(option)
      }
      backend.value = draft?.backend ?? game.backend
      const discs = createCddaSettings('库中游戏光盘映射')
      discs.input.value = formatCddaSettings(game.cddaDiscs)
      const savedDiscText = discs.input.value
      if (draft) discs.input.value = draft.discs
      const submit = document.createElement('button')
      submit.textContent = '保存设置'
      submit.dataset.libraryAction = 'settings'
      form.append(name, entry, backend, discs.element, submit)
      details.append(form)
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        let discChanges: Pick<LibraryGame, 'cddaDiscs'> = {}
        try {
          if (discs.input.value !== savedDiscText) discChanges = { cddaDiscs: parseCddaSettings(discs.input.value) }
        }
        catch (error) { options.report(error); return }
        changing = true
        update()
        void client
          .call('update', game.id, {
            title: name.value,
            entry: entry.value,
            backend: backend.value as LibraryGame['backend'],
            ...discChanges,
          })
          .then(async () => {
            updates?.postMessage('changed')
            await refresh()
          })
          .catch(options.report)
          .finally(() => {
            changing = false
            update()
          })
      })
      row.append(info, controls, details)
      games.append(row)
    }
    for (const download of state.downloads ?? []) {
      const row = document.createElement('article'), info = document.createElement('div'),
        title = document.createElement('h3'), description = document.createElement('p'),
        controls = document.createElement('div')
      row.className = 'library-download'
      row.dataset.libraryDownloadId = download.id
      title.textContent = download.title
      description.textContent = `未完成下载 · 资源 ${amount(download.size)} · ` + (download.reopenable
        ? '已保存的部分可继续下载，完成后即可从游戏库启动。'
        : '包含本地文件，请重新选择同一组文件并保存当前游戏，以继续下载。')
      info.append(title, description)
      controls.className = 'library-controls'
      const button = (name: string, task: () => Promise<void>) => {
        const node = document.createElement('button')
        node.textContent = name
        node.dataset.libraryAction = name
        node.addEventListener('click', () => { void task().catch(options.report) })
        return node
      }
      if (download.reopenable)
        controls.append(button('继续下载', () => importGame({ download: download.id })))
      controls.append(button('移除下载', async () => {
        changing = true
        update()
        try {
          await client.call('remove', download.id, true)
          el('library-operation').textContent = `已移除“${download.title}”的未完成下载。`
          updates?.postMessage('changed')
          await refresh()
        } finally {
          changing = false
          update()
        }
      }))
      row.append(info, controls)
      games.append(row)
    }
    update()
  }
  const importGame = async (request: CurrentGame | { download: string }) => {
    if (operation || changing || !state?.available) return
    operation = crypto.randomUUID()
    reusedBytes = 0
    remoteOperation = 'download' in request || request.files.some((file) => 'url' in file)
    userCancelled = false
    const remote = remoteOperation
    let stopped = false
    update()
    try {
      const game = await client.call('importGame', { ...request, operation })
      el('library-operation').textContent = `已保存“${game.title}”，刷新页面后可从游戏库启动。` +
        (reusedBytes ? ` 已复用 ${amount(reusedBytes)}。` : '')
      updates?.postMessage('changed')
    } catch (error) {
      if (userCancelled && error instanceof Error && error.name === 'AbortError') stopped = true
      else el('library-operation').textContent = error instanceof Error ? error.message : String(error)
    } finally {
      operation = undefined
      remoteOperation = false
      el<HTMLProgressElement>('library-progress').hidden = true
      update()
      await refresh()
      if (stopped && !operation) {
        const draft = state?.downloads?.find((download) => 'download' in request
          ? download.id === request.download : download.gameId === request.expectedGameId)
        el('library-operation').textContent = !remote ? '已取消导入。' : draft
          ? draft.reopenable ? '下载已停止，可从未完成下载继续或移除。'
            : '下载已停止。重新选择同一组文件后可继续，也可移除下载。'
          : '下载已停止。'
      }
    }
  }
  el('library-save-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const current = options.current()
    if (!current || operation || changing || !state?.available) return
    const request = {
      ...current,
      title: el<HTMLInputElement>('library-title').value.trim() || current.title,
    }
    void importGame(request).catch(options.report)
  })
  el('cancel-library').addEventListener('click', () => {
    if (!operation) return
    userCancelled = true
    el('library-operation').textContent = remoteOperation ? '正在停止下载…' : '正在取消导入…'
    void client.cancel(operation).catch(options.report)
  })
  el('persist-library').addEventListener('click', () => {
    void navigator.storage
      .persist()
      .then(async (persisted) => {
        el('library-operation').textContent = persisted
          ? '浏览器已获准保留数据。'
          : '浏览器未授予持久存储，仍可使用游戏库并导出存档备份。'
        await refresh()
      })
      .catch(options.report)
  })
  el('refresh-library').addEventListener('click', () => {
    void refresh().catch(options.report)
  })
  const onFocus = () => {
    if (!operation) void refresh().catch(options.report)
  }
  window.addEventListener('focus', onFocus)
  if (updates) updates.onmessage = onFocus
  void refresh().catch(options.report)
  return {
    titleFor(gameId: string) { return state?.games.find((game) => game.gameId === gameId)?.title },
    get busy() {
      return !!operation || changing
    },
    update,
    close() {
      window.removeEventListener('focus', onFocus)
      updates?.close()
      client.close()
    },
  }
}
