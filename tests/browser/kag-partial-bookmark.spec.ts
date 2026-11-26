import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { partialBookmarkFiles, partialBookmarkSource } from '../helpers/kag-partial-bookmark.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a real KAG chapter restores its lightweight label bookmark, retains its caller and reads the saved file after refresh`, async ({ page }, info) => {
    test.setTimeout(120000)
    const errors: string[] = [], failures: unknown[] = [], observations: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
      wide = (text: string) => Buffer.from('\ufeff' + text, 'utf16le'),
      files = [
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        ...Object.entries(partialBookmarkFiles).map(([name, text]) => ({ name, mimeType: 'text/plain', buffer: wide(text) })),
        { name: 'partial-game.tjs', mimeType: 'text/plain', buffer: wide(partialBookmarkSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: wide(binary
          ? 'Scripts.compileStorage("partial-game.tjs",System.dataPath+"partial-game.cjs",false,true,false);Scripts.execStorage(System.dataPath+"partial-game.cjs");'
          : 'Scripts.execStorage("partial-game.tjs");') },
      ], canvas = page.locator('#stage canvas[data-window-id]')
    const read = async (expression: string) => {
      const prefix = `partial-bookmark-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Partial bookmark observer is disabled')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(line).toBeVisible({ timeout: 5000 })
      const value = ((await line.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 128) observations.push({ expression, value })
      return value
    }
    const state = async (value: string) => {
      await expect.poll(() => read('partialGameState()'), { timeout: 15000 }).toBe(value)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    }
    const ready = async () => {
      await expect(page.getByText('partial-bookmark-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen')
      if (await leave.isVisible()) await leave.click()
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
      await state('menu|MENU 0|first.ks|*menu|0|0|0|0|0|none|1|2|0')
    }
    const click = async (index: number, target: string) => {
      const fields = (await read(`(function(){var m=kag.current,l=m.links[${index}];
        var x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1);
        if(!l.fixed[0]){x+=m.lineLayerOriginX+m.getLineLayerLeftOffset();y+=m.lineLayerOriginY+m.getLineLayerTopOffset();}
        for(var p=m;p!==null;p=p.parent){x+=p.left;y+=p.top;}
        return [x,y,l.w[0],l.h[0],l.target,int(m.selProcessLock)].join("|");})()`)).split('|')
      expect(fields).toHaveLength(6); expect(fields[4]).toBe(target); expect(fields[5]).toBe('0')
      const [x, y, width, height] = fields.slice(0, 4).map(Number)
      expect(width).toBeGreaterThan(0); expect(height).toBeGreaterThan(0)
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(640)
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(480)
      await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      observations.push({ click: target, x, y, box })
      await canvas.click({ position: { x: x! * box!.width / 640, y: y! * box!.height / 480 }, timeout: 5000 })
    }
    const backup = async (name: string) => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), data = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] },
        file = data.files.find((entry) => entry.path === 'savedata/partial-bookmark.tjs')
      await info.attach(name, { body: bytes, contentType: 'application/json' })
      expect(file).toBeDefined()
      const slot = Buffer.from(file!.base64, 'base64'), text = slot.toString('utf16le')
      expect(text).toContain('curLabel'); expect(text).toContain('*destination')
      expect(text).toContain('callStack'); expect(text).toContain('storageName'); expect(text).toContain('void')
      if (binary) {
        const compiled = data.files.find((entry) => entry.path === 'savedata/partial-game.cjs')
        expect(compiled).toBeDefined(); expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      observations.push({ backup: name, gameId: data.gameId, slotBytes: slot.length,
        slotSha256: createHash('sha256').update(slot).digest('hex') })
      return { gameId: data.gameId, slot }
    }
    const stop = async () => {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }
    try {
      expect(createHash('sha256').update(original).digest('hex'))
        .toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      await page.locator('#files').setInputFiles(files)
      await ready()
      await click(0, '*enter')
      await state('entry|CHAPTER 13|chapter.ks|*entry|1|13|1|0|0|none|1|1|0')
      await click(0, '*apply')
      await state('destination|DESTINATION 77|chapter.ks|*destination|1|77|1|1|0|memory|1|1|0')
      expect(await read('partialEvents.join(";")')).toBe('memory|chapter.ks|1|chapter.ks|*destination|1|1')
      expect(await read('partialFileState()')).toBe('*destination|1|1')
      await info.attach('partial-memory-destination', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await click(0, '*return')
      await state('returned|RETURN 77|first.ks|*returned|0|77|1|1|0|memory|1|0|0')
      const before = await backup('partial-bookmark-before-refresh.json')
      await stop(); await page.reload()
      await page.locator('#files').setInputFiles(files)
      await ready()
      expect(await read('partialFileState()')).toBe('*destination|1|1')
      const after = await backup('partial-bookmark-after-refresh.json')
      expect(after.gameId).toBe(before.gameId); expect(after.slot.equals(before.slot)).toBe(true)
      await click(1, '*load')
      await state('destination|DESTINATION 77|chapter.ks|*destination|1|77|0|1|0|file|1|1|0')
      expect(await read('partialEvents.join(";")')).toBe('file|chapter.ks|1|chapter.ks|*destination|1|1')
      await info.attach('partial-file-destination', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await click(0, '*return')
      await state('returned|RETURN 77|first.ks|*returned|0|77|0|1|0|file|1|1|0')
      await click(0, '*live')
      await state('branch|BRANCH 91|live.ks|*destination|1|91|0|2|0|live|1|1|0')
      await info.attach('partial-live-branch', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await click(0, '*return')
      await state('returned|RETURN 91|first.ks|*returned|0|91|0|2|0|live|1|0|0')
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('partial-bookmark-inputs', { body: JSON.stringify({ files: partialBookmarkFiles, source: partialBookmarkSource }, null, 2), contentType: 'application/json' }),
      () => info.attach('partial-bookmark-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'The original KAG Conductor reads a label-only bookmark from memory and disk, then returns to its caller. After refresh, a separate branch uses that saved label and reads the active parser inside bookmark getters. The resulting chapter must display BRANCH 91 and return to the original caller.' }, null, 2), contentType: 'application/json' }),
      async () => info.attach('partial-bookmark-logs', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Partial KAG bookmark or cleanup failed', { cause: failures[0] })
  })
