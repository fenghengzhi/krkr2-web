import { expect, type Page } from '@playwright/test'
export async function reloadOffline(page: Page) {
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
    page.locator('#reload-offline').click(),
  ])
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#offline-panel')).toHaveAttribute('data-ready', 'true')
}
export async function prepareOffline(page: Page) {
  await page.locator('#prepare-offline').click()
  await expect(page.locator('#offline-panel')).toHaveAttribute('data-ready', 'true')
  await expect(page.locator('#prepare-offline')).toBeEnabled()
  if (await page.locator('#reload-offline').isVisible()) await reloadOffline(page)
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
}
export const pageBuild = (page: Page) =>
  page.locator('meta[name="krkr-build"]').getAttribute('content')
