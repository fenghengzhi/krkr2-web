import { test, expect, injectLibraryWorker, libraryDirectories } from '../helpers/library-browser.ts'
import { httpServer } from '../helpers/http-server.ts'
import { remoteArchive } from '../helpers/remote-archive.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import type { Page } from '@playwright/test'

test('another tab repairs a damaged download after failed publication and removes the checkpoints atomically', async ({ page, context }, info) => {
  test.setTimeout(120000)
  const server = await httpServer({ '/opening.zip': { bytes: remoteArchive('zip'), etag: '"release-7"' } })
  let peer: Page | undefined
  try {
    await injectLibraryWorker(page, `const originalPut=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(...args){
        if(this.name==='games')throw new DOMException('Interrupted catalog commit','QuotaExceededError');
        return originalPut.apply(this,args);
      };`)
    await page.goto('/?backend=asyncify')
    await page.locator('#remote-url').fill(server.url + '/opening.zip')
    await page.locator('#load-url').click()
    await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
    await page.locator('#library-title').fill('Recovered opening')
    await page.locator('#save-library').click()
    await expect(page.locator('#library-operation')).toContainText('Interrupted catalog commit')
    await expect(page.locator('.library-download')).toHaveCount(1)
    await expect(page.locator('.library-game')).toHaveCount(0)
    if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')

    const ids = await libraryDirectories(page)
    expect(ids).toHaveLength(1)
    await page.evaluate(async (id) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('krkr2-library-v1')
      const handle = await (await root.getDirectoryHandle(id!)).getFileHandle('0')
      const stream = await handle.createWritable({ keepExistingData: true })
      await stream.write({ type: 'write', position: 2 * 1024 * 1024 + 100, data: Uint8Array.of(123) })
      await stream.close()
    }, ids[0])

    // This tab has no loaded game, injected storage failure or copy of the URL.
    peer = await context.newPage()
    await peer.goto('/?backend=asyncify')
    await expect(peer.locator('#remote-url')).toHaveValue('')
    const mark = server.requests.length
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
    await row.getByRole('button', { name: '启动', exact: true }).click()
    await expect(peer.locator('#logs')).toContainText('zip-ready:42:')
    await evaluate(peer, 'Scripts.evalStorage("late.tjs")', '73')
    expect(server.requests.slice(mark).filter((request) => request.method === 'GET')).toEqual(gets)
  } finally { try { await peer?.close() } finally { await server.close() } }
})
