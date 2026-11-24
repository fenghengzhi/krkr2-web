import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { wavePositionExpected, wavePositionFiles, wavePositionSource } from '../helpers/wave-position.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: Wave coordinates and native argument errors reach the Worker while ordinary playback stays audible`, async ({ page }, info) => {
    test.setTimeout(60000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("position.tjs","savedata/position.cjs",false,true,false);Scripts.execStorage("savedata/position.cjs");'
          : 'Scripts.execStorage("position.tjs");') },
        { name: 'position.tjs', mimeType: 'text/plain', buffer: Buffer.from(wavePositionSource + '\nDebug.message("wave-position-ready");') },
        ...Object.entries(wavePositionFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('wave-position-ready', { exact: true })).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      for (const [name, expected] of Object.entries(wavePositionExpected))
        await evaluate(page, `wavePositionObserve("${name}")`, expected)
      await evaluate(page, 'System.assignMessage("TJSBadParamCount","browser-position-count")', '1')
      await evaluate(page, '(function(){var w=new WaveSoundBuffer(null);try{w.setPos(%[]);}catch(e){invalidate w;return e.message;}})()', 'browser-position-count')
      await evaluate(page, '(function(){global.positionMusic=new WaveSoundBuffer(null);positionMusic.open("position.wav");positionMusic.looping=true;positionMusic.play();positionMusic.setPos(1e100,-1e100,100000);return positionMusic.pan+","+positionMusic.status;})()', '0,play')
      await expect.poll(() => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value)).toBeGreaterThan(0.4)
      await evaluate(page, '(positionMusic.setPos(7,8,9),positionMusic.pan=50000,wavePositionText(positionMusic))', '7,8,9')
      await expect.poll(() => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value)).toBeGreaterThan(0.4)
      await evaluate(page, '(function(){invalidate positionMusic;return int(!isvalid positionMusic);})()', '1')
      await expect.poll(() => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value)).toBe(0)
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-position-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try {
      await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave position browser or cleanup failed', { cause: failures[0] })
  })
