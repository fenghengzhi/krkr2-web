import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { member, distributionZip } from '../helpers/deflated-distribution.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode observer' : 'source observer'}: packaged original KAG selects its patch and restores a slot from the disk library`, async ({ page }) => {
    test.setTimeout(120000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const base = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    const story = await readFile(new URL('../fixtures/kag-save.ks', import.meta.url))
    const patch = xp3Fixture({ 'first.ks': story }, { compressed: true })
    const observer = 'function releasePaths(){return System.exePath+"|"+Storages.getPlacedPath("first.ks");}'
    const zip = distributionZip([member('KAG/data.xp3', base), member('KAG/patch.xp3', patch.bytes),
      member('KAG/observer.tjs', observer), member('KAG/AfterInit2.tjs', binary
        ? 'Scripts.compileStorage(System.exePath+"observer.tjs",System.dataPath+"observe.cjs",false,true,false);Scripts.execStorage(System.dataPath+"observe.cjs");'
        : 'Scripts.execStorage(System.exePath+"observer.tjs");')])
    const ready = async () => {
      await expect(page.getByText('save=ready:7', { exact: true })).toBeVisible({ timeout: 45000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      await evaluate(page, 'releasePaths()', 'game://./KAG/|game://./KAG/patch.xp3>first.ks')
    }
    try {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#files').setInputFiles({ name: 'edition.zip', mimeType: 'application/zip', buffer: zip })
      await ready()
      await evaluate(page, 'kag.saveBookMarkToFile(System.dataPath+"release-slot.kdt",false)', '1')
      await page.locator('#library-title').fill('Packaged KAG')
      await page.locator('#save-library').click()
      const saved = page.locator('.library-game').filter({ hasText: 'Packaged KAG' })
      await expect(saved).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await page.locator('#stop').press('Enter')
      await expect(page.locator('#status')).toHaveText('待机')
      await page.reload()
      await page.locator('#project-mode').selectOption('root')
      await page.locator('#project-root').fill('another-game/')
      await saved.getByRole('button', { name: '启动', exact: true }).click()
      await ready()
      await evaluate(page, '(f.saved=99,f.saved)', '99')
      await evaluate(page, 'kag.loadBookMarkFromFile(System.dataPath+"release-slot.kdt")', '1')
      await evaluate(page, 'f.saved', '7')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } finally {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
      await expect(page.locator('#status')).toHaveText('待机')
    }
  })
}
