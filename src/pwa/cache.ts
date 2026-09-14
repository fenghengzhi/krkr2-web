import {
  MAX_SHELL_GENERATIONS,
  MAX_SHELL_STORAGE_BYTES,
  validateManifest,
  type ShellAsset,
  type ShellManifest,
  type ShellRecord,
} from './manifest.ts'
import { abortable } from './cancel.ts'

const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
export class ShellCache {
  readonly prefix: string
  readonly name: string
  readonly marker: string
  constructor(
    readonly manifest: ShellManifest,
    readonly root: URL,
    private readonly storage: CacheStorage = caches,
    private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {
    validateManifest(manifest)
    this.prefix = 'krkr2-shell-v1:' + encodeURIComponent(root.pathname) + ':'
    this.name = this.prefix + manifest.build
    this.marker = new URL('__offline_manifest__', root).href
  }
  async record(name = this.name): Promise<ShellRecord | undefined> {
    if (!(await this.storage.keys()).includes(name)) return
    const response = await (await this.storage.open(name)).match(this.marker)
    if (!response) return
    try {
      const record = (await response.json()) as ShellRecord
      validateManifest(record.manifest)
      if (name !== this.prefix + record.manifest.build || typeof record.complete !== 'boolean')
        return
      return record
    } catch {
      return
    }
  }
  private async mark(cache: Cache, complete: boolean): Promise<void> {
    await cache.put(
      this.marker,
      new Response(JSON.stringify({ manifest: this.manifest, complete }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }
  async names(): Promise<string[]> {
    return (await this.storage.keys()).filter((name) => name.startsWith(this.prefix))
  }
  async status() {
    const record = await this.record(),
      cache = await this.storage.open(this.name)
    const missing: string[] = []
    for (const asset of this.manifest.assets)
      if (!(await cache.match(new URL(asset.path, this.root).href))) missing.push(asset.path)
    return {
      build: this.manifest.build,
      ready: !!record?.complete && missing.length === 0,
      bytes: this.manifest.bytes,
      assets: this.manifest.assets.length,
      missing,
    }
  }
  async prune(): Promise<void> {
    for (const name of await this.names()) if (name !== this.name) await this.storage.delete(name)
  }
  async clearIncomplete(): Promise<void> {
    for (const name of await this.names())
      if (name !== this.name && !(await this.record(name))?.complete)
        await this.storage.delete(name)
  }
  private async download(asset: ShellAsset, parent?: AbortSignal): Promise<Response> {
    const abort = new AbortController(),
      cancel = () => abort.abort(parent?.reason)
    parent?.addEventListener('abort', cancel, { once: true })
    if (parent?.aborted) cancel()
    const timer = setTimeout(
      () => abort.abort(new DOMException('Offline app download timed out', 'TimeoutError')),
      15000,
    )
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      abort.signal.throwIfAborted()
      const url = new URL(asset.path, this.root).href
      const fetching = this.fetcher(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        signal: abort.signal,
      }).then((response) => {
        if (abort.signal.aborted) {
          void response.body?.cancel().catch(() => {})
          abort.signal.throwIfAborted()
        }
        return response
      })
      const response = await abortable(fetching, abort.signal)
      if (response.status !== 200 || (response.url && response.url !== url))
        throw new Error(`Offline app asset unavailable: ${asset.path}`)
      const bytes = new Uint8Array(asset.bytes)
      reader = response.body?.getReader()
      let at = 0
      if (reader)
        while (true) {
          const { done, value } = await abortable(reader.read(), abort.signal)
          abort.signal.throwIfAborted()
          if (done) break
          if (value.length > bytes.length - at)
            throw new Error(`Offline app asset size changed: ${asset.path}`)
          bytes.set(value, at)
          at += value.length
        }
      if (at !== asset.bytes || (await abortable(hex(bytes), abort.signal)) !== asset.sha256)
        throw new Error(`Offline app asset checksum mismatch: ${asset.path}`)
      abort.signal.throwIfAborted()
      const headers = new Headers(response.headers)
      headers.delete('Content-Encoding')
      headers.delete('Transfer-Encoding')
      headers.set('Content-Length', String(bytes.length))
      headers.set('Content-Type', asset.mime)
      headers.set('Cache-Control', 'no-cache')
      return new Response(bytes, { headers })
    } finally {
      clearTimeout(timer)
      parent?.removeEventListener('abort', cancel)
      if (reader) {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
  }
  async install(): Promise<void> {
    const previous = await this.record()
    if (previous?.complete && (await this.status()).ready) return
    const others = (await this.names()).filter((name) => name !== this.name)
    let bytes = this.manifest.bytes
    for (const name of others)
      bytes += (await this.record(name))?.manifest.bytes ?? MAX_SHELL_STORAGE_BYTES
    if (others.length >= MAX_SHELL_GENERATIONS || bytes > MAX_SHELL_STORAGE_BYTES)
      throw new Error('Offline app cache is full; close older app tabs and retry')
    const cache = await this.storage.open(this.name),
      abort = new AbortController()
    const deadline = setTimeout(
      () => abort.abort(new DOMException('Offline app installation timed out', 'TimeoutError')),
      60000,
    )
    let next = 0
    try {
      if (!previous?.complete) await this.mark(cache, false)
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, async () => {
          try {
            while (next < this.manifest.assets.length) {
              abort.signal.throwIfAborted()
              const asset = this.manifest.assets[next++]!
              const response = await this.download(asset, abort.signal)
              abort.signal.throwIfAborted()
              await cache.put(new URL(asset.path, this.root).href, response)
            }
          } catch (error) {
            abort.abort(error)
            throw error
          }
        }),
      )
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      await this.mark(cache, true)
    } catch (error) {
      if (!previous?.complete) await this.storage.delete(this.name)
      throw error
    } finally {
      clearTimeout(deadline)
    }
  }
  /** Only known application artifacts participate. User requests and range reads pass through. */
  async response(request: Request): Promise<Response | undefined> {
    if (request.method !== 'GET' || request.headers.has('range') || request.headers.has('if-match'))
      return
    const url = new URL(request.url)
    if (url.origin !== this.root.origin || !url.pathname.startsWith(this.root.pathname)) return
    const relative = url.pathname.slice(this.root.pathname.length)
    const navigation = request.mode === 'navigate' && (relative === '' || relative === 'index.html')
    if (!navigation && url.search) return
    const path = navigation ? 'index.html' : relative
    let asset = this.manifest.assets.find((asset) => asset.path === path),
      name = this.name
    if (!asset && /^(assets|wasm|fonts)\//.test(path)) {
      for (const older of await this.names()) {
        if (older === this.name) continue
        const record = await this.record(older)
        if (!record?.complete) continue
        asset = record.manifest.assets.find((asset) => asset.path === path)
        if (asset) {
          name = older
          break
        }
      }
    }
    if (!asset) return
    const cache = await this.storage.open(name),
      key = new URL(asset.path, this.root).href
    const cached = await cache.match(key)
    if (cached) return cached
    try {
      const repaired = await this.download(asset)
      await cache.put(key, repaired.clone())
      return repaired
    } catch {
      return new Response('应用离线缓存不完整，请联网后重新准备离线启动。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      })
    }
  }
}
