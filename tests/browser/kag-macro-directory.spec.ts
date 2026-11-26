import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagMacroDirectoryChapter, kagMacroDirectoryGameSource, kagMacroDirectoryStory } from '../helpers/kag-macro-directory.ts'
import { kagGameControls } from '../helpers/kag-game-controls.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: the original KAG player follows a dynamic call directory, saves its chapter and returns after restarting`, async ({ page }, info) => {
    test.setTimeout(150000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [],
      { read, clickLink } = kagGameControls(page, observations), canvas = page.locator('#stage canvas[data-window-id]')
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    const ready = async () => {
      await expect(page.getByText('macro-directory-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const fullscreen = page.locator('.leave-fullscreen')
      if (await fullscreen.isVisible()) await fullscreen.click()
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
    }
    const state = async (progress: number, visits: number, choice = false, reads = 'call') => {
      await expect.poll(() => read('directoryGameState()'), { timeout: 15000 }).toBe((choice
        ? `0|CHOOSE|${visits}|*choice|2|0|0|0|`
        : `${progress}|CHAPTER ${progress}|${visits}|*checkpoint|4|0|1|0|`) + reads)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    }
    const backup = async (name: string) => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), data = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] },
        file = data.files.find((entry) => entry.path === 'savedata/directory0.kdt')
      expect(file).toBeDefined()
      const slot = Buffer.from(file!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('directoryProgress'); expect(slot.toString('utf16le')).toContain('*checkpoint')
      if (binary) {
        const compiled = data.files.find((entry) => entry.path === 'savedata/directory-game.cjs')
        expect(compiled).toBeDefined(); expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      await info.attach(name, { body: bytes, contentType: 'application/json' })
      observations.push({ backup: name, gameId: data.gameId, slotSha256: createHash('sha256').update(slot).digest('hex') })
      return { gameId: data.gameId, slot }
    }
    try {
      expect(createHash('sha256').update(original).digest('hex'))
        .toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      const wide = (source: string) => Buffer.from('\ufeff' + source, 'utf16le')
      await page.locator('#files').setInputFiles([
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'first.ks', mimeType: 'text/plain', buffer: wide(kagMacroDirectoryStory) },
        { name: 'directory-game-chapter.ks', mimeType: 'text/plain', buffer: wide(kagMacroDirectoryChapter) },
        { name: 'directory-game-wrong.ks', mimeType: 'text/plain', buffer: wide('*wrong\n[eval exp="throw new Exception(\'Wrong chapter was selected\')"]\n[s]\n') },
        { name: 'directory-game.tjs', mimeType: 'text/plain', buffer: wide(kagMacroDirectoryGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: wide(binary
          ? 'Scripts.compileStorage("directory-game.tjs","savedata/directory-game.cjs",false,true,false);Scripts.execStorage("savedata/directory-game.cjs");'
          : 'Scripts.execStorage("directory-game.tjs");') },
      ])
      await ready(); await state(0, 1, true, '')
      await clickLink(0, '*selected'); await state(7, 2)
      await clickLink(0, '*save'); await state(7, 3)
      expect(await read('directoryGameStored()')).toBe('7|directory-game-chapter.ks|*checkpoint|1|1')
      const saved = await backup('directory-saved.json')
      await clickLink(1, '*change'); await state(99, 4)
      await clickLink(2, '*load'); await state(7, 5)
      await info.attach('directory-loaded', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await page.locator('#restart').click(); await ready(); await state(0, 1, true, '')
      const reopened = await backup('directory-reopened.json')
      expect(reopened.gameId).toBe(saved.gameId); expect(reopened.slot.equals(saved.slot)).toBe(true)
      await clickLink(1, '*load'); await state(7, 2, false, '')
      await info.attach('directory-restarted-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await clickLink(3, '*return')
      await expect.poll(() => read('directoryGameState()'), { timeout: 15000 }).toBe('7|RETURN 7|3|*returned|0|0|0|1|')
      await info.attach('directory-returned-caller', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('directory-source', { body: kagMacroDirectoryStory + '\n' + kagMacroDirectoryChapter + '\n' + kagMacroDirectoryGameSource, contentType: 'text/plain' }),
      () => info.attach('directory-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Unmodified stock KAG Conductor reads a real macros.call property before executing its built-in call. Actual choice/save/change/load/restart keeps the selected chapter and saved caller; the author removes the executable property before the checkpoint. Read-only console observations never advance the plot.' }, null, 2), contentType: 'application/json' }),
      async () => info.attach('directory-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG macro directory gameplay or cleanup failed', { cause: failures[0] })
  })
