import type { Page } from '@playwright/test'
import {
  test,
  expect,
  libraryDirectories,
  injectLibraryWorker,
} from '../helpers/library-browser.ts'
import { httpServer, type HttpFixture } from '../helpers/http-server.ts'
import { remoteArchive } from '../helpers/remote-archive.ts'
import { zipFixture } from '../helpers/zip-fixtures.ts'
import { evaluate } from '../helpers/browser-expression.ts'

async function load(page: Page, name = 'game.zip') {
  await page
    .locator('#files')
    .setInputFiles({ name, mimeType: 'application/zip', buffer: zipFixture() })
  await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
  await expect(page.locator('#save-library')).toBeEnabled()
}
async function save(page: Page, title = 'Library game') {
  await page.locator('#library-title').fill(title)
  await page.locator('#save-library').click()
  await expect(page.locator('#library-games h3')).toHaveText(title)
  await expect(page.locator('#cancel-library')).toBeHidden()
  return page.locator('.library-game').first()
}
for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: local game resources and settings survive refresh, preserve saves and can be removed`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`/?backend=${backend}`)
    await load(page)
    await save(page, '保存的游戏')
    await page.reload()
    await expect(page.locator('#library-games h3')).toHaveText('保存的游戏')
    await page.locator('.library-game').getByRole('button', { name: '启动', exact: true }).click()
    await expect(page.locator('#logs')).toContainText('zip-ready:42:1')
    await expect(page.locator('#evaluate')).toBeEnabled()
    await evaluate(page, 'Scripts.evalStorage("game.zip>シーン/value.tjs")', '42')
    await expect(page.locator('#save-library')).toBeDisabled()
    await page.locator('.library-game summary').click()
    await page.getByRole('textbox', { name: '库中游戏名称', exact: true }).fill('Renamed')
    await page.locator('.library-game').getByRole('button', { name: '保存设置' }).click()
    await expect(page.locator('#library-games h3')).toHaveText('Renamed')
    await page.reload()
    await expect(page.locator('#library-games h3')).toHaveText('Renamed')
    await page.locator('.library-game').getByRole('button', { name: '移除资源' }).click()
    await expect(page.locator('.library-game')).toHaveCount(0)
    await page
      .locator('#files')
      .setInputFiles({ name: 'game.zip', mimeType: 'application/zip', buffer: zipFixture() })
    await expect(page.locator('#logs')).toContainText('zip-ready:42:1')
    expect(errors).toEqual([])
  })
}

for (const backend of ['asyncify', 'jspi'])
  for (const kind of ['zip', 'xp3'] as const) {
    test(`${backend}: remote ${kind} is fully retained, then starts and loads later resources without its server`, async ({
      page,
    }) => {
      const file = { bytes: remoteArchive(kind), etag: '"v1"' },
        server = await httpServer({ '/download': file })
      try {
        await page.goto(`/?backend=${backend}`)
        await page.locator('#remote-url').fill(server.url + '/download')
        await page.locator('#load-url').click()
        await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
        await expect(page.locator('#save-library')).toBeEnabled()
        await save(page, `Remote ${kind}`)
        expect(server.stats().sent).toBeGreaterThanOrEqual(file.bytes.length)
        await server.close()
        const unexpected: string[] = []
        page.on('request', (request) => {
          if (request.url().startsWith(server.url)) unexpected.push(request.url())
        })
        await page.reload()
        await expect(page.locator('.library-game')).toHaveCount(1)
        await page
          .locator('.library-game')
          .getByRole('button', { name: '启动', exact: true })
          .click()
        await expect(page.locator('#logs')).toContainText('zip-ready:42:1')
        await expect(page.locator('#evaluate')).toBeEnabled()
        await evaluate(page, 'Scripts.evalStorage("late.tjs")', '73')
        await evaluate(page, 'asset.getMainPixel(0,0)', String(0x336699))
        expect(unexpected).toEqual([])
      } finally {
        await server.close().catch(() => {})
      }
    })
  }

test('library resources survive closing and reopening the complete browser profile', async ({
  page,
  context,
  playwright,
  browserName,
  baseURL,
  libraryProfile,
}) => {
  await page.goto('/?backend=asyncify')
  await load(page)
  await save(page, 'Restarted browser')
  await context.close()
  const reopened = await playwright[browserName].launchPersistentContext(libraryProfile, {
    headless: true,
    baseURL,
  })
  try {
    const next = reopened.pages()[0] ?? (await reopened.newPage())
    await next.goto('/?backend=asyncify')
    await expect(next.locator('#library-games h3')).toHaveText('Restarted browser')
    await next.locator('.library-game').getByRole('button', { name: '启动', exact: true }).click()
    await expect(next.locator('#logs')).toContainText('zip-ready:42:1')
  } finally {
    await reopened.close()
  }
})

test('another tab cannot remove a running library game, and removal releases both metadata and bytes', async ({
  page,
  context,
}) => {
  await page.goto('/?backend=asyncify')
  await load(page)
  await save(page)
  const second = await context.newPage()
  await second.goto('/?backend=asyncify')
  await expect(second.locator('.library-game')).toHaveCount(1)
  await second.locator('.library-game').getByRole('button', { name: '启动', exact: true }).click()
  await expect(second.locator('#logs')).toContainText('zip-ready:42:1')
  await page.locator('.library-game').getByRole('button', { name: '移除资源' }).click()
  await expect(page.locator('#logs')).toContainText('running in another tab')
  expect(await libraryDirectories(page)).toHaveLength(1)
  await expect(page.locator('.library-game')).toHaveCount(1)
  await expect(second.locator('#evaluate')).toBeEnabled()
  await evaluate(second, 'Scripts.evalStorage("シーン/value.tjs")', '42')
  await second.locator('#stop').click()
  await expect(second.locator('#stop')).toBeDisabled()
  await page.locator('.library-game').getByRole('button', { name: '移除资源' }).click()
  await expect(page.locator('.library-game')).toHaveCount(0)
  await expect(second.locator('.library-game')).toHaveCount(0)
  expect(await libraryDirectories(page)).toEqual([])
})

for (const [stage, source, error] of [
  [
    'quota estimate',
    `navigator.storage.estimate = async () => ({usage:0,quota:1});`,
    'Not enough browser storage',
  ],
  [
    'file write',
    `FileSystemSyncAccessHandle.prototype.write = function(){throw new DOMException('Injected quota failure','QuotaExceededError')};`,
    'Injected quota failure',
  ],
  [
    'file flush',
    `FileSystemSyncAccessHandle.prototype.flush = function(){throw new Error('Injected flush failure')};`,
    'Injected flush failure',
  ],
  [
    'metadata commit',
    `const originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='games')throw new DOMException('Injected commit failure','QuotaExceededError');return originalPut.apply(this,args)};`,
    'Injected commit failure',
  ],
]) {
  test(`${stage} failure never publishes a partial game and cleans temporary files`, async ({
    page,
  }) => {
    await injectLibraryWorker(page, source)
    await page.goto('/?backend=asyncify')
    await load(page)
    await page.locator('#save-library').click()
    await expect(page.locator('#library-operation')).toContainText(error)
    await expect(page.locator('#cancel-library')).toBeHidden()
    await expect(page.locator('.library-game')).toHaveCount(0)
    expect(await libraryDirectories(page)).toEqual([])
    await page.unroute('**/assets/library.worker-*.js*')
    await page.reload()
    await load(page, 'another.zip')
    await save(page, 'After failure')
  })
}

test('a terminated stalled import is recovered without publishing incomplete files', async ({
  page,
}) => {
  await injectLibraryWorker(
    page,
    `const openSync=FileSystemFileHandle.prototype.createSyncAccessHandle;FileSystemFileHandle.prototype.createSyncAccessHandle=function(...args){return this.name==='1'?new Promise(()=>{}):openSync.apply(this,args)};`,
  )
  await page.goto('/?backend=asyncify')
  await page.locator('#files').setInputFiles([
    { name: 'game.zip', mimeType: 'application/zip', buffer: zipFixture() },
    {
      name: 'extra.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(2 * 1024 * 1024),
    },
  ])
  await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
  await expect(page.locator('#save-library')).toBeEnabled()
  await page.locator('#save-library').click()
  await expect(page.locator('#library-operation')).toContainText('extra.bin')
  expect(await libraryDirectories(page)).toHaveLength(1)
  await page.unroute('**/assets/library.worker-*.js*')
  await page.locator('#cancel-library').click()
  await expect(page.locator('#cancel-library')).toBeHidden({ timeout: 4000 })
  await expect.poll(() => libraryDirectories(page)).toEqual([])
  await expect(page.locator('.library-game')).toHaveCount(0)
  await expect(page.locator('#save-library')).toBeEnabled()
  await save(page, 'Recovered import')
})

test('cancelling a remote library copy aborts the network and removes its unpublished OPFS directory', async ({
  page,
}) => {
  let block = false
  const file: HttpFixture = {
    bytes: remoteArchive('zip'),
    etag: '"v1"',
    intercept: (request) => block && request.headers.range === 'bytes=1048576-2097151',
  }
  const server = await httpServer({ '/game.zip': file })
  try {
    await page.goto('/?backend=asyncify')
    await page.locator('#remote-url').fill(server.url + '/game.zip')
    await page.locator('#load-url').click()
    await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
    block = true
    await expect(page.locator('#save-library')).toBeEnabled()
    await page.locator('#save-library').click()
    await expect
      .poll(() => server.requests.some((r) => r.range === 'bytes=1048576-2097151'))
      .toBe(true)
    expect(await libraryDirectories(page)).toHaveLength(1)
    await page.locator('#cancel-library').click()
    await expect(page.locator('#cancel-library')).toBeHidden({ timeout: 1800 })
    await expect.poll(() => server.stats().aborted).toBeGreaterThan(0)
    await expect.poll(() => libraryDirectories(page)).toEqual([])
    await expect(page.locator('.library-game')).toHaveCount(0)
    await evaluate(page, 'Scripts.evalStorage("シーン/value.tjs")', '42')
    block = false
    await save(page, 'Retried remote copy')
  } finally {
    await server.close()
  }
})

test('changed remote versions are rejected before copying into the current game namespace', async ({
  page,
}) => {
  const file = { bytes: zipFixture(), etag: '"v1"' },
    server = await httpServer({ '/game.zip': file })
  try {
    await page.goto('/?backend=asyncify')
    await page.locator('#remote-url').fill(server.url + '/game.zip')
    await page.locator('#load-url').click()
    await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
    file.etag = '"v2"'
    await expect(page.locator('#save-library')).toBeEnabled()
    await page.locator('#save-library').click()
    await expect(page.locator('#library-operation')).toContainText('Game sources changed')
    await expect(page.locator('#cancel-library')).toBeHidden()
    expect(await libraryDirectories(page)).toEqual([])
  } finally {
    await server.close()
  }
})

test('a corrupt unused OPFS block is checked when first requested and invalidates earlier cached reads', async ({
  page,
}) => {
  await page.goto('/?backend=asyncify')
  await page
    .locator('#files')
    .setInputFiles({ name: 'game.zip', mimeType: 'application/zip', buffer: remoteArchive('zip') })
  await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
  await expect(page.locator('#save-library')).toBeEnabled()
  const row = await save(page)
  const id = await row.getAttribute('data-library-id')
  await page.evaluate(async (id) => {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('krkr2-library-v1')
    const file = await (await root.getDirectoryHandle(id!)).getFileHandle('0')
    const stream = await file.createWritable({ keepExistingData: true })
    await stream.write({ type: 'write', position: 2 * 1024 * 1024, data: new Uint8Array([99]) })
    await stream.close()
  }, id)
  await page.reload()
  await expect(page.locator('.library-game')).toHaveCount(1)
  await page.locator('.library-game').getByRole('button', { name: '启动', exact: true }).click()
  await expect(page.locator('#logs')).toContainText('zip-ready:42:1')
  await expect(page.locator('#evaluate')).toBeEnabled()
  await evaluate(
    page,
    '(function(){try{Scripts.evalStorage("pad-a.bin");return false;}catch(e){return true;}})()',
    '1',
  )
  await evaluate(
    page,
    '(function(){try{Scripts.evalStorage("シーン/value.tjs");return false;}catch(e){return true;}})()',
    '1',
  )
  await page.locator('.library-game').getByRole('button', { name: '移除资源' }).click()
  await expect(page.locator('.library-game')).toHaveCount(0)
  await expect(page.locator('#stop')).toBeDisabled()
  expect(await libraryDirectories(page)).toEqual([])
})

test('the compact catalog migrates existing manifests atomically and preserves playable resources', async ({
  page,
}) => {
  const { gameIdentity } = await import('../../src/player/game-identity.ts')
  const { resolveFiles } = await import('../../src/backends/files/source-files.ts')
  const { hashBlock } = await import('../../src/backends/files/opfs-library.ts')
  const bytes = zipFixture(),
    blob = new Blob([Uint8Array.from(bytes).buffer])
  const gameId = await gameIdentity(
    await resolveFiles([{ path: 'game.zip', blob }], async () => {}),
  )
  const record = {
    version: 1,
    id: 'entry-00000000-0000-4000-8000-000000000000',
    gameId,
    title: 'Migrated game',
    entry: 'startup.tjs',
    backend: 'asyncify',
    createdAt: 1,
    size: bytes.length,
    fileCount: 1,
    files: [{ path: 'game.zip', size: bytes.length, hashes: [await hashBlock(bytes)] }],
  }
  // Stay on the same origin without mounting the app while seeding the older schema.
  await page.goto('/wasm/manifest.json')
  await page.evaluate(
    async ({ record, bytes }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('krkr2-library', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('games', { keyPath: 'id' })
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve(request.result)
      })
      const root = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle('krkr2-library-v1', { create: true })
      const file = await (
        await root.getDirectoryHandle(record.id, { create: true })
      ).getFileHandle('0', { create: true })
      const stream = await file.createWritable()
      await stream.write(new Uint8Array(bytes))
      await stream.close()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('games', 'readwrite')
        tx.objectStore('games').put(record)
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error)
      })
      db.close()
    },
    { record, bytes: [...bytes] },
  )
  await page.goto('/?backend=asyncify')
  await expect(page.locator('#library-games h3')).toHaveText('Migrated game')
  await page.locator('.library-game').getByRole('button', { name: '启动', exact: true }).click()
  await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
  const migrated = await page.evaluate(
    async () =>
      new Promise<{ version: number; stores: string[] }>((resolve, reject) => {
        const request = indexedDB.open('krkr2-library')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          resolve({ version: request.result.version, stores: [...request.result.objectStoreNames] })
          request.result.close()
        }
      }),
  )
  expect(migrated).toEqual({ version: 2, stores: ['catalog', 'games'] })
})

test('library names remain text and startup drafts survive refresh on a narrow screen', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/?backend=asyncify')
  await load(page)
  const title = '<img src=x onerror=alert(1)> ' + 'LongName'.repeat(15)
  await save(page, title)
  expect(await page.locator('.library-game img').count()).toBe(0)
  await page.locator('.library-game summary').click()
  await page.getByRole('textbox', { name: '库中游戏名称', exact: true }).fill('Draft game')
  await page.locator('#refresh-library').click()
  await expect(page.getByRole('textbox', { name: '库中游戏名称', exact: true })).toHaveValue(
    'Draft game',
  )
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page
    .locator('#library-panel')
    .screenshot({ path: testInfo.outputPath('library-mobile.png') })
  await page.locator('.library-game').getByRole('button', { name: '保存设置' }).click()
  await expect(page.locator('#library-games h3')).toHaveText('Draft game')
})

test('a focus refresh between pointer down and up keeps the game start action intact', async ({
  page,
}) => {
  await page.goto('/?backend=asyncify')
  await load(page)
  await save(page, 'Focus-safe game')
  await page.locator('#stop').click()
  await expect(page.locator('#stop')).toBeDisabled()
  const button = page.locator('.library-game').getByRole('button', { name: '启动', exact: true })
  await button.scrollIntoViewIfNeeded()
  const bounds = (await button.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        observer.disconnect()
        resolve()
      })
      observer.observe(document.querySelector('#library-status')!, { childList: true })
      window.dispatchEvent(new Event('focus'))
    })
  })
  await page.mouse.up()
  await expect(page.locator('#logs')).toContainText('zip-ready:42:1')
})
