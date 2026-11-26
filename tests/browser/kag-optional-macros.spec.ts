import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagOptionalMacroGameSource, kagOptionalMacroStory } from '../helpers/kag-optional-macros.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode observer' : 'source observer'}: original KAG saves without macros and keeps updated dialogue through load and refresh`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], observations: { expression: string; value: string }[] = [], inputs: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
      utf16 = (value: string) => Buffer.from('\ufeff' + value, 'utf16le'),
      files = [
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'first.ks', mimeType: 'text/plain', buffer: utf16(kagOptionalMacroStory) },
        { name: 'optional-observer.tjs', mimeType: 'text/plain', buffer: utf16(kagOptionalMacroGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: utf16(binary
          ? 'Scripts.compileStorage("optional-observer.tjs","savedata/optional-observer.cjs",false,true,false);Scripts.execStorage("savedata/optional-observer.cjs");'
          : 'Scripts.execStorage("optional-observer.tjs");') },
      ]
    const canvas = page.locator('#stage canvas[data-window-id]')
    const read = async (expression: string): Promise<string> => {
      const prefix = `optional-macro-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.locator('#expression').fill(`${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      await page.locator('#evaluate').click()
      const output = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(output).toBeVisible({ timeout: 5000 })
      const value = ((await output.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 96) observations.push({ expression, value })
      return value
    }
    const start = async () => {
      await page.locator('#files').setInputFiles(files)
      await expect(page.getByText('optional-macro-observer-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      await expect(canvas).toHaveCount(1)
    }
    const state = async (expected: string, label: string) => {
      await expect.poll(() => read('optionalStoryState()'), { timeout: 15000 }).toBe(expected)
      await expect(page.locator('#logs .error')).toHaveCount(0)
      await canvas.scrollIntoViewIfNeeded()
      await info.attach(label, { body: await canvas.screenshot(), contentType: 'image/png' })
    }
    const clickLink = async (index: number, target: string) => {
      // Only observe original MessageLayer geometry; the actual pointer click
      // calls the original link and Conductor save/load/jump handlers.
      const raw = await read(`(function(){var m=kag.current,l=m.links[${index}];
        var x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1);
        if(!l.fixed[0]){x+=m.lineLayerOriginX+m.getLineLayerLeftOffset();y+=m.lineLayerOriginY+m.getLineLayerTopOffset();}
        for(var p=m;p!==null;p=p.parent){x+=p.left;y+=p.top;}
        return [x,y,l.w[0],l.h[0],l.target,int(m.selProcessLock)].join("|");})()`),
        parts = raw.split('|'), x = Number(parts[0]), y = Number(parts[1])
      expect(parts).toHaveLength(6); expect(parts[4]).toBe(target); expect(parts[5]).toBe('0')
      expect(Number(parts[2])).toBeGreaterThan(0); expect(Number(parts[3])).toBeGreaterThan(0)
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(640)
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(480)
      await canvas.scrollIntoViewIfNeeded()
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      inputs.push({ index, target, raw, logicalPoint: [x, y], box })
      await canvas.click({ position: { x: x * box!.width / 640, y: y * box!.height / 480 } })
    }
    try {
      expect(createHash('sha256').update(original).digest('hex'))
        .toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      await start(); await state('1|OLD|0|*checkpoint|3|0|0', 'optional-before-save')
      await clickLink(0, '*save'); await state('2|OLD|1|*checkpoint|3|0|0', 'optional-saved')
      expect(await read('optionalStoredState()')).toBe('1|*checkpoint|0|0')
      const downloading = page.waitForEvent('download')
      await page.locator('#export-saves').click()
      const download = await downloading
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const backup = await readFile(path!)
      await info.attach('optional-macro-save-backup', { body: backup, contentType: 'application/json' })
      await info.attach('optional-macro-save-sha256', { body: createHash('sha256').update(backup).digest('hex'), contentType: 'text/plain' })
      await clickLink(1, '*load'); await state('3|NEW|1|*checkpoint|3|0|0', 'optional-loaded-current-macro')
      await page.reload(); await start(); await state('1|OLD|0|*checkpoint|3|0|0', 'optional-fresh-session')
      expect(await read('optionalStoredState()')).toBe('1|*checkpoint|0|0')
      await clickLink(1, '*load'); await state('2|NEW|0|*checkpoint|3|0|0', 'optional-restored-after-refresh')
      await clickLink(2, '*end')
      await expect(page.getByText('optional-macro-story-finished', { exact: true })).toBeVisible()
      await state('2|DONE|0|*end|0|0|1', 'optional-story-finished')
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('optional-macro-story', { body: kagOptionalMacroStory, contentType: 'text/plain' })
      await info.attach('optional-macro-observations', { body: JSON.stringify({ backend, binary, observations, inputs, errors,
        scope: 'Original KAG template/framework, authored scene uses public save/load tags with ask=false selected by actual links. Console only reads state and the original stored payload; it never saves, loads, redefines macros or replays labels.' }, null, 2), contentType: 'application/json' })
      await info.attach('optional-macro-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
    } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG optional-macro bookmark or cleanup failed', { cause: failures[0] })
  })
