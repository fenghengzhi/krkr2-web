import { setTimeout as observe } from 'node:timers/promises'
import { test as base, expect, nativeEvents } from '../helpers/native-activity-browser.ts'
import { audioPosition, injectAudioProbe, loadMedia } from '../helpers/media-browser.ts'
import type { Locator } from '@playwright/test'

// Browser/media startup has its own preparation budget. Otherwise a slow setup
// consumes the 30 s body budget before the required 21 s frozen interval ends.
const test = base.extend<{ freezeMedia: Locator }>({
  freezeMedia: [
    async ({ native, baseURL }, use) => {
      const { page } = native
      await injectAudioProbe(page)
      const movie = await loadMedia(page, 'asyncify', baseURL)
      await page.locator('#pause-background').uncheck()
      await native.hide()
      await expect(page.locator('#status')).toHaveText('运行中')
      await use(movie)
    },
    { timeout: 30_000 },
  ],
})

test('native freezing longer than media request deadlines does not fail on thaw', async ({
  native,
  freezeMedia: movie,
}) => {
  const { page } = native
  await native.freeze()
  await observe(21_050) // Exceeds the existing 15 s host and 20 s Worker request deadlines.
  await native.thaw()
  await native.show()
  await expect(page.locator('#status')).toHaveText('运行中')
  await expect(movie).toHaveJSProperty('paused', false)
  const audio = await audioPosition(page)
  await expect.poll(() => audioPosition(page)).not.toBe(audio)
  await expect(page.locator('#logs')).not.toContainText('timed out')
  const events = await nativeEvents(page),
    freeze = events.find((item) => item.event === 'freeze')!,
    resume = events.find((item) => item.event === 'resume')!
  expect(freeze.trusted && resume.trusted).toBe(true)
  expect(resume.time - freeze.time).toBeGreaterThan(21_000)
  await page.locator('#stop').click()
})
