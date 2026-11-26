import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagParameterGameMenu, kagParameterGameSource, kagParameterStory } from '../helpers/kag-parameter-properties.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: original KAG presents a property-generated route and restores its chapter after restart`, async ({ page }, info) => {
    test.setTimeout(150000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
      canvas = page.locator('#stage canvas[data-window-id]')
    const read = async (expression: string): Promise<string> => {
      const prefix = `parameter-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Parameter observer is disabled')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(line).toBeVisible({ timeout: 5000 })
      const value = ((await line.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 128) observations.push({ expression, value })
      return value
    }
    const ready = async () => {
      await expect(page.getByText('parameter-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const fullscreen = page.locator('.leave-fullscreen')
      if (await fullscreen.isVisible()) await fullscreen.click()
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
    }
    const state = async (progress: number, visits: number, choice = false) => {
      await expect.poll(() => read('parameterGameState()'), { timeout: 15000 }).toBe((choice
        ? `0|CHOOSE|${visits}|*choice|2|0|ROUTE 7|*selected`
        : `${progress}|CHAPTER ${progress}|${visits}|*checkpoint|3|0|ROUTE 7|*selected`) + '|caption:7,target,score:7')
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
      observations.push({ target, x, y, box })
      await canvas.click({ position: { x: x! * box!.width / 640, y: y! * box!.height / 480 }, timeout: 5000 })
    }
    const backup = async (name: string) => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), data = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] },
        file = data.files.find((entry) => entry.path === 'savedata/parameter0.kdt')
      expect(file).toBeDefined()
      const slot = Buffer.from(file!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('parameterProgress'); expect(slot.toString('utf16le')).toContain('*checkpoint')
      if (binary) {
        const compiled = data.files.find((entry) => entry.path === 'savedata/parameter-game.cjs')
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
        { name: 'first.ks', mimeType: 'text/plain', buffer: wide(kagParameterStory) },
        { name: 'parameter-game-menu.ks', mimeType: 'text/plain', buffer: wide(kagParameterGameMenu) },
        { name: 'parameter-game.tjs', mimeType: 'text/plain', buffer: wide(kagParameterGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: wide(binary
          ? 'Scripts.compileStorage("parameter-game.tjs","savedata/parameter-game.cjs",false,true,false);Scripts.execStorage("savedata/parameter-game.cjs");'
          : 'Scripts.execStorage("parameter-game.tjs");') },
      ])
      await ready(); await state(0, 1, true)
      await click(0, '*selected'); await state(7, 2)
      await click(0, '*save'); await state(7, 3)
      expect(await read('parameterGameStored()')).toBe('7|*checkpoint')
      const saved = await backup('parameter-saved.json')
      await click(1, '*change'); await state(99, 4)
      await click(2, '*load'); await state(7, 5)
      await info.attach('parameter-loaded', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await page.locator('#restart').click(); await ready(); await state(0, 1, true)
      const reopened = await backup('parameter-reopened.json')
      expect(reopened.gameId).toBe(saved.gameId); expect(reopened.slot.equals(saved.slot)).toBe(true)
      await click(1, '*load'); await state(7, 2)
      await info.attach('parameter-restarted-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('parameter-source', { body: kagParameterStory + '\n' + kagParameterGameMenu + '\n' + kagParameterGameSource, contentType: 'text/plain' }),
      () => info.attach('parameter-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Stock KAG template; authored macro property getters produce the actual visible link, route and score. Real save/change/load/restart use the native bookmark. Console expressions only observe.' }, null, 2), contentType: 'application/json' }),
      async () => info.attach('parameter-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Dynamic KAG macro choice or cleanup failed', { cause: failures[0] })
  })
