import { test, expect, libraryDirectories } from '../helpers/library-browser.ts'
import { httpServer } from '../helpers/http-server.ts'
import { remoteArchive } from '../helpers/remote-archive.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import type { Page } from '@playwright/test'

test('another tab repairs a damaged download after failed publication and removes the checkpoints atomically', async ({ page, context }, info) => {
  test.setTimeout(120000)
  const archive = remoteArchive('zip'),
    server = await httpServer({ '/opening.zip': { bytes: archive, etag: '"release-7"' } }),
    failures: unknown[] = [], networkFailures: { url: string; error: string | null }[] = [], consoleErrors: string[] = []
  let phase = 'worker startup', workerUrl: string | undefined, commitAttempts: number | undefined
  let peer: Page | undefined
  context.on('requestfailed', (request) => networkFailures.push({ url: request.url(), error: request.failure()?.errorText ?? null }))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  try {
    // The original failure happened in the rewritten Worker's first network
    // probe, before the intended catalog fault. Keep the release Worker's
    // real HTTP response/network environment intact and inject only the late
    // IndexedDB operation, before any download is requested.
    const [worker] = await Promise.all([
      page.waitForEvent('worker', { predicate: (value) => new URL(value.url()).pathname.includes('/assets/library.worker-') }),
      page.goto('/?backend=asyncify'),
    ])
    workerUrl = worker.url()
    await worker.evaluate(() => {
      const root = globalThis as typeof globalThis & { __integrityCommitAttempts: number },
        originalPut = IDBObjectStore.prototype.put
      root.__integrityCommitAttempts = 0
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        if (this.name === 'games') {
          root.__integrityCommitAttempts++
          throw new DOMException('Interrupted catalog commit', 'QuotaExceededError')
        }
        return originalPut.apply(this, args)
      }
    })
    phase = 'initial remote game'
    await page.locator('#remote-url').fill(server.url + '/opening.zip')
    await page.locator('#load-url').click()
    await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
    phase = 'download and catalog publication'
    await page.locator('#library-title').fill('Recovered opening')
    await page.locator('#save-library').click()
    await expect(page.locator('#library-operation')).toContainText('Interrupted catalog commit')
    commitAttempts = await worker.evaluate(() => (globalThis as typeof globalThis & { __integrityCommitAttempts: number }).__integrityCommitAttempts)
    expect(commitAttempts).toBe(1)
    expect(server.stats().sent).toBeGreaterThanOrEqual(archive.byteLength)
    await expect(page.locator('.library-download')).toHaveCount(1)
    await expect(page.locator('.library-game')).toHaveCount(0)
    if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')

    const ids = await libraryDirectories(page)
    expect(ids).toHaveLength(1)
    phase = 'damage one durable block'
    await page.evaluate(async (id) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('krkr2-library-v1')
      const handle = await (await root.getDirectoryHandle(id!)).getFileHandle('0')
      const stream = await handle.createWritable({ keepExistingData: true })
      await stream.write({ type: 'write', position: 2 * 1024 * 1024 + 100, data: Uint8Array.of(123) })
      await stream.close()
    }, ids[0])

    // This tab has no loaded game, injected storage failure or copy of the URL.
    peer = await context.newPage()
    peer.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    await peer.goto('/?backend=asyncify')
    await expect(peer.locator('#remote-url')).toHaveValue('')
    const mark = server.requests.length
    phase = 'peer resumes and repairs the damaged block'
    await peer.locator('.library-download').getByRole('button', { name: '继续下载' }).click()
    const row = peer.locator('.library-game')
    await expect(row).toContainText('Recovered opening', { timeout: 30000 })
    await expect(peer.locator('.library-download')).toHaveCount(0)
    await expect(row).toHaveAttribute('data-library-id', ids[0]!)
    const gets = server.requests.slice(mark).filter((request) => request.method === 'GET')
    await info.attach('repaired-ranges', { body: JSON.stringify(gets), contentType: 'application/json' })
    expect(gets.map((request) => request.range)).toEqual(['bytes=0-0', 'bytes=2097152-3145727'])
    expect(gets[1]!.match).toBe('"release-7"')
    const counts = await peer.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('krkr2-library')
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      try {
        const names = ['catalog', 'games', 'downloads', 'downloadRequests', 'downloadBlocks']
        const tx = db.transaction(names)
        return await Promise.all(names.map((name) => new Promise<number>((resolve, reject) => {
          const req = tx.objectStore(name).count()
          req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
        })))
      } finally { db.close() }
    })
    expect(counts).toEqual([1, 1, 0, 0, 0])
    phase = 'launch repaired local game'
    await row.getByRole('button', { name: '启动', exact: true }).click()
    await expect(peer.locator('#logs')).toContainText('zip-ready:42:')
    await evaluate(peer, 'Scripts.evalStorage("late.tjs")', '73')
    expect(server.requests.slice(mark).filter((request) => request.method === 'GET')).toEqual(gets)
    phase = 'complete'
  } catch (error) { failures.push(error) }
  try {
    await info.attach('download-integrity-observation', { contentType: 'application/json', body: JSON.stringify({
      phase, workerUrl, commitAttempts, networkFailures, consoleErrors, requests: server.requests, transport: server.stats(),
      operation: await page.locator('#library-operation').textContent({ timeout: 1000 }),
    }, null, 2) })
  } catch (error) { failures.push(error) }
  try { await peer?.close() } catch (error) { failures.push(error) }
  try { await server.close() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Download repair or cleanup failed', { cause: failures[0] })
})
