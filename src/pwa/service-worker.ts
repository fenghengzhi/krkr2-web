import { ShellCache } from './cache.ts'
import type { ShellManifest } from './manifest.ts'

declare const self: ServiceWorkerGlobalScope & { __KRKR_SHELL__: ShellManifest }
const root = new URL(self.registration.scope)
const shell = new ShellCache(self.__KRKR_SHELL__, root)
const lockName = shell.prefix + 'mutation'
self.addEventListener('install', (event) => {
  event.waitUntil(
    navigator.locks.request(lockName, async () => {
      if (!self.registration.active && !self.registration.waiting) await shell.clearIncomplete()
      await shell.install()
    }),
  )
})
// No implicit skipWaiting, claim or reload: an existing game keeps its document and VM.
self.addEventListener('activate', (event) => event.waitUntil(Promise.resolve()))
self.addEventListener('fetch', (event) => {
  event.respondWith((async () => (await shell.response(event.request)) ?? fetch(event.request))())
})
self.addEventListener('message', (event) => {
  const source = event.source
  if (
    !source ||
    !('id' in source) ||
    !event.ports[0] ||
    !event.data ||
    typeof event.data !== 'object'
  )
    return
  event.waitUntil(
    (async () => {
      const client = await self.clients.get(source.id)
      if (!client || client.type !== 'window' || !client.url.startsWith(root.href)) return
      const reply = event.ports[0]!
      try {
        if (event.data.type === 'STATUS') {
          if (
            event.data.build === shell.manifest.build &&
            !self.registration.installing &&
            !self.registration.waiting
          ) {
            const clients = (
              await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            ).filter((client) => client.url.startsWith(root.href))
            if (clients.every((other) => other.id === client.id))
              await navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
                if (!lock || self.registration.installing || self.registration.waiting) return
                const live = (
                  await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
                ).filter((other) => other.url.startsWith(root.href))
                if (live.every((other) => other.id === client.id)) await shell.prune()
              })
          }
          reply.postMessage(await shell.status())
        } else if (event.data.type === 'REPAIR') {
          await navigator.locks.request(lockName, () => shell.install())
          reply.postMessage(await shell.status())
        } else if (event.data.type === 'ACTIVATE') {
          if (!(await shell.status()).ready) throw new Error('Offline app cache is incomplete')
          await self.skipWaiting()
          reply.postMessage({ activated: true })
        }
      } catch (error) {
        reply.postMessage({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        reply.close()
      }
    })(),
  )
})
