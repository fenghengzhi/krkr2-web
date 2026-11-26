import { test, expect } from '@playwright/test'
import { scriptEncodingFiles, scriptEncodingGame, encodingReadsExpected } from '../helpers/script-encoding-game.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode observer' : 'source observer'}: a temporary GBK game keeps default text reads separate from BOM and explicit converters`, async ({ page }, info) => {
    test.setTimeout(90000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await scriptEncodingFiles(binary), game = scriptEncodingGame(page, info), failures: unknown[] = []
    try {
      await expect(page.locator('#script-encoding')).toHaveValue('auto')
      await page.locator('#files').setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain',
        buffer: Buffer.from('System.exitOnNoWindowStartup=false;Debug.message("auto-opening:中文");') })
      await expect(page.getByText('auto-opening:中文', { exact: true })).toBeVisible()
      await game.stop()
      await page.locator('#script-encoding').selectOption('gbk')
      await page.locator('#files').setInputFiles(fixture.files)
      await game.ready(); await game.state(0, 1, true)
      // Future-import controls must not change the running script decoder.
      await page.locator('#script-encoding').selectOption('big5')
      expect(await game.read('encodingReads()')).toBe(encodingReadsExpected())
      await game.clickLink(1, '*override'); await game.state(0, 2, true)
      expect(await game.read('encodingReads()')).toBe(encodingReadsExpected(true))
      await game.clickLink(0, '*selected'); await game.state(7, 3)
      await game.screenshot('temporary-gbk-chapter')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    await game.finish(failures, fixture)
  })
