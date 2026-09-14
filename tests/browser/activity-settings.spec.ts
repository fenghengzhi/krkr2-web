import { test, expect } from '@playwright/test'
import { injectActivity, loadActivity, visibility } from '../helpers/activity-browser.ts'

test('background preference follows other tabs and remains usable when persistence is refused', async ({
  page,
  context,
}) => {
  await injectActivity(page)
  await loadActivity(page, 'asyncify')
  const other = await context.newPage()
  await other.goto('/')
  await other.locator('#pause-background').uncheck()
  await expect(page.locator('#pause-background')).not.toBeChecked()
  await visibility(page, 'hidden')
  await expect(page.locator('#status')).toHaveText('运行中')
  await other.locator('#pause-background').check()
  await expect(page.locator('#pause-background')).toBeChecked()
  await expect(page.locator('#status')).toHaveText('后台已暂停')
  // Cross-tab verification is complete; the remaining checks use one page.
  await other.close()
  await visibility(page, 'visible')
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'krkr2-web:pause-when-hidden')
        throw new DOMException('Test storage refusal', 'SecurityError')
      original.call(this, key, value)
    }
  })
  await page.locator('#pause-background').uncheck()
  await visibility(page, 'hidden')
  await expect(page.locator('#status')).toHaveText('运行中')
  await expect(page.locator('#logs')).toContainText('设置')
  await visibility(page, 'visible')
  await page.locator('#stop').click()
  await page.reload()
  await expect(page.locator('#pause-background')).toBeChecked()
})
