import { test, expect } from '../helpers/library-browser.ts'
import { pageBuild, reloadOffline } from '../helpers/offline-browser.ts'
import { pwaServer } from '../helpers/pwa-server.ts'
import { zipFixture } from '../helpers/zip-fixtures.ts'
import { readFile } from 'node:fs/promises'
async function setup(page: import('@playwright/test').Page, url: string) {
  await page.goto(url + '?backend=asyncify')
  await page
    .locator('#files')
    .setInputFiles({ name: 'game.zip', mimeType: 'application/zip', buffer: zipFixture() })
  await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
  await page.locator('#prepare-offline').click()
  await expect(page.locator('#offline-panel')).toHaveAttribute('data-ready', 'true')
  await expect(page.locator('#reload-offline')).toBeEnabled()
}
test('an active library import blocks application reload until its transaction completes', async ({
  page,
}) => {
  const server = await pwaServer()
  try {
    await setup(page, server.url)
    await page.evaluate(async () => {
      const state = window as unknown as { releaseLibraryLock: () => void }
      await new Promise<void>((resolve) => {
        void navigator.locks.request('krkr2-library:v1:write', async () => {
          resolve()
          await new Promise<void>((done) => {
            state.releaseLibraryLock = done
          })
        })
      })
    })
    await page.locator('#save-library').click()
    await expect(page.locator('#cancel-library')).toBeVisible()
    await expect(page.locator('#reload-offline')).toBeDisabled()
    await page.evaluate(() =>
      (window as unknown as { releaseLibraryLock: () => void }).releaseLibraryLock(),
    )
    await expect(page.locator('.library-game')).toHaveCount(1)
    await expect(page.locator('#reload-offline')).toBeEnabled()
    await reloadOffline(page)
    await expect(page.locator('.library-game')).toHaveCount(1)
  } finally {
    await server.close()
  }
})
test('a failed save flush prevents application reload and leaves pending bytes exportable', async ({
  page,
}) => {
  const server = await pwaServer()
  try {
    await setup(page, server.url)
    const before = await pageBuild(page)
    // A newer schema closes this old session's live IDB connection. The existing
    // records remain, but writes by that session can no longer commit.
    await page.evaluate(
      async () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('krkr2-web', 2)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            request.result.close()
            resolve()
          }
        }),
    )
    await page.locator('#expression').fill('saved.save("savedata/pending.txt","utf-8")')
    await page.locator('#evaluate').click()
    await expect(page.locator('#logs .error')).not.toHaveCount(0)
    await page.locator('#reload-offline').click()
    await expect(page.locator('#reload-offline')).toBeEnabled()
    expect(await pageBuild(page)).toBe(before)
    await expect(page.locator('#stop')).toBeEnabled()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#export-saves').click(),
    ])
    const data = JSON.parse(await readFile((await download.path())!, 'utf8'))
    expect(JSON.stringify(data)).toContain('savedata/pending.txt')
  } finally {
    await server.close()
  }
})
