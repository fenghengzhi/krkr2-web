import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagGameControls } from '../helpers/kag-game-controls.ts'
import { nameFocusSource, nameFocusStory } from '../helpers/layer-focus-result.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: original KAG confirms a focused EditLayer hero name and restores that named chapter`, async ({ page }, info) => {
    test.setTimeout(180000)
    const failures: unknown[] = [], observations: unknown[] = [], errors: string[] = [],
      { read, clickLink } = kagGameControls(page, observations, { firstReadTimeout: 30000 }),
      canvas = page.locator('#stage canvas[data-window-id]'), keyboard = page.locator('#stage textarea.game-text-input'),
      original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const ready = async (saved: boolean) => {
      await expect(page.getByText('name-focus-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen'); if (await leave.isVisible()) await leave.click()
      await expect(canvas).toHaveCount(1)
      await expect.poll(() => read('nameFocusState()'), { timeout: 15000 }).toBe(`input|1|||0|*name|${saved ? 3 : 2}|0`)
      expect(await read('nameFieldState()')).toBe('||1|0|0')
    }
    const chapter = (name: string, visits: number) => expect.poll(() => read('nameFocusState()'), { timeout: 15000 })
      .toBe(`chapter|1|${name}|HELLO ${name}|${visits}|*chapter|4|0`)
    const focus = async () => {
      await canvas.scrollIntoViewIfNeeded(); await canvas.focus(); await expect(keyboard).toBeFocused()
    }
    const backup = async (label: string) => {
      await page.locator('#save-format').selectOption('backup')
      const pending = page.waitForEvent('download', { timeout: 10000 })
      await page.locator('#export-saves').click()
      const download = await pending; expect(await download.failure()).toBeNull()
      const local = await download.path(); expect(local).not.toBeNull()
      const bytes = await readFile(local!), data = JSON.parse(bytes.toString()) as { files: { path: string; base64: string }[] },
        file = data.files.find(file => file.path === 'savedata/hero0.kdt')
      expect(file).toBeDefined()
      const slot = Buffer.from(file!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('ALICE'); expect(slot.toString('utf16le')).toContain('*chapter')
      if (binary) {
        const observer = data.files.find(file => file.path === 'savedata/name-focus.cjs')
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
        { name: 'first.ks', mimeType: 'text/plain', buffer: wide(nameFocusStory) },
        { name: 'name-focus.tjs', mimeType: 'text/plain', buffer: wide(nameFocusSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: wide(binary
          ? 'Scripts.compileStorage("name-focus.tjs","savedata/name-focus.cjs",false,true,false);Scripts.execStorage("savedata/name-focus.cjs");'
          : 'Scripts.execStorage("name-focus.tjs");') },
      ])
      await ready(false)
      expect(await read('kag.current.links[1].target')).toBe('*confirm')
      await focus()
      await page.keyboard.type('TEMP')
      await page.keyboard.press('Control+a', { delay: 200 })
      await page.keyboard.type('ALICE')
      // Native EditLayer owns the selection/text; f.hero is only assigned by
      // the stock [commit] after activating Confirm. Tab reaches the original
      // MessageLayer's link through LinkEditLayer.onSearchNextFocusable.
      await page.keyboard.press('Tab', { delay: 200 })
      await expect.poll(() => read('nameFieldState()'), { timeout: 15000 }).toBe('ALICE||0|1|1')
      await info.attach('original-name-edit-and-confirm', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await focus(); await page.keyboard.press('Enter', { delay: 200 }); await chapter('ALICE', 1)
      await clickLink(0, '*save'); await chapter('ALICE', 2)
      expect(await read('nameStored()')).toBe('ALICE|*chapter')
      const saved = await backup('hero-named-slot.json')
      await clickLink(1, '*change'); await chapter('BOB', 3)
      await clickLink(2, '*load'); await chapter('ALICE', 4)
      expect((await backup('hero-after-load.json')).equals(saved)).toBe(true)
      await page.locator('#restart').click(); await ready(true)
      expect((await backup('hero-after-restart.json')).equals(saved)).toBe(true)
      // Fresh startup shows the original name editor again. The player can
      // load the prior chapter directly; no name typing or commit is replayed.
      await clickLink(2, '*load'); await chapter('ALICE', 1)
      await clickLink(3, '*continue')
      await expect.poll(() => read('kag.currentLabel+"|"+kag.historyLayer.currentLine+"|"+int(kag.clickWaiting)'), { timeout: 15000 })
        .toBe('*continue|ADVENTURE ALICE|1')
      await focus(); await page.keyboard.press('Enter', { delay: 200 }); await chapter('ALICE', 2)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('name-focus-author-source', { body: nameFocusSource + '\n' + nameFocusStory, contentType: 'text/plain' }),
      () => info.attach('name-focus-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Unmodified original KAG/LinkEditLayer/EditLayer/MessageLayer/Conductor. An authored scene checks Layer.focus success before exposing Confirm; real typing, Control+A, Tab and Enter commit the hero name. Actual save/change/load/restart and choice clicks preserve the chapter and native slot. Console reads only observe after key release.' }, null, 2), contentType: 'application/json' }),
      async () => info.attach('name-focus-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter(worker => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Original name entry, bookmark or cleanup failed', { cause: failures[0] })
  })
