import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagGameControls } from '../helpers/kag-game-controls.ts'
import { modalReadingSource, modalReadingStory } from '../helpers/kag-modal-reading.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a modal note receives reading keys before Tab selects the original KAG route`, async ({ page }, info) => {
    test.setTimeout(180000)
    const failures: unknown[] = [], observations: unknown[] = [], errors: string[] = [],
      { read, clickLink } = kagGameControls(page, observations, { firstReadTimeout: 30000 }),
      canvas = page.locator('#stage canvas[data-window-id]'), keyboard = page.locator('#stage textarea.game-text-input'),
      original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const ready = async (saved: boolean) => {
      await expect(page.getByText('modal-reading-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen'); if (await leave.isVisible()) await leave.click()
      await expect(canvas).toHaveCount(1)
      await expect.poll(() => read('modalReadingState()'), { timeout: 15000 }).toBe(`menu|0|0||0|*menu|${saved ? 2 : 1}|0`)
    }
    const chapter = (choice: number, visits: number, pages = 2) => expect.poll(() => read('modalReadingState()'), { timeout: 15000 })
      .toBe(`chapter|${pages}|${choice}|FOREST ROUTE ${choice}|${visits}|*chapter|4|0`)
    const key = async (name: string) => {
      await canvas.scrollIntoViewIfNeeded(); await canvas.focus(); await expect(keyboard).toBeFocused()
      await page.keyboard.press(name, { delay: 200 })
    }
    const backup = async (label: string) => {
      await page.locator('#save-format').selectOption('backup')
      const pending = page.waitForEvent('download', { timeout: 10000 })
      await page.locator('#export-saves').click()
      const download = await pending; expect(await download.failure()).toBeNull()
      const local = await download.path(); expect(local).not.toBeNull()
      const bytes = await readFile(local!), data = JSON.parse(bytes.toString()) as { files: { path: string; base64: string }[] },
        file = data.files.find(file => file.path === 'savedata/modal0.kdt')
      expect(file).toBeDefined()
      const slot = Buffer.from(file!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('*chapter')
      if (binary) {
        const observer = data.files.find(file => file.path === 'savedata/modal-reading.cjs')
        expect(observer).toBeDefined(); expect(Buffer.from(observer!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      await info.attach(label, { body: bytes, contentType: 'application/json' })
      return slot
    }
    try {
      expect(createHash('sha256').update(original).digest('hex')).toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      const wide = (value: string) => Buffer.from('\ufeff' + value, 'utf16le')
      await page.locator('#files').setInputFiles([
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'first.ks', mimeType: 'text/plain', buffer: wide(modalReadingStory) },
        { name: 'modal-reading.tjs', mimeType: 'text/plain', buffer: wide(modalReadingSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: wide(binary
          ? 'Scripts.compileStorage("modal-reading.tjs","savedata/modal-reading.cjs",false,true,false);Scripts.execStorage("savedata/modal-reading.cjs");'
          : 'Scripts.execStorage("modal-reading.tjs");') },
      ])
      await ready(false); await clickLink(0, '*read')
      await expect.poll(() => read('modalReadingState()'), { timeout: 15000 }).toBe('reading|0|0||0|*read|0|0')
      expect(await read('modalReadingFocus()')).toBe('1|0|1|0|0')
      // This sample is actual renderer backing data, independent of CSS
      // positioning. It confirms the note is visibly above the KAG message.
      await expect.poll(() => canvas.evaluate(node => {
        const source = node as HTMLCanvasElement, copy = new OffscreenCanvas(source.width, source.height),
          context = copy.getContext('2d', { willReadFrequently: true })!
        context.drawImage(source, 0, 0)
        return [...context.getImageData(82, 102, 1, 1).data]
      })).toEqual([24, 48, 72, 255])
      const cursor = await read('[kag.mainConductor.curLine,kag.mainConductor.curPos,kag.mainConductor.status].join("|")')
      for (const pages of [1, 2]) {
        await key('Enter')
        await expect.poll(() => read('modalReadingState()'), { timeout: 15000 }).toBe(`reading|${pages}|0||0|*read|0|0`)
        expect(await read('modalReadingFocus()')).toBe('1|0|1|0|0')
        expect(await read('[kag.mainConductor.curLine,kag.mainConductor.curPos,kag.mainConductor.status].join("|")')).toBe(cursor)
      }
      await info.attach('modal-note-read', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await key('Tab')
      await expect.poll(() => read('modalReadingFocus()'), { timeout: 15000 }).toBe('0|1|1|0|0')
      await key('Enter'); await chapter(7, 1)
      expect(await read('int(kag.currentModalLayer===null)+"|"+int(kag.current.nodeEnabled)')).toBe('1|1')
      await clickLink(0, '*save'); await chapter(7, 2)
      expect(await read('modalReadingStored()')).toBe('7|*chapter')
      const saved = await backup('modal-reading-slot.json')
      await clickLink(1, '*change'); await chapter(99, 3)
      await clickLink(2, '*load'); await chapter(7, 4)
      expect((await backup('modal-reading-loaded.json')).equals(saved)).toBe(true)
      await page.locator('#restart').click(); await ready(true)
      expect((await backup('modal-reading-restarted.json')).equals(saved)).toBe(true)
      await clickLink(1, '*load'); await chapter(7, 1, 0)
      expect(await read('int(global.modalReader===void)')).toBe('1')
      await clickLink(3, '*continue')
      await expect.poll(() => read('kag.historyLayer.currentLine+"|"+int(kag.clickWaiting)'), { timeout: 15000 }).toBe('THE FOREST IS SAFE|1')
      await key('Enter'); await chapter(7, 2, 0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('modal-reading-author-source', { body: modalReadingSource + '\n' + modalReadingStory, contentType: 'text/plain' }),
      () => info.attach('modal-reading-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Unmodified KAG template with a game-owned modal reading Layer and action button. setMode alone chooses initial focus; no script focus workaround. Physical Enter reads both pages, Tab moves to the button, and Enter selects the story. Original links save/load/restart the route without replaying the modal.' }, null, 2), contentType: 'application/json' }),
      async () => info.attach('modal-reading-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter(worker => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Modal reading, chosen route or cleanup failed', { cause: failures[0] })
  })
