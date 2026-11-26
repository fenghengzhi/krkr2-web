import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagEntityFiles, kagEntityGameSource, kagEntityStory } from '../helpers/kag-entity-cursor.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: original KAG reads an adjacent route record during its menu expression and restores the chosen chapter`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
      canvas = page.locator('#stage canvas[data-window-id]')
    const read = async (expression: string): Promise<string> => {
      const prefix = `entity-game-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Nested route observer is disabled')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(line).toBeVisible({ timeout: 5000 })
      const value = ((await line.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 96) observations.push({ expression, value })
      return value
    }
    const state = async (progress: number, visits: number, choice = false) => {
      await expect.poll(() => read('entityGameState()'), { timeout: 15000 }).toBe(choice
        ? `0|CHOOSE|${visits}|*choice|1|0|Continue 7|7`
        : `${progress}|CHAPTER ${progress}|${visits}|*checkpoint|3|0|Continue 7|7`)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    }
    const click = async (index: number, target: string) => {
      const fields = (await read(`(function(){var m=kag.current,l=m.links[${index}],x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1);
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
    try {
      expect(createHash('sha256').update(original).digest('hex'))
        .toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      const wide = (source: string) => Buffer.from('\ufeff' + source, 'utf16le')
      await page.locator('#files').setInputFiles([
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'first.ks', mimeType: 'text/plain', buffer: wide(kagEntityStory) },
        { name: 'entity-menu.ks', mimeType: 'text/plain', buffer: wide(kagEntityFiles['entity-menu.ks']) },
        { name: 'entity-game.tjs', mimeType: 'text/plain', buffer: wide(kagEntityGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: wide(binary
          ? 'Scripts.compileStorage("entity-game.tjs","savedata/entity-game.cjs",false,true,false);Scripts.execStorage("savedata/entity-game.cjs");'
          : 'Scripts.execStorage("entity-game.tjs");') },
      ])
      await expect(page.getByText('entity-cursor-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const fullscreen = page.locator('.leave-fullscreen')
      if (await fullscreen.isVisible()) await fullscreen.click()
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
      await state(0, 1, true)
      expect(await read('entityReads+"|"+entityGameParser.curLine+"|"+entityGameParser.curPos')).toBe('1|2|0')
      await click(0, '*selected'); await state(7, 2)
      await click(0, '*save'); await state(7, 3)
      expect(await read('entityGameStored()')).toBe('7|*checkpoint')
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), backup = JSON.parse(bytes.toString()) as { files: { path: string; base64: string }[] },
        saved = backup.files.find((entry) => entry.path === 'savedata/entity0.kdt')
      expect(saved).toBeDefined()
      const slot = Buffer.from(saved!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('entityProgress'); expect(slot.toString('utf16le')).toContain('*checkpoint')
      if (binary) {
        const compiled = backup.files.find((entry) => entry.path === 'savedata/entity-game.cjs')
        expect(compiled).toBeDefined(); expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      await info.attach('entity-chapter-bookmark', { body: bytes, contentType: 'application/json' })
      observations.push({ slotSha256: createHash('sha256').update(slot).digest('hex') })
      await click(1, '*change'); await state(99, 4)
      await click(2, '*load'); await state(7, 5)
      expect(await read('entityGameStored()')).toBe('7|*checkpoint')
      await info.attach('entity-chapter-restored', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('entity-route-source', { body: kagEntityStory + '\n' + kagEntityFiles['entity-menu.ks'] + '\n' + kagEntityGameSource, contentType: 'text/plain' }),
      () => info.attach('entity-route-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Unmodified KAG template and a game-owned parser reading the adjacent route within an entity expression. Exact remaining attributes determine the real link and saved route; console only observes.' }, null, 2), contentType: 'application/json' }),
      async () => info.attach('entity-route-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Nested KAG route or cleanup failed', { cause: failures[0] })
  })
