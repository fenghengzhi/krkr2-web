import { createPlayer } from '../player/create-player.ts'
import { demoFiles } from './demo.ts'
import { encodeBackup, decodeBackup } from '../player/save-backup.ts'
import type { BackendPreference, GameInput } from '../protocol/session.ts'
import type { SessionSnapshot } from '../engine/session.ts'
import type { DebugPanel, DebugVisibility } from '../engine/diagnostics/panels.ts'
import { createGameMenus } from './game-menus.ts'
import { createGameWindows, type GameWindows } from './game-windows.ts'
import type { WindowPresentation } from '../engine/scene/window.ts'
import type { MenuSnapshot } from '../engine/scene/menus.ts'
import { createGameFonts } from './game-fonts.ts'
import type { FontDescriptor } from '../engine/ports/fonts.ts'
import { createGameLibrary } from './game-library.ts'
import { createOfflinePanel } from './offline.ts'
import { remoteUrl } from '../backends/files/http-range.ts'
import { normalizePath } from '../engine/storage/resolver.ts'
import { setText } from './dom.ts'
import {
  backgroundPreferenceKey,
  readPauseWhenHidden,
  writePauseWhenHidden,
} from './preferences.ts'

export function mountApp(root: HTMLDivElement): void {
  root.innerHTML = `
    <header><a class="brand" href="./"><span class="brand-mark">K</span> krkr2<span class="muted">/web</span></a><span class="edition">ENGINE PREVIEW <span class="dot"></span></span></header>
    <main>
      <section class="intro"><div><p class="eyebrow">KIRIKIRI, IN THE BROWSER</p><h1>让故事，在这里继续。</h1><p class="subtitle">载入脚本与资源，开启浏览器中的吉里吉里。</p></div><span class="local-tag">本地文件 / 远程链接 · 浏览器内运行</span></section>
      <div class="workspace">
        <section class="stage-panel" aria-label="游戏画面">
          <div class="stage-bar"><span id="game-title">尚未载入游戏</span><span id="status" role="status">待机</span></div>
          <div class="stage" id="stage"><div class="empty"><div class="empty-glyph">✦</div><h2>一个新的开场</h2><p>运行示例，或选择包含 startup.tjs 的文件集合。</p><button class="primary" id="demo">运行示例 <span>↗</span></button></div></div>
          <div class="debug-access" aria-label="调试面板"><button id="toggle-console" aria-controls="debug-console" aria-expanded="true">运行记录</button><button id="toggle-controller" aria-controls="debug-controller" aria-expanded="true">调试控制</button></div>
          <div class="transport" id="debug-controller"><span id="runtime-info">准备好后，点击画面与脚本交互</span><div><button id="retry-graphics" hidden>重试显示</button><button id="pause" disabled>暂停</button><button id="restart" disabled>重新开始</button><button id="stop" disabled>停止</button></div></div>
        </section>
        <aside>
          <section class="card"><p class="eyebrow">01 / GAME FILES</p><h2>载入你的文件</h2><p>支持裸文件、未加密 XP3 和 ZIP。文件按选择顺序挂载，后载入的同名资源覆盖前者。</p><button class="file-button" id="choose-files">选择文件 <span>＋</span></button><button class="file-button secondary" id="choose-folder">选择文件夹 <span>↗</span></button><input id="files" type="file" multiple hidden><input id="folder" type="file" webkitdirectory multiple hidden><form id="remote-form"><label for="remote-url">远程文件链接</label><input id="remote-url" type="url" placeholder="https://…/game.xp3" required autocomplete="off" spellcheck="false"><label for="remote-name">文件名（可选）</label><input id="remote-name" placeholder="使用链接中的文件名" spellcheck="false"><button class="file-button secondary" id="load-url" type="submit">载入链接 <span>↗</span></button></form><label for="entry">启动脚本</label><input id="entry" value="startup.tjs" spellcheck="false"><label for="backend">执行后端</label><select id="backend"><option value="auto">自动选择</option><option value="jspi">JSPI</option><option value="asyncify">Asyncify</option></select><label class="background-setting"><input id="script-debug" type="checkbox">脚本调试</label><p class="muted background-note">下次启动时记录调用栈，用于定位脚本错误。</p><label class="background-setting"><input id="pause-background" type="checkbox" checked>切到后台时暂停</label><p class="muted background-note">关闭后可在后台继续运行；浏览器冻结页面时仍会暂停。</p></section>
          <section class="card support"><p class="eyebrow">CURRENT BUILD</p><h2>基础运行时已接通</h2><p>TJS、KAG 解析、菜单、基础图层、计时器与存档文件。</p><p class="muted">完整 KAG 画面与音视频仍在实现中，暂不支持完整商业游戏。</p></section>
          <section class="card"><p class="eyebrow">AUDIO</p><h2>声音</h2><p id="sound-status">载入游戏后开启声音。</p><button class="file-button" id="sound-toggle" disabled>开启声音</button><meter id="sound-level" min="0" max="1" value="0" aria-label="声音电平"></meter></section>
          <section class="card"><p class="eyebrow">SAVE FILES</p><h2>存档与备份</h2><p id="save-status">游戏存档保存在此浏览器，可导出备份。</p><button class="file-button" id="export-saves" disabled>导出存档 <span>↓</span></button><button class="file-button secondary" id="import-saves" disabled>导入存档 <span>↑</span></button><input id="save-file" type="file" accept="application/json,.json" hidden></section>
        </aside>
      </div>
      <section class="card library-panel" id="library-panel"></section><section class="console-panel" id="debug-console"><div class="console-heading"><h2>运行记录</h2><div><button id="clear-log">清空</button><button id="hide-console" aria-label="隐藏运行记录">隐藏</button></div></div><div class="logs" id="logs" role="log" aria-live="polite"><p class="muted">等待会话启动…</p></div><form id="console"><span>›</span><input id="expression" aria-label="TJS 表达式" placeholder="输入 TJS 表达式，例如 6 * 7" autocomplete="off" spellcheck="false"><button id="evaluate" disabled>执行</button></form></section>
      <section class="card offline-panel" id="offline-panel"></section><footer><span>krkr2-web / a web-native runtime</span><span>TypeScript · WebAssembly · WebGL2</span></footer>
    </main>`
  const el = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  let player: ReturnType<typeof createPlayer> | undefined
  let lastFiles: GameInput | undefined
  let snapshot: SessionSnapshot | undefined
  let debugVisibility: DebugVisibility = { console: true, controller: true }
  const acceptSnapshot = (next: SessionSnapshot) => {
    if (!snapshot || next.revision >= snapshot.revision) snapshot = next
  }
  let generation = 0
  let busy = false
  let stopping: Promise<void> | undefined
  let library: ReturnType<typeof createGameLibrary> | undefined
  let offline: ReturnType<typeof createOfflinePanel> | undefined
  const log = (text: string, error = false) => {
    const line = document.createElement('p')
    line.className = error ? 'error' : ''
    const time = document.createElement('time')
    time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const message = document.createElement('span')
    message.textContent = text
    line.append(time, message)
    const logs = el('logs')
    logs.querySelector('p.muted')?.remove()
    logs.append(line)
    while (logs.children.length > 200) logs.firstElementChild?.remove()
    logs.scrollTop = logs.scrollHeight
  }
  const background = el<HTMLInputElement>('pause-background')
  background.checked = readPauseWhenHidden()
  background.addEventListener('change', () => {
    player?.setPauseWhenHidden(background.checked)
    if (!writePauseWhenHidden(background.checked)) log('本次后台设置已应用，浏览器未能保存该偏好。')
  })
  window.addEventListener('storage', (event) => {
    if (event.key !== backgroundPreferenceKey && event.key !== null) return
    background.checked = readPauseWhenHidden()
    player?.setPauseWhenHidden(background.checked)
  })
  const report = (error: unknown) =>
    log(error instanceof Error ? error.message : String(error), true)
  const menuViews = new Map<number, MenuSnapshot>()
  const windowViews = new Map<number, WindowPresentation>()
  const gameMenus = new Map<number, ReturnType<typeof createGameMenus>>()
  let fontSelecting = false
  const clearMenus = () => {
    for (const menus of gameMenus.values()) menus.dispose()
    gameMenus.clear()
    menuViews.clear()
    windowViews.clear()
    fontSelecting = false
  }
  const updateMenus = () => {
    for (const [id, menus] of gameMenus) {
      const view = windowViews.get(id)?.view
      menus.state(
        snapshot?.state === 'running' && snapshot.activity.state === 'visible' && !!view?.visible,
        view?.width,
        view?.height,
        snapshot?.eventDisabled,
      )
      menus.modal(fontSelecting)
    }
  }
  let systemFonts: FontDescriptor[] = []
  const gameFonts = createGameFonts({
    choose: (id, face) => player?.session.selectFont(id, face),
    preview: (id, face, kind) => player?.session.previewFont(id, face, kind),
    system: (fonts) => {
      systemFonts = fonts
      return player?.session.setSystemFonts(fonts)
    },
    stop: async () => {
      await stop()
    },
  })
  const update = () => {
    if (snapshot) debugVisibility = snapshot.debug
    for (const panel of ['console', 'controller'] as const) {
      const target = el('debug-' + panel),
        toggle = el('toggle-' + panel)
      if (!debugVisibility[panel] && target.contains(document.activeElement)) toggle.focus()
      target.hidden = !debugVisibility[panel]
      toggle.setAttribute('aria-expanded', String(debugVisibility[panel]))
    }
    library?.update()
    offline?.update()
    const labels = {
      initializing: '初始化',
      ready: '就绪',
      running: '运行中',
      paused: '已暂停',
      stopping: '停止中',
      stopped: '已停止',
      failed: '运行失败',
    }
    const graphics = snapshot?.graphics.state
    el('status').textContent =
      snapshot?.state === 'paused' && graphics !== 'ready'
        ? graphics === 'failed'
          ? '画面恢复失败'
          : '等待画面恢复'
        : snapshot?.state === 'paused' && snapshot.activity.state !== 'visible'
          ? snapshot.activity.state === 'frozen'
            ? '页面已冻结'
            : '后台已暂停'
          : snapshot?.state === 'running' && snapshot.eventDisabled
            ? '事件已停止'
            : snapshot
              ? labels[snapshot.state]
              : busy
                ? '正在载入'
                : '待机'
    el('stage').dataset.graphics = graphics ?? 'ready'
    el('stage').dataset.activity = snapshot?.activity.state ?? 'visible'
    el<HTMLButtonElement>('retry-graphics').hidden = graphics !== 'failed'
    el<HTMLButtonElement>('retry-graphics').disabled =
      !snapshot || ['failed', 'stopping', 'stopped'].includes(snapshot.state)
    updateMenus()
    el<HTMLButtonElement>('pause').disabled =
      !snapshot || !['running', 'paused'].includes(snapshot.state)
    setText(
      el('pause'),
      snapshot?.userPaused ? '继续' : snapshot?.state === 'paused' ? '保持暂停' : '暂停',
    )
    el<HTMLButtonElement>('stop').disabled = !player
    el<HTMLButtonElement>('restart').disabled = busy || !lastFiles
    el<HTMLButtonElement>('evaluate').disabled =
      busy || !snapshot || !['ready', 'running'].includes(snapshot.state)
    el<HTMLButtonElement>('export-saves').disabled = !player || busy
    el<HTMLButtonElement>('import-saves').disabled = !player || busy || snapshot?.state !== 'paused'
    if (snapshot)
      el('save-status').textContent =
        `${snapshot.saveFiles} 个存档文件${snapshot.pendingSaves ? `，${snapshot.pendingSaves} 个等待保存。可先导出备份。` : '，已保存到此浏览器。导入前请暂停游戏。'}`
    for (const id of ['choose-files', 'choose-folder', 'load-url', 'remote-url', 'remote-name'])
      el<HTMLInputElement>(id).disabled = busy
    if (snapshot) {
      el('game-title').textContent = snapshot.title
      el('runtime-info').textContent =
        `${snapshot.backend.toUpperCase()} · ${snapshot.resources} 个资源 · ${snapshot.layers} 个图层 · ${(snapshot.memoryBytes / 1048576).toFixed(1)} MB VM`
    }
  }
  const setDebugVisibility = async (panel: DebugPanel, visible: boolean) => {
    const current = generation,
      instance = player
    if (snapshot && instance) {
      const next = await instance.session.setDebugVisibility(panel, visible)
      if (current !== generation || player !== instance) return
      acceptSnapshot(next)
    } else debugVisibility = { ...debugVisibility, [panel]: visible }
    update()
  }
  for (const panel of ['console', 'controller'] as const)
    el('toggle-' + panel).addEventListener('click', () => {
      void setDebugVisibility(panel, !debugVisibility[panel]).catch(report)
    })
  el('hide-console').addEventListener('click', () => {
    void setDebugVisibility('console', false).catch(report)
  })
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    const previous = player
    busy = true
    update()
    stopping = (async () => {
      try {
        await previous?.stop()
        generation++
        player = undefined
        snapshot = undefined
        clearMenus()
        gameFonts.close()
      } catch (error) {
        if (previous?.session.isDisposed) {
          generation++
          player = undefined
          snapshot = undefined
          clearMenus()
        } else if (previous) acceptSnapshot(await previous.session.inspect())
        throw error
      } finally {
        busy = false
        update()
      }
    })().finally(() => {
      stopping = undefined
    })
    return stopping
  }
  const launch = async (files: GameInput) => {
    await stop()
    const current = ++generation
    busy = true
    lastFiles = files
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    canvas.setAttribute('aria-label', '游戏画布')
    el('stage').replaceChildren(canvas)
    const windows: GameWindows = createGameWindows(el('stage'), canvas, (action) => {
      if (current !== generation || !windows.get(action.windowId, action.surfaceEpoch)) return
      if (action.type === 'activate') instance.focusWindow(action.windowId, action.surfaceEpoch)
      else {
        const session = instance.session
        const operation =
          action.type === 'close'
            ? session.closeWindow(action.windowId)
            : action.type === 'move'
              ? session.moveWindow(action.windowId, action.left, action.top)
              : action.type === 'resize'
                ? session.resizeWindow(action.windowId, action.width, action.height)
                : session.exitFullScreen(action.windowId)
        void operation.catch(report)
      }
    })
    const instance: ReturnType<typeof createPlayer> = createPlayer(
      canvas,
      (event) => {
        if (current !== generation) return
        if (event.type === 'log') log(event.text, event.level === 'error')
        else if (event.type === 'font-selection') {
          gameFonts.update(event.request)
          fontSelecting = !!event.request
          updateMenus()
        } else if (event.type === 'window-menus') {
          menuViews.clear()
          for (const { windowId, menus } of event.windows) menuViews.set(windowId, menus)
          for (const [id, menus] of gameMenus) menus.update(menuViews.get(id) ?? {})
        } else if (event.type === 'windows') {
          windowViews.clear()
          for (const window of event.windows) windowViews.set(window.id, window)
          updateMenus()
        } else if (event.type === 'state') {
          acceptSnapshot(event.snapshot)
          update()
          // A native main-window close finishes the engine independently of
          // the transport button. Retire its page hosts and Worker as well.
          if (event.snapshot.state === 'stopped') void stop().catch(report)
        }
      },
      (audio) => {
        if (current !== generation) return
        const button = el<HTMLButtonElement>('sound-toggle'),
          meter = el<HTMLMeterElement>('sound-level')
        button.disabled = audio.state === 'closed' || audio.state === 'unavailable'
        setText(button, audio.state !== 'running' ? '开启声音' : audio.muted ? '取消静音' : '静音')
        el('sound-status').textContent = audio.error
          ? audio.error
          : audio.state === 'running'
            ? audio.muted
              ? '声音已静音。'
              : '声音已开启。'
            : audio.state === 'suspended'
              ? '点击开启声音后播放。'
              : audio.state === 'closed'
                ? '声音已关闭。'
                : '浏览器音频不可用。'
        meter.value = audio.muted ? 0 : audio.peak
        meter.dataset.maxPeak = String(audio.maxPeak)
        meter.dataset.frames = String(audio.frames)
      },
      el<HTMLInputElement>('pause-background').checked,
      {
        windows,
        onSurfaceAttach(surface) {
          if (current !== generation) return
          if (!el('stage').querySelector('#game-menus')) surface.menu.id = 'game-menus'
          const menus = createGameMenus(
            surface.menu,
            () => windows.get(surface.windowId, surface.surfaceEpoch)?.canvas ?? null,
            (id, popup) => {
              if (current !== generation || instance.session.isDisposed) return
              void instance.session.menuClick(id, popup).catch(report)
            },
            (popup) => {
              if (current !== generation || instance.session.isDisposed) return
              void instance.session.menuDismiss(popup).catch(report)
            },
            { active: () => instance.isWindowActive(surface.windowId, surface.surfaceEpoch) },
          )
          gameMenus.set(surface.windowId, menus)
          menus.update(menuViews.get(surface.windowId) ?? {})
          updateMenus()
        },
        onSurfaceDetach(surface) {
          gameMenus.get(surface.windowId)?.dispose()
          gameMenus.delete(surface.windowId)
        },
      },
    )
    player = instance
    void instance.session.setSystemFonts(systemFonts).catch(report)
    canvas.addEventListener('playererror', (event) =>
      report((event as CustomEvent<unknown>).detail),
    )
    update()
    try {
      const preference = el<HTMLSelectElement>('backend').value as BackendPreference
      const requested = new URLSearchParams(location.search).get('backend')
      const loaded = await instance.load(
        files,
        el<HTMLInputElement>('entry').value.trim() || 'startup.tjs',
        requested === 'asyncify' || requested === 'jspi' ? requested : preference,
        el<HTMLInputElement>('script-debug').checked,
      )
      if (current === generation && !stopping) {
        acceptSnapshot(loaded)
        log('会话就绪。点击画面继续。')
      }
    } catch (error) {
      if (current === generation && !stopping) {
        report(error)
        try {
          await instance.stop()
        } catch (stopError) {
          report(stopError)
        }
        if (instance.session.isDisposed) player = undefined
        if (snapshot) snapshot = { ...snapshot, state: 'failed' }
      }
    } finally {
      if (current === generation && !stopping) {
        busy = false
        update()
      }
    }
  }
  library = createGameLibrary(el('library-panel'), {
    changed: () => offline?.update(),
    current: () =>
      !busy && player && snapshot?.state !== 'failed' && Array.isArray(lastFiles)
        ? {
            files: lastFiles,
            expectedGameId: player.gameId,
            title:
              snapshot?.title && snapshot.title !== 'krkr2-web'
                ? snapshot.title
                : lastFiles[0]?.path.replace(/\.[^/.]+$/, '') || 'Game',
            entry: el<HTMLInputElement>('entry').value.trim() || 'startup.tjs',
            backend: el<HTMLSelectElement>('backend').value as BackendPreference,
          }
        : undefined,
    canPlay: () => !busy,
    play: async (game) => {
      el<HTMLInputElement>('entry').value = game.entry
      el<HTMLSelectElement>('backend').value = game.backend
      await launch({ libraryId: game.id })
    },
    beforeRemove: async (game) => {
      if (lastFiles && !Array.isArray(lastFiles) && lastFiles.libraryId === game.id) {
        await stop()
        lastFiles = undefined
        update()
      }
    },
    report,
  })
  offline = createOfflinePanel(el('offline-panel'), {
    canReload: () => !busy && !library?.busy,
    beforeReload: async () => {
      if (busy || library?.busy)
        throw new Error('Wait for loading or library import to finish before reloading')
      await stop()
    },
  })
  el('demo').addEventListener('click', () => {
    void demoFiles().then(launch).catch(report)
  })
  el('remote-form').addEventListener('submit', (event) => {
    event.preventDefault()
    if (busy) return
    try {
      const url = remoteUrl(el<HTMLInputElement>('remote-url').value.trim())
      const basename = new URL(url).pathname.split('/').pop() || 'game.archive'
      let inferred = basename
      try {
        inferred = decodeURIComponent(basename)
      } catch {
        /* Keep a literal malformed escape. */
      }
      const path = normalizePath(el<HTMLInputElement>('remote-name').value.trim() || inferred)
      if (path.includes('>')) throw new Error('文件名不能包含 >')
      void launch([{ path, url }]).catch(report)
    } catch (error) {
      report(error)
    }
  })
  el('stop').addEventListener('click', () => {
    void stop().catch(report)
  })
  el('sound-toggle').addEventListener('click', () => player?.toggleAudio())
  el('restart').addEventListener('click', () => {
    if (lastFiles) void launch(lastFiles).catch(report)
  })
  el('retry-graphics').addEventListener('click', () => {
    void player?.session.retryGraphics().catch(report)
  })
  el('pause').addEventListener('click', () => {
    const operation = snapshot?.userPaused ? player?.session.resume() : player?.session.pause()
    void operation
      ?.then((result) => {
        acceptSnapshot(result)
        update()
      })
      .catch(report)
  })
  for (const [button, input] of [
    ['choose-files', 'files'],
    ['choose-folder', 'folder'],
  ] as const) {
    el(button).addEventListener('click', () => el<HTMLInputElement>(input).click())
    el<HTMLInputElement>(input).addEventListener('change', (event) => {
      const element = event.currentTarget as HTMLInputElement
      const selected = Array.from(element.files ?? [])
      if (!selected.length) return
      const files = selected.map((file) => ({
        path:
          input === 'folder' ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name,
        blob: file,
      }))
      element.value = ''
      void launch(files).catch(report)
    })
  }
  el('clear-log').addEventListener('click', () => el('logs').replaceChildren())
  el('export-saves').addEventListener('click', () => {
    const current = player
    if (!current) return
    void current.session
      .exportSaves()
      .then((files) => {
        const url = URL.createObjectURL(encodeBackup(current.gameId, files))
        const link = document.createElement('a')
        link.href = url
        link.download = 'krkr2-saves.json'
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        log(`已导出 ${files.length} 个存档文件`)
      })
      .catch(report)
  })
  el('import-saves').addEventListener('click', () => el<HTMLInputElement>('save-file').click())
  el<HTMLInputElement>('save-file').addEventListener('change', (event) => {
    const element = event.currentTarget as HTMLInputElement,
      file = element.files?.[0],
      current = player
    element.value = ''
    if (!file || !current) return
    void decodeBackup(current.gameId, file)
      .then((files) => current.session.importSaves(files))
      .then(() => log('存档已导入，请通过游戏的读档功能恢复进度'))
      .catch(report)
  })
  el('console').addEventListener('submit', (event) => {
    event.preventDefault()
    const source = el<HTMLInputElement>('expression').value.trim()
    if (!source || !player) return
    el('expression').focus()
    log(`› ${source}`)
    void player.session
      .evaluate(source)
      .then((value) => log(value))
      .catch(report)
  })
}
