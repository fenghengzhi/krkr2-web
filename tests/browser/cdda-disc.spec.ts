import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { cddaGame } from '../helpers/cdda-disc.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: packaged CUE tracks play through CDDASoundBuffer and the AudioWorklet`, async ({ page }, info) => {
    test.setTimeout(60000)
    const errors: string[] = [], failures: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    await page.locator('#project-mode').selectOption('auto')
    try {
      await page.locator('#files').setInputFiles({ name: 'data.xp3', mimeType: 'application/octet-stream',
        buffer: xp3Fixture(cddaGame(binary)).bytes })
      await expect(page.getByText('disc-player-ready', { exact: true })).toBeVisible()
      await evaluate(page, 'cdOpen("2")', 'stop,1000,0,2,16')
      await evaluate(page, 'cdSeek(500)', '22050')
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await evaluate(page, 'cdPlay(true)', 'play')
      const meter = page.locator('#sound-level')
      await expect.poll(() => meter.evaluate((el) => Number((el as HTMLElement).dataset.maxPeak))).toBeGreaterThan(0.3)
      await evaluate(page, 'cdOpen("D:1")', 'stop,2000,0,2,16')
      await evaluate(page, 'cdSeek(1950)', '85995')
      await evaluate(page, 'cdPlay(false)', 'play')
      await expect.poll(() => meter.getAttribute('data-stream-voices')).toBe('1')
      await evaluate(page, 'cdOpen("audio/disc.wav")', 'stop,3000,0,2,16')
      expect(errors).toEqual([])
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('cdda-player-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try {
      await page.locator('#stop').dispatchEvent('click')
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'CDDA packaged playback or cleanup failed', { cause: failures[0] })
  })
