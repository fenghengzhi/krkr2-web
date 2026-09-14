import { test, expect } from '@playwright/test'
import { injectActivity, visibility, lifecycle } from '../helpers/activity-browser.ts'
import {
  audioPosition,
  injectAudioProbe,
  loadMedia,
  injectVideoClockProbe,
  attachVideoClockProbe,
} from '../helpers/media-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: page media gates preserve positions and coexist with user pause`, async ({
    page,
  }, testInfo) => {
    await injectActivity(page)
    await injectAudioProbe(page)
    await injectVideoClockProbe(page)
    try {
      const movie = await loadMedia(page, backend)
      await visibility(page, 'hidden')
      await expect(page.locator('#status')).toHaveText('后台已暂停')
      await expect(movie).toHaveJSProperty('paused', true)
      const audio = await audioPosition(page),
        video = await movie.evaluate((el) => (el as HTMLVideoElement).currentTime)
      await page.waitForTimeout(350) // Measure actual playback position during suspension.
      expect(await audioPosition(page)).toBe(audio)
      expect(await movie.evaluate((el) => (el as HTMLVideoElement).currentTime)).toBe(video)
      await visibility(page, 'visible')
      await expect(movie).toHaveJSProperty('paused', false)
      await expect.poll(() => audioPosition(page)).not.toBe(audio)
      await page.locator('#pause-background').uncheck()
      await visibility(page, 'hidden')
      await expect(page.locator('#status')).toHaveText('运行中')
      const running = await audioPosition(page)
      await expect.poll(() => audioPosition(page)).not.toBe(running)
      await expect(movie).toHaveJSProperty('paused', false)
      await lifecycle(page, 'freeze')
      await expect(page.locator('#status')).toHaveText('页面已冻结')
      await expect(movie).toHaveJSProperty('paused', true)
      const frozen = await audioPosition(page)
      await page.waitForTimeout(350)
      expect(await audioPosition(page)).toBe(frozen)
      await lifecycle(page, 'resume')
      await visibility(page, 'visible')
      await page.locator('#pause').click()
      await visibility(page, 'hidden')
      await visibility(page, 'visible')
      await expect(page.locator('#status')).toHaveText('已暂停')
      await expect(movie).toHaveJSProperty('paused', true)
      await page.locator('#pause').click()
      await evaluate(page, 'sound.status', 'play')
      await page.locator('#stop').click()
    } finally {
      await attachVideoClockProbe(page, testInfo)
    }
  })
