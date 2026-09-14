import { test, expect } from '@playwright/test'
import { injectGpu, gpuWorker, loseGpu, restoreGpu } from '../helpers/gpu-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { audioPosition, injectAudioProbe, loadMedia } from '../helpers/media-browser.ts'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: graphics suspension freezes AudioWorklet and video playback until the replacement frame`, async ({
    page,
  }) => {
    await injectGpu(page)
    await injectAudioProbe(page)
    const movie = await loadMedia(page, backend)
    const worker = await gpuWorker(page)
    await loseGpu(worker)
    await expect(page.locator('#status')).toHaveText('等待画面恢复')
    await expect(movie).toHaveJSProperty('paused', true)
    await expect
      .poll(() => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value))
      .toBe(0)
    const heldAudio = await audioPosition(page)
    const interval = await movie.evaluate(async (element) => {
      const video = element as HTMLVideoElement,
        start = video.currentTime
      // Measure a real suspension interval; this is not a wait for readiness.
      await new Promise((resolve) => setTimeout(resolve, 350))
      return Math.abs(video.currentTime - start)
    })
    expect(interval).toBeLessThan(0.002)
    expect(await audioPosition(page)).toBe(heldAudio)
    await restoreGpu(worker)
    await expect(page.locator('#status')).toHaveText('运行中')
    await expect(movie).toHaveJSProperty('paused', false)
    await expect
      .poll(() => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value))
      .toBeGreaterThan(0.01)
    await expect.poll(() => audioPosition(page)).not.toBe(heldAudio)
    await evaluate(page, 'sound.status', 'play')
    await page.locator('#stop').click()
    await expect(page.locator('video')).toHaveCount(0)
    await expect(page.locator('#sound-status')).toHaveText('声音已关闭。')
  })
