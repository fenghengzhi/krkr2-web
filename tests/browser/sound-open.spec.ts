import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { soundOpenExpected, soundOpenFiles, soundOpenSource } from '../helpers/sound-open.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: bad sound open arguments preserve the audible Worker voice and current message holders`, async ({ page }, info) => {
    test.setTimeout(60000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("open-control.tjs","savedata/open-control.cjs",false,true,false);Scripts.execStorage("savedata/open-control.cjs");'
          : 'Scripts.execStorage("open-control.tjs");') },
        { name: 'open-control.tjs', mimeType: 'text/plain', buffer: Buffer.from(soundOpenSource) },
        ...Object.entries(soundOpenFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('sound-open-ready', { exact: true })).toBeVisible()
      for (const [kind, expected] of Object.entries(soundOpenExpected))
        await evaluate(page, `soundOpenObserve("${kind}")`, expected)
      await evaluate(page, '(function(){global.openSound=new OpenWave();openSound.open("open-keep.wav");global.oldOpenLabels=openSound.labels;openSound.looping=true;openSound.play();openSound.fade(0,1000000000);return openSound.status;})()', 'play')
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      const meter = () => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value)
      await expect.poll(meter).toBe(0.25)
      await evaluate(page, 'soundOpenErrors(openSound)', 'open-count|open-string')
      await evaluate(page, '[openSound.status,openSound.volume,openSound.completed,int(oldOpenLabels==openSound.labels),int(isvalid oldOpenLabels),openSound.states.join(",")].join("|")', 'play|100000|0|1|1|stop,play')
      await expect.poll(meter).toBe(0.25)
      await evaluate(page, '(System.assignMessage("TJSBadParamCount","worker-open-count"),System.assignMessage("TJSVariantConvertError","worker-open-string"),soundOpenErrors(openSound))', 'worker-open-count|worker-open-string')
      await expect.poll(meter).toBe(0.25)
      await evaluate(page, '(openSound.stopFade(),[openSound.volume,openSound.completed,openSound.status].join(","))', '0,1,play')
      await expect.poll(meter).toBe(0)
      await evaluate(page, '(invalidate openSound,int(!isvalid openSound))', '1')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('sound-open-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Sound open browser or cleanup failed', { cause: failures[0] })
  })
