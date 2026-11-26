import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { discStoryGame } from '../helpers/disc-story.ts'
import { kagGameControls } from '../helpers/kag-game-controls.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: original KAG reads the chapter from a CD and restores its saved page after library restart`, async ({ page }, info) => {
    test.setTimeout(150000)
    const errors: string[] = [], observations: unknown[] = [], failures: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const { read, clickLink } = kagGameControls(page, observations)
    const canvas = page.locator('#stage canvas[data-window-id]'), title = `CD story ${backend} ${binary}`
    const item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    const ready = async () => {
      await expect(page.getByText('story-disc-ready:G:/|Moon disc scene|81', { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen')
      if (await leave.isVisible()) await leave.click()
      await expect.poll(() => read('discState()')).toBe('*choice|2|0|0')
    }
    const chapter = async (value: number, visits: number) => {
      await expect.poll(() => read('discState()')).toBe(`*arrival|2|0|${value}`)
      await expect.poll(() => read('discVisits')).toBe(String(visits))
      expect(await read('Storages.getPlacedPath("story.ks")')).toBe('file://./g/routes/story.ks')
      expect(await read('kag.fore.base.getMainPixel(0,0)')).toBe(String(0x336699))
      expect(await read('discRendered')).toContain(`Moon disc scene ${value}`)
    }
    const stop = async () => {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
    }
    const slotBytes = async () => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path()
      if (!path) throw new Error('No save backup returned')
      const backup = JSON.parse(await readFile(path, 'utf8')) as { files: { path: string; base64: string }[] }
      const slot = backup.files.find((file) => file.path === 'savedata/disc0.kdt')
      if (!slot) throw new Error('KAG slot 0 is missing')
      const bytes = Buffer.from(slot.base64, 'base64')
      expect(bytes.toString('utf16le')).toContain('*arrival')
      expect(backup.files.every((file) => !file.path.includes('://'))).toBe(true)
      return bytes
    }
    try {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#cdda-discs').fill(binary ? 'G=game://./story.iso' : 'G=game://./story.cue')
      await page.locator('#files').setInputFiles(discStoryGame(binary))
      await ready()
      await clickLink(0, '*enter'); await chapter(42, 1)
      await clickLink(0, '*save'); await chapter(42, 2)
      expect(await read('discSlot()')).toBe('42|*arrival')
      const before = await slotBytes()
      await clickLink(1, '*change'); await chapter(99, 3)
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await stop(); await page.reload()
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await ready()
      expect((await slotBytes()).equals(before)).toBe(true)
      await clickLink(1, '*load'); await chapter(42, 1)
      await info.attach('restored-disc-chapter', { body: await canvas.screenshot(), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const finish of [
      () => info.attach('disc-chapter-observations', { body: JSON.stringify({ observations, errors }), contentType: 'application/json' }),
      async () => info.attach('disc-chapter-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
      stop,
    ]) try { await finish() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Disc chapter or cleanup failed', { cause: failures[0] })
  })
}
