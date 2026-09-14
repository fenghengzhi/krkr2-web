import { test, expect } from '@playwright/test'
import { injectActivity, loadActivity } from '../helpers/activity-browser.ts'
import { injectAudioProbe, loadMedia } from '../helpers/media-browser.ts'

test('transport clicks survive unchanged labels being refreshed during a held press', async ({
  page,
}) => {
  await injectActivity(page)
  await loadActivity(page, 'asyncify')
  const button = page.locator('#pause')
  await button.scrollIntoViewIfNeeded()
  const box = (await button.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  const count = await page.locator('#logs p').filter({ hasText: 'activity-tick=' }).count()
  await expect
    .poll(() => page.locator('#logs p').filter({ hasText: 'activity-tick=' }).count())
    .toBeGreaterThan(count + 1)
  await page.mouse.up()
  await expect(page.locator('#status')).toHaveText('已暂停')
  await expect(button).toHaveText('继续')
  await button.click()
  await expect(page.locator('#status')).toHaveText('运行中')
  await page.locator('#stop').click()
})

test('sound toggle clicks survive AudioWorklet reports during a held press', async ({ page }) => {
  await injectAudioProbe(page)
  await loadMedia(page, 'asyncify')
  const button = page.locator('#sound-toggle')
  await expect(button).toHaveText('静音')
  await button.scrollIntoViewIfNeeded()
  const box = (await button.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(350) // Span real Worklet state reports while the button is held.
  await page.mouse.up()
  await expect(button).toHaveText('取消静音')
  await button.click()
  await expect(button).toHaveText('静音')
  await page.locator('#stop').click()
})
