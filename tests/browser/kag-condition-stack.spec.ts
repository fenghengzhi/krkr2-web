import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagConditionGameFiles, kagConditionGameSource } from '../helpers/kag-condition-stack.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: an original KAG chapter resumes the native conditional branch, saves it and returns to its caller`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
      canvas = page.locator('#stage canvas[data-window-id]')
    const read = async (expression: string): Promise<string> => {
      const prefix = `condition-game-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Conditional chapter observer is disabled')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(line).toBeVisible({ timeout: 5000 })
      const value = ((await line.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 128) observations.push({ expression, value })
      return value
    }
    const state = async (expected: string) => {
      await expect.poll(() => read('stackGameState()'), { timeout: 15000 }).toBe(expected)
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
        ...Object.entries(kagConditionGameFiles).map(([name, source]) => ({ name, mimeType: 'text/plain', buffer: wide(source) })),
        { name: 'condition-game.tjs', mimeType: 'text/plain', buffer: wide(kagConditionGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: wide(binary
          ? 'Scripts.compileStorage("condition-game.tjs",System.dataPath+"condition-game.cjs",false,true,false);Scripts.execStorage(System.dataPath+"condition-game.cjs");'
          : 'Scripts.execStorage("condition-game.tjs");') },
      ])
      await expect(page.getByText('condition-stack-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const fullscreen = page.locator('.leave-fullscreen')
      if (await fullscreen.isVisible()) await fullscreen.click()
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
      await state('menu|MENU|1|0|first.ks|*menu|0|0|0|1|1|0')
      await click(0, '*enter')
      await state('initial|FIRST PASS|2|0|branch.ks|*saved|1|0|0|1|1|0')
      expect(await read('stackGameFile()')).toBe('1|2|ffffffff00000001|00|1')
      await info.attach('condition-first-pass', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await click(0, '*resume')
      await state('restored|RESTORED 7|3|7|branch.ks|*result|1|1|0|1|4|0')
      expect(await read('stackRestoredHex')).toBe('fffffffffffffff0')
      await click(0, '*save')
      await state('restored|RESTORED 7|4|7|branch.ks|*result|1|1|0|1|4|0')
      expect(await read('stackGameStored()')).toBe('7|*result|1')
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), backup = JSON.parse(bytes.toString()) as { files: { path: string; base64: string }[] },
        branch = backup.files.find((entry) => entry.path === 'savedata/condition-route.tjs'),
        slot = backup.files.find((entry) => entry.path === 'savedata/condition0.kdt')
      expect(branch).toBeDefined(); expect(slot).toBeDefined()
      expect(Buffer.from(branch!.base64, 'base64').toString('utf16le')).toContain('ffffffff00000001')
      expect(Buffer.from(slot!.base64, 'base64').toString('utf16le')).toContain('*result')
      if (binary) {
        const compiled = backup.files.find((entry) => entry.path === 'savedata/condition-game.cjs')
        expect(compiled).toBeDefined(); expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      await info.attach('condition-bookmarks', { body: bytes, contentType: 'application/json' })
      observations.push({ routeSha256: createHash('sha256').update(Buffer.from(branch!.base64, 'base64')).digest('hex'),
        slotSha256: createHash('sha256').update(Buffer.from(slot!.base64, 'base64')).digest('hex') })
      await click(1, '*change')
      await state('changed|CHANGED 99|5|99|branch.ks|*change|1|1|0|1|1|0')
      await click(0, '*load')
      await state('restored|RESTORED 7|6|7|branch.ks|*result|1|1|0|1|4|0')
      expect(await read('stackGameFile()')).toBe('1|2|ffffffff00000001|00|1')
      await click(3, '*return')
      await state('returned|RETURN 7|7|7|first.ks|*returned|0|1|0|1|0|0')
      await info.attach('condition-returned-caller', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('condition-game-source', { body: JSON.stringify({ files: kagConditionGameFiles, source: kagConditionGameSource }, null, 2), contentType: 'application/json' }),
      () => info.attach('condition-game-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Unmodified original KAG, actual Conductor.store during a label callback and its real serialized file. Player links restore the native nested branch, save/load the chapter, and return to the retained caller.' }, null, 2), contentType: 'application/json' }),
      async () => info.attach('condition-game-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG conditional chapter or cleanup failed', { cause: failures[0] })
  })
