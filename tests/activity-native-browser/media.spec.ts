import { setTimeout as observe } from 'node:timers/promises'
import { test, expect, nativeEvents } from '../helpers/native-activity-browser.ts'
import { audioPosition, injectAudioProbe, loadMedia } from '../helpers/media-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: native background and freeze hold real audio/video positions`, async ({
    native,
    baseURL,
  }) => {
    const { page } = native
    await injectAudioProbe(page)
    const movie = await loadMedia(page, backend, baseURL)
    await evaluate(page, 'global.sentinel=91', '91')
    await native.hide()
    await expect(page.locator('#status')).toHaveText('后台已暂停')
    await expect(movie).toHaveJSProperty('paused', true)
    const audio = await audioPosition(page),
      video = await movie.evaluate((el) => (el as HTMLVideoElement).currentTime)
    await observe(350)
    expect(await audioPosition(page)).toBe(audio)
    expect(await movie.evaluate((el) => (el as HTMLVideoElement).currentTime)).toBe(video)
    await native.freeze()
    await observe(450)
    await native.thaw()
    await expect(page.locator('#status')).toHaveText('后台已暂停')
    expect(await audioPosition(page)).toBe(audio)
    expect(await movie.evaluate((el) => (el as HTMLVideoElement).currentTime)).toBe(video)
    expect((await nativeEvents(page)).some((item) => item.event === 'freeze' && item.trusted)).toBe(
      true,
    )
    await native.show()
    await expect(movie).toHaveJSProperty('paused', false)
    await expect.poll(() => audioPosition(page)).not.toBe(audio)
    await evaluate(page, 'sentinel', '91')
    await evaluate(page, 'sound.status', 'play')
    await page.locator('#stop').click()
    await expect(page.locator('video')).toHaveCount(0)
  })
