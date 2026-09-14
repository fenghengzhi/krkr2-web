export interface ShellStatus {
  build: string
  ready: boolean
  bytes: number
  assets: number
  missing: string[]
}
export interface OfflineState {
  supported: boolean
  busy: boolean
  ready: boolean
  reload: boolean
  message: string
}
interface Options {
  canReload(): boolean
  beforeReload(): Promise<void>
  changed(state: OfflineState): void
}
export function createOfflineApp(options: Options) {
  const root = new URL(import.meta.env.BASE_URL, location.origin),
    url = new URL('sw.js', root).href
  const build = document.querySelector<HTMLMetaElement>('meta[name="krkr-build"]')?.content ?? ''
  const supported =
    import.meta.env.PROD &&
    /^[a-f0-9]{64}$/.test(build) &&
    'serviceWorker' in navigator &&
    !!navigator.locks &&
    isSecureContext
  let registration: ServiceWorkerRegistration | undefined,
    busy = false,
    ready = false,
    reload = false,
    message = supported ? '可保存应用，以便离线启动游戏库。' : '当前环境未启用应用离线缓存。'
  let revision = 0
  const notify = () => options.changed({ supported, busy, ready, reload, message })
  const own = (reg: ServiceWorkerRegistration) =>
    reg.scope === root.href &&
    [reg.active, reg.waiting, reg.installing].every((worker) => !worker || worker.scriptURL === url)
  const ask = (worker: ServiceWorker, type: 'STATUS' | 'ACTIVATE' | 'REPAIR') =>
    new Promise<ShellStatus>((resolve, reject) => {
      const channel = new MessageChannel()
      const timer = setTimeout(
        () => {
          channel.port1.close()
          channel.port2.close()
          reject(new Error('Offline worker did not respond'))
        },
        type === 'REPAIR' ? 70000 : 5000,
      )
      channel.port1.onmessage = (event) => {
        clearTimeout(timer)
        channel.port1.close()
        channel.port2.close()
        if (event.data?.error) reject(new Error(event.data.error))
        else resolve(event.data)
      }
      try {
        worker.postMessage({ type, build }, [channel.port2])
      } catch (error) {
        clearTimeout(timer)
        channel.port1.close()
        channel.port2.close()
        reject(error)
      }
    })
  const refresh = async () => {
    if (!registration) return
    const sequence = ++revision,
      target = registration.waiting ?? registration.active
    if (!target) return
    const status = await ask(target, 'STATUS')
    if (sequence !== revision) return
    ready = status.ready
    reload =
      ready &&
      (!!registration.waiting ||
        navigator.serviceWorker.controller?.scriptURL !== url ||
        status.build !== build)
    message = !ready
      ? '应用缓存不完整，请联网后重新准备。'
      : reload
        ? '应用已保存；重新载入后使用离线版本。'
        : `应用已可离线启动 · ${(status.bytes / 1048576).toFixed(1)} MiB。`
    notify()
  }
  const watch = (reg: ServiceWorkerRegistration) => {
    if (registration === reg) return
    registration = reg
    const installing = () => {
      const worker = reg.installing
      if (worker)
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' || worker.state === 'activated')
            void refresh().catch(() => {})
        })
    }
    reg.addEventListener('updatefound', installing)
    installing()
  }
  const installed = (worker: ServiceWorker) =>
    new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (['installed', 'activated'].includes(worker.state)) {
          clearTimeout(timer)
          worker.removeEventListener('statechange', finish)
          resolve()
        } else if (worker.state === 'redundant') {
          clearTimeout(timer)
          worker.removeEventListener('statechange', finish)
          reject(new Error('应用缓存准备失败，请检查网络、可用空间和部署文件后重试。'))
        }
      }
      const timer = setTimeout(() => {
        worker.removeEventListener('statechange', finish)
        reject(new Error('应用缓存准备超时，请稍后重试。'))
      }, 70000)
      worker.addEventListener('statechange', finish)
      finish()
    })
  const controllerChanged = () => {
    void refresh().catch(() => {})
  }
  if (supported) {
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged)
    void navigator.serviceWorker
      .getRegistration(root.href)
      .then(async (reg) => {
        if (reg && own(reg)) {
          watch(reg)
          await refresh()
          void reg.update().catch(() => {})
        }
      })
      .catch((error) => {
        message = String(error)
        notify()
      })
  }
  notify()
  return {
    update: notify,
    async prepare() {
      if (!supported || busy) return
      busy = true
      message = '正在保存应用与运行组件…'
      notify()
      try {
        const previous = await navigator.serviceWorker.getRegistration(root.href)
        if (previous?.scope === root.href && !own(previous))
          throw new Error('当前路径已有其他应用的离线服务，无法替换。')
        const reg = await navigator.serviceWorker.register(url, {
          scope: root.href,
          updateViaCache: 'none',
        })
        watch(reg)
        if (previous?.active && !reg.installing) await reg.update()
        if (reg.installing) await installed(reg.installing)
        // Initial installation may be installed but not yet activated.
        if (!reg.waiting && !reg.active) await navigator.serviceWorker.ready
        if (!reg.waiting && reg.active && !(await ask(reg.active, 'STATUS')).ready)
          await ask(reg.active, 'REPAIR')
        await refresh()
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      } finally {
        busy = false
        notify()
      }
    },
    async reload() {
      if (!supported || busy || !reload || !options.canReload()) return
      busy = true
      notify()
      try {
        await options.beforeReload()
        if (registration?.waiting) {
          const worker = registration.waiting
          await ask(worker, 'ACTIVATE')
          if (worker.state !== 'activated')
            await new Promise<void>((resolve, reject) => {
              const finish = () => {
                if (worker.state === 'activated') {
                  clearTimeout(timer)
                  worker.removeEventListener('statechange', finish)
                  resolve()
                }
              }
              const timer = setTimeout(() => {
                worker.removeEventListener('statechange', finish)
                reject(new Error('应用更新尚未激活，请稍后重试。'))
              }, 10000)
              worker.addEventListener('statechange', finish)
              finish()
            })
        }
        location.reload()
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
        busy = false
        notify()
      }
    },
  }
}
