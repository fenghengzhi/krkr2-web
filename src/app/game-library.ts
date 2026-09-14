import { LibraryClient } from '../player/library-client.ts'
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
    revision = 0
  let changing = false
  let shownGames = ''
  const client = new LibraryClient((progress: LibraryProgress) => {
    if (progress.operation !== operation) return
    const bar = el<HTMLProgressElement>('library-progress')
    bar.hidden = false
    bar.max = Math.max(1, progress.total)
    bar.value = progress.completed
    el('library-operation').textContent =
      progress.phase === 'preparing'
        ? '正在准备来源…'
        : progress.phase === 'committing'
          ? '正在提交游戏目录…'
          : `正在保存 ${progress.file} · ${amount(progress.completed)} / ${amount(progress.total)}`
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
      : `${state.games.length} 个游戏 · 资源 ${amount(state.games.reduce((sum, game) => sum + game.size, 0))}${state.usage !== undefined && state.quota !== undefined ? ` · 站点已用 ${amount(state.usage)} / 约 ${amount(state.quota)}` : ''}${state.persisted ? ' · 已获准保留数据' : ''}`
    const games = el('library-games')
    const signature = JSON.stringify(state.games)
    // Focus/BroadcastChannel refreshes must not detach a pressed button or a
    // focused editor when the catalog has not changed.
    if (signature === shownGames) {
      update()
      return
    }
    shownGames = signature
    const drafts = new Map<string, { title: string; entry: string; backend: string }>()
    for (const row of games.querySelectorAll<HTMLElement>('[data-library-id]')) {
      if (!row.querySelector('details')?.open) continue
      const inputs = row.querySelectorAll('input')
      drafts.set(row.dataset.libraryId!, {
        title: inputs[0]!.value,
        entry: inputs[1]!.value,
        backend: row.querySelector('select')!.value,
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
      description.textContent = `${amount(game.size)} · ${game.fileCount} 个源文件 · ${game.entry}`
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
      const submit = document.createElement('button')
      submit.textContent = '保存设置'
      submit.dataset.libraryAction = 'settings'
      form.append(name, entry, backend, submit)
      details.append(form)
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        changing = true
        update()
        void client
          .call('update', game.id, {
            title: name.value,
            entry: entry.value,
            backend: backend.value as LibraryGame['backend'],
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
    update()
  }
  el('library-save-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const current = options.current()
    if (!current || operation || changing || !state?.available) return
    operation = crypto.randomUUID()
    const request = {
      ...current,
      operation,
      title: el<HTMLInputElement>('library-title').value.trim() || current.title,
    }
    update()
    void client
      .call('importGame', request)
      .then(async (game) => {
        el('library-operation').textContent = `已保存“${game.title}”，刷新页面后可从游戏库启动。`
        updates?.postMessage('changed')
      })
      .catch((error) => {
        el('library-operation').textContent = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        operation = undefined
        el<HTMLProgressElement>('library-progress').hidden = true
        update()
        void refresh().catch(options.report)
      })
  })
  el('cancel-library').addEventListener('click', () => {
    if (!operation) return
    el('library-operation').textContent = '正在取消导入…'
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
