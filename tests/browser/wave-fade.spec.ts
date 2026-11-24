import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { waveFadeExpected, waveFadeDelayedExpected, waveFadeFiles, waveFadeSource } from '../helpers/wave-fade.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real Wave fade errors, inline reentry and delayed completion reach the AudioWorklet`, async ({ page }, info) => {
    test.setTimeout(60000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("fade-control.tjs","savedata/fade-control.cjs",false,true,false);Scripts.execStorage("savedata/fade-control.cjs");'
          : 'Scripts.execStorage("fade-control.tjs");') },
        { name: 'fade-control.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveFadeSource) },
        ...Object.entries(waveFadeFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('wave-fade-ready', { exact: true })).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      for (const [id, expected] of Object.entries(waveFadeExpected))
        await evaluate(page, `waveFadeObserve("${id}")`, expected)
      await evaluate(page, 'fadeDelayedStart()', 'waiting')
      await expect(page.getByText('fade-delayed:' + waveFadeDelayedExpected, { exact: true })).toHaveCount(1)
      await evaluate(page, '(function(){global.faded=new FadeControl();faded.open("fade.wav");faded.looping=true;faded.play();return faded.status;})()', 'play')
      const meter = page.locator('#sound-level')
      await expect.poll(() => meter.evaluate((node) => (node as HTMLMeterElement).value)).toBeGreaterThan(0.4)
      await evaluate(page, '(faded.fade(0,1),faded.volume+","+faded.observations.join(","))', '0,0')
      await expect.poll(() => meter.evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await evaluate(page, '(faded.fade(100000,1),faded.volume+","+faded.observations.join(","))', '100000,0,100000')
      await expect.poll(() => meter.evaluate((node) => (node as HTMLMeterElement).value)).toBeGreaterThan(0.4)
      await evaluate(page, '(function(){invalidate faded;return 0;})()', '0')
      await expect.poll(() => meter.evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-fade-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try {
      await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave fade browser or cleanup failed', { cause: failures[0] })
  })
