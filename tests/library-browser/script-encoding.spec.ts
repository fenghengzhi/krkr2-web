import { test, expect } from '../helpers/library-browser.ts'
import { scriptEncodingFiles, scriptEncodingGame, encodingReadsExpected } from '../helpers/script-encoding-game.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode observer' : 'source observer'}: a saved GBK KAG game restores its opening decoder and actual bookmark after a library refresh`, async ({ page }, info) => {
    test.setTimeout(150000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await scriptEncodingFiles(binary), game = scriptEncodingGame(page, info), failures: unknown[] = [],
      title = `GBK KAG ${backend} ${binary ? 'compiled' : 'source'}`,
      item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    try {
      await page.locator('#script-encoding').selectOption('gbk')
      await page.locator('#files').setInputFiles(fixture.files)
      await game.ready(); await game.state(0, 1, true)
      await game.clickLink(0, '*selected'); await game.state(7, 2)
      await game.clickLink(0, '*save'); await game.state(7, 3)
      expect(await game.read('encodingStoredState()')).toBe('7|*checkpoint')
      const before = await game.backup('gbk-slot-before-library.json', binary)
      await game.clickLink(1, '*change'); await game.state(99, 4)
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await page.locator('#script-encoding').selectOption('big5')
      await game.stop(); await page.reload()
      await page.locator('#script-encoding').selectOption('big5')
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await game.ready(); await game.state(0, 1, true)
      expect(await game.read('encodingReads()')).toBe(encodingReadsExpected())
      expect(await game.read('encodingStoredState()')).toBe('7|*checkpoint')
      const after = await game.backup('gbk-slot-after-library.json', binary)
      expect(after.gameId).toBe(before.gameId); expect(after.slotBytes.equals(before.slotBytes)).toBe(true)
      await game.clickLink(2, '*load'); await game.state(7, 2)
      await game.screenshot('gbk-library-restored-chapter')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    await game.finish(failures, fixture)
  })
