import { createOfflineApp } from '../pwa/client.ts'
import { setText } from './dom.ts'
interface InstallEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: string }>
}
export function createOfflinePanel(
  root: HTMLElement,
  options: { canReload(): boolean; beforeReload(): Promise<void> },
) {
  root.innerHTML = `<div><p class="eyebrow">OFFLINE APP</p><h2>离线启动</h2><p id="offline-status" role="status"></p></div><div class="offline-actions"><button id="prepare-offline">准备离线启动</button><button id="reload-offline" hidden>停止并重新载入应用</button><button id="install-app" hidden>安装应用</button></div>`
  const el = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  let prompt: InstallEvent | undefined
  const app = createOfflineApp({
    ...options,
    changed(state) {
      el('offline-status').textContent = state.message
      root.dataset.ready = String(state.ready)
      const prepare = el<HTMLButtonElement>('prepare-offline'),
        reload = el<HTMLButtonElement>('reload-offline')
      prepare.disabled = !state.supported || state.busy
      setText(prepare, state.ready ? '检查应用更新' : '准备离线启动')
      reload.hidden = !state.reload
      reload.disabled = state.busy || !options.canReload()
    },
  })
  el('prepare-offline').addEventListener('click', () => {
    void app.prepare()
  })
  el('reload-offline').addEventListener('click', () => {
    void app.reload()
  })
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    prompt = event as InstallEvent
    el('install-app').hidden = false
  })
  window.addEventListener('appinstalled', () => {
    prompt = undefined
    el('install-app').hidden = true
  })
  el('install-app').addEventListener('click', () => {
    const current = prompt
    if (!current) return
    prompt = undefined
    el('install-app').hidden = true
    void current
      .prompt()
      .then(() => current.userChoice)
      .catch(() => {})
  })
  return app
}
