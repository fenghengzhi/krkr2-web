import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { wavePrecisionGame } from '../helpers/extensible-wave.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: valid-bit WAVE music reaches the AudioWorklet and ends at the PCM boundary`, async ({ page }, info) => {
    test.setTimeout(60000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const failures: unknown[] = []
    try {
      await page.locator('#files').setInputFiles(Object.entries(wavePrecisionGame(binary)).map(([name, value]) => ({
        name, mimeType: 'application/octet-stream',
        buffer: Buffer.from(typeof value === 'string' ? new TextEncoder().encode(value) : value),
      })))
      await expect(page.getByText('precision-ready', { exact: true })).toBeVisible()
      await evaluate(page, 'precisionOpen("12-in-16.wav")', '12,2,48000,133,0,stop')
      await evaluate(page, 'precisionOpen("20-in-24.wav")', '20,2,48000,120,0,stop')
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await evaluate(page, 'precisionPlay()', 'started')
      await expect(page.getByText('precision-ended', { exact: true })).toBeVisible()
      await expect.poll(() => page.locator('#sound-level').evaluate((el) => Number((el as HTMLElement).dataset.maxPeak))).toBeGreaterThan(0.3)
      await evaluate(page, 'precisionWave.status', 'stop')
      await evaluate(page, 'precisionOpen("24-in-32.wav")', '24,2,48000,133,0,stop')
      await evaluate(page, '(precisionWave.samplePosition=4096,precisionWave.samplePosition)', '4096')
      await evaluate(page, 'System.assignMessage("TVPUnknownWaveFormat","wave:<%1>")', '1')
      await evaluate(page, 'precisionError()', 'wave:<foreign-guid.wav>')
      await evaluate(page, 'precisionWave.status', 'unload')
      await evaluate(page, 'precisionOpen("20-in-24.wav")', '20,2,48000,120,0,stop')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-precision-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try {
      await page.locator('#stop').dispatchEvent('click')
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((w) => w.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'WAVE browser playback or cleanup failed', { cause: failures[0] })
  })
