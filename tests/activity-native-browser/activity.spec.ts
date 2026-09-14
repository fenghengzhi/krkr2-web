import { setTimeout as observe } from 'node:timers/promises'
import { test, expect, nativeEvents } from '../helpers/native-activity-browser.ts'
import { loadActivity } from '../helpers/activity-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: trusted minimize, freeze and restore preserve the VM and user pause`, async ({
    native,
    baseURL,
  }) => {
    const { page } = native
    await loadActivity(page, backend, baseURL)
    await evaluate(page, 'value=91', '91')
    await native.hide()
    await expect(page.locator('#status')).toHaveText('后台已暂停')
    const ticks = await page.locator('#logs p').filter({ hasText: 'activity-tick=' }).count()
    await observe(450) // Node clock, unaffected by background timer throttling.
    expect(await page.locator('#logs p').filter({ hasText: 'activity-tick=' }).count()).toBe(ticks)
    await native.freeze()
    await observe(450)
    await native.thaw()
    await expect(page.locator('#status')).toHaveText('后台已暂停')
    expect(await page.locator('#logs p').filter({ hasText: 'activity-tick=' }).count()).toBe(ticks)
    await native.show()
    await evaluate(page, 'value', '91')
    const events = await nativeEvents(page)
    for (const event of ['freeze', 'resume'])
      expect(events.some((item) => item.event === event && item.trusted)).toBe(true)
    for (const visibility of ['hidden', 'visible'])
      expect(
        events.some(
          (item) =>
            item.event === 'visibilitychange' && item.trusted && item.visibility === visibility,
        ),
      ).toBe(true)
    await page.locator('#pause').click()
    await native.hide()
    await native.show()
    await expect(page.locator('#status')).toHaveText('已暂停')
    await page.locator('#pause').click()
    await evaluate(page, 'value', '91')
    await page.locator('#stop').click()
  })
  test(`${backend}: trusted hidden continuation still respects browser freezing`, async ({
    native,
    baseURL,
  }) => {
    const { page } = native
    await loadActivity(page, backend, baseURL)
    await page.locator('#pause-background').uncheck()
    await native.hide()
    await expect(page.locator('#status')).toHaveText('运行中')
    const ticks = () => page.locator('#logs p').filter({ hasText: 'activity-tick=' }).count()
    const before = await ticks()
    await expect.poll(ticks).toBeGreaterThan(before)
    await native.freeze()
    await observe(650)
    await native.thaw()
    await expect(page.locator('#stage')).toHaveAttribute('data-activity', 'hidden')
    await expect(page.locator('#status')).toHaveText('运行中')
    const events = await nativeEvents(page)
    const freeze = events.find((item) => item.event === 'freeze')!,
      resume = events.find((item) => item.event === 'resume')!
    expect(freeze.trusted && resume.trusted).toBe(true)
    expect(resume.time - freeze.time).toBeGreaterThanOrEqual(600)
    const after = await ticks()
    await expect.poll(ticks).toBeGreaterThan(after)
    await native.show()
    await evaluate(page, 'value', '17')
    await page.locator('#stop').click()
  })
}
