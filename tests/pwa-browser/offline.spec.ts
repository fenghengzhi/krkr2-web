import { test, expect } from '../helpers/library-browser.ts'
import { prepareOffline, reloadOffline, pageBuild } from '../helpers/offline-browser.ts'
import { zipFixture } from '../helpers/zip-fixtures.ts'
import { pwaServer, releaseManifest } from '../helpers/pwa-server.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import type { Page } from '@playwright/test'

async function saveGame(page: Page) {
  await page
    .locator('#files')
    .setInputFiles({ name: 'game.zip', mimeType: 'application/zip', buffer: zipFixture() })
  await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
  await expect(page.locator('#save-library')).toBeEnabled()
  await page.locator('#library-title').fill('Offline game')
  await page.locator('#save-library').click()
  await expect(page.locator('#library-games h3')).toHaveText('Offline game')
  await expect(page.locator('#cancel-library')).toBeHidden()
}
async function startGame(page: Page, saved = 1) {
  await page.locator('.library-game').getByRole('button', { name: '启动', exact: true }).click()
  await expect(page.locator('#logs')).toContainText(`zip-ready:42:${saved}`)
  await expect(page.locator('#evaluate')).toBeEnabled()
}
async function pageReload(page: Page) {
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
    page.evaluate(() => location.reload()),
  ])
  await page.waitForLoadState('domcontentloaded')
}
for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: saved app and OPFS game reload after the application server closes`, async ({
    page,
  }) => {
    const server = await pwaServer()
    try {
      await page.goto(server.url + `?backend=${backend}`)
      await saveGame(page)
      await prepareOffline(page)
      await server.close()
      await pageReload(page)
      await expect(page.locator('#library-games h3')).toHaveText('Offline game')
      await startGame(page)
      await evaluate(page, 'Scripts.evalStorage("game.zip>シーン/value.tjs")', '42')
      await expect(page.locator('canvas')).toHaveJSProperty('width', 2)
    } finally {
      await server.close()
    }
  })
}

test('cached application cold-starts from a closed browser while the server remains unavailable', async ({
  page,
  context,
  playwright,
  browserName,
  libraryProfile,
}) => {
  const server = await pwaServer()
  try {
    await page.goto(server.url + '?backend=asyncify')
    await saveGame(page)
    await prepareOffline(page)
    await context.close()
    await server.close()
    const reopened = await playwright[browserName].launchPersistentContext(libraryProfile, {
      headless: true,
    })
    try {
      const next = reopened.pages()[0] ?? (await reopened.newPage())
      await next.goto(server.url + '?backend=asyncify')
      await expect(next.locator('#library-games h3')).toHaveText('Offline game')
      await startGame(next)
      await expect(next.locator('#offline-panel')).toHaveAttribute('data-ready', 'true')
    } finally {
      await reopened.close()
    }
  } finally {
    await server.close()
  }
})

test('a new app version does not reload another game tab and retains its pinned manifest offline', async ({
  page,
  context,
}) => {
  const server = await pwaServer(),
    a = await releaseManifest('a'),
    b = await releaseManifest('b')
  try {
    await page.goto(server.url + '?backend=asyncify')
    await saveGame(page)
    await prepareOffline(page)
    await startGame(page)
    expect(await pageBuild(page)).toBe(a.build)
    const update = await context.newPage()
    await update.goto(server.url)
    expect(await pageBuild(update)).toBe(a.build)
    server.deploy('b')
    await update.locator('#prepare-offline').click()
    await expect(update.locator('#reload-offline')).toBeVisible()
    await expect(update.locator('#prepare-offline')).toBeEnabled()
    await reloadOffline(update)
    expect(await pageBuild(update)).toBe(b.build)
    expect(await pageBuild(page)).toBe(a.build)
    await expect(page.locator('#status')).toHaveText('运行中')
    await evaluate(page, 'asset.getMainPixel(0,0)', String(0x336699))
    await server.close()
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    await startGame(page)
    await expect(update.locator('#library-games h3')).toHaveText('Offline game')
    await startGame(update)
    const names = await update.evaluate(() => caches.keys())
    expect(names.some((name) => name.endsWith(a.build))).toBe(true)
    expect(names.some((name) => name.endsWith(b.build))).toBe(true)
    await page.close()
    await update.reload()
    await expect(update.locator('#offline-panel')).toHaveAttribute('data-ready', 'true')
    await expect
      .poll(() => update.evaluate(() => caches.keys()))
      .toEqual(names.filter((name) => !name.endsWith(a.build)))
  } finally {
    await server.close()
  }
})

test('a corrupt deployment leaves the last complete app usable and can be retried', async ({
  page,
}) => {
  const server = await pwaServer(),
    a = await releaseManifest('a'),
    b = await releaseManifest('b')
  const bad = b.assets.find(
    (asset) =>
      asset.path.startsWith('assets/index-') &&
      asset.path.endsWith('.js') &&
      !a.assets.some((old) => old.path === asset.path),
  )!
  try {
    await page.goto(server.url + '?backend=asyncify')
    await saveGame(page)
    await prepareOffline(page)
    server.deploy('b', bad.path)
    await page.locator('#prepare-offline').click()
    await expect(page.locator('#offline-status')).toContainText('准备失败')
    expect(await pageBuild(page)).toBe(a.build)
    await expect
      .poll(() => page.evaluate(() => caches.keys()))
      .toEqual([`krkr2-shell-v1:${encodeURIComponent('/player/')}:${a.build}`])
    await startGame(page)
    server.deploy('b')
    await page.locator('#prepare-offline').click()
    await expect(page.locator('#reload-offline')).toBeVisible()
    await expect(page.locator('#prepare-offline')).toBeEnabled()
    await reloadOffline(page)
    expect(await pageBuild(page)).toBe(b.build)
    await startGame(page)
  } finally {
    await server.close()
  }
})

test('explicit preparation repairs an evicted application cache without clearing game resources', async ({
  page,
}) => {
  const server = await pwaServer()
  try {
    await page.goto(server.url + '?backend=asyncify')
    await saveGame(page)
    await prepareOffline(page)
    await page.evaluate(async () => {
      for (const name of await caches.keys())
        if (name.startsWith('krkr2-shell-v1:')) await caches.delete(name)
    })
    await page.locator('#prepare-offline').click()
    await expect(page.locator('#prepare-offline')).toBeEnabled()
    await expect(page.locator('#offline-panel')).toHaveAttribute('data-ready', 'true')
    await server.close()
    await pageReload(page)
    await startGame(page)
  } finally {
    await server.close()
  }
})

test('the app cache excludes user files, range requests and sibling paths', async ({ page }) => {
  const server = await pwaServer(),
    manifest = await releaseManifest('a')
  server.extra.set('private.txt', Buffer.from('first'))
  try {
    await page.goto(server.url)
    await prepareOffline(page)
    expect(await page.evaluate(async () => await (await fetch('private.txt')).text())).toBe('first')
    server.extra.set('private.txt', Buffer.from('second'))
    expect(await page.evaluate(async () => await (await fetch('private.txt')).text())).toBe(
      'second',
    )
    const asset = manifest.assets.find((asset) => asset.path.endsWith('.wasm'))!
    expect(
      await page.evaluate(async (path) => {
        const response = await fetch(path, { headers: { Range: 'bytes=0-0' } })
        return { status: response.status, length: (await response.arrayBuffer()).byteLength }
      }, asset.path),
    ).toEqual({ status: 206, length: 1 })
    expect(
      await page.evaluate(async () => {
        const response = await fetch('../not-the-app')
        return response.status
      }),
    ).toBe(404)
    const requests = await page.evaluate(async () => {
      const paths: string[] = []
      for (const name of await caches.keys())
        for (const request of await (await caches.open(name)).keys())
          paths.push(new URL(request.url).pathname)
      return paths
    })
    expect(requests).not.toContain('/player/private.txt')
    expect(requests.every((path) => path.startsWith('/player/'))).toBe(true)
    const webmanifest = await page.evaluate(
      async () => await (await fetch('app.webmanifest')).json(),
    )
    expect(webmanifest.start_url).toBe('./')
    expect(webmanifest.scope).toBe('./')
    expect(webmanifest.display).toBe('standalone')
  } finally {
    await server.close()
  }
})
