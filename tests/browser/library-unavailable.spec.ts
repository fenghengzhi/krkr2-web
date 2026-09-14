import { test, expect } from '@playwright/test'
import { injectLibraryWorker } from '../helpers/library-browser.ts'
import { zipFixture } from '../helpers/zip-fixtures.ts'

test('denied game storage leaves temporary loading and saves available', async ({ page }) => {
  await injectLibraryWorker(
    page,
    `navigator.storage.getDirectory=async()=>{throw new DOMException('Storage denied for this context','NotAllowedError')};`,
  )
  await page.goto('/?backend=asyncify')
  await expect(page.locator('#library-status')).toContainText('Storage denied for this context')
  await expect(page.locator('#save-library')).toBeDisabled()
  await page
    .locator('#files')
    .setInputFiles({ name: 'game.zip', mimeType: 'application/zip', buffer: zipFixture() })
  await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
  await page.reload()
  await page
    .locator('#files')
    .setInputFiles({ name: 'game.zip', mimeType: 'application/zip', buffer: zipFixture() })
  await expect(page.locator('#logs')).toContainText('zip-ready:42:1')
  await expect(page.locator('#save-library')).toBeDisabled()
})
