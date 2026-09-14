import { test, expect } from '../helpers/library-browser.ts'
import { prepareOffline } from '../helpers/offline-browser.ts'
import { pwaServer } from '../helpers/pwa-server.ts'
import type { Page } from '@playwright/test'
async function pageReload(page: Page) {
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
    page.evaluate(() => location.reload()),
  ])
  await page.waitForLoadState('domcontentloaded')
}
test('network emulation also permits a page-initiated offline reload', async ({
  page,
  context,
}) => {
  const server = await pwaServer()
  try {
    await page.goto(server.url)
    await prepareOffline(page)
    await context.setOffline(true)
    await pageReload(page)
    await expect(page.locator('#offline-panel')).toHaveAttribute('data-ready', 'true')
    await page.locator('#demo').click()
    await expect(page.locator('#evaluate')).toBeEnabled()
  } finally {
    await context.setOffline(false)
    await server.close()
  }
})
