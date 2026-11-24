import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { sliNativeFiles, sliNativeSource, sliNativeLabels, sliNativeFlags, sliInvalidNames } from '../helpers/sli-native-fixtures.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: native SLI parsing, conditional playback and label expressions reach the real AudioWorklet`, async ({ page }, info) => {
    test.setTimeout(60000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("sli-native.tjs","savedata/sli-native.cjs",false,true,false);Scripts.execStorage("savedata/sli-native.cjs");'
          : 'Scripts.execStorage("sli-native.tjs");') },
        { name: 'sli-native.tjs', mimeType: 'text/plain', buffer: Buffer.from(sliNativeSource) },
        ...Object.entries(sliNativeFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('sli-ready', { exact: true })).toBeVisible()
      await evaluate(page, 'sliTryOpen("bad-smooth.wav")', 'ループ情報 bad-smooth.wav.sli は異常です')
      await evaluate(page, 'System.assignMessage("TVPInvalidLoopInformation","sli-browser:<%1>")', '1')
      for (const name of sliInvalidNames) {
        await evaluate(page, `sliTryOpen("${name}")`, `sli-browser:<${name}.sli>`)
        await evaluate(page, 'sliSound.status', 'unload')
      }
      await evaluate(page, 'sliTryOpen("native.wav")', 'open')
      await evaluate(page, 'sliSound.labels["\\\"quoted\\\""].name', '"quoted"')
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await evaluate(page, 'sliBegin()', '0')
      await expect(page.getByText('sli-finished:' + sliNativeFlags.join(','), { exact: true })).toBeVisible()
      await evaluate(page, 'sliSound.status', 'stop')
      await evaluate(page, 'sliLabels.join("|")', sliNativeLabels.join('|'))
      await evaluate(page, 'sliFlagText()', sliNativeFlags.join(','))
      await expect.poll(() => page.locator('#sound-level').evaluate((element) => Number((element as HTMLElement).dataset.maxPeak))).toBeGreaterThan(0.1)
      expect(errors).toEqual([])
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('sli-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try {
      await page.locator('#stop').evaluate((element: HTMLButtonElement) => element.click())
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Native SLI browser or cleanup failed', { cause: failures[0] })
  })
