import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { customEntryDistribution, customEntryObserver, customEntryPaths, customEntryStory } from '../helpers/custom-entry-distribution.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) for (const container of ['zip', 'sfx'] as const)
  test(`${backend}/${binary ? 'bytecode' : 'source'}/${container}: a chosen ZIP entry launches the original game and retains its route when reopened from the library`, async ({ page }, info) => {
    test.setTimeout(150000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await customEntryDistribution(binary, container), title = `Custom entry ${backend} ${binary ? 'compiled' : 'source'} ${container}`,
      item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) }),
      canvas = page.locator('#stage canvas[data-window-id]')
    const read = async (expression: string): Promise<string> => {
      const marker = `custom-entry-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Custom entry observer is disabled')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(marker)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + marker) }).last()
      await expect(line).toBeVisible({ timeout: 5000 })
      const value = ((await line.textContent()) ?? '').slice(marker.length)
      if (observations.length < 128) observations.push({ expression, value })
      return value
    }
    const ready = async () => {
      await expect(page.getByText('custom-entry-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const fullscreen = page.locator('.leave-fullscreen')
      if (await fullscreen.isVisible()) await fullscreen.click()
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator('#project-status')).toContainText('Release/data/')
      await expect(page.locator('#entry')).toHaveValue('boot.tjs')
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
      expect(await read('customPaths()')).toBe(customEntryPaths)
    }
    const state = async (progress: number, visits: number, choice = false) => {
      await expect.poll(() => read('customState()'), { timeout: 15000 }).toBe(choice
        ? `0|CUSTOM ENTRY|${visits}|*choice|2|0`
        : `${progress}|CHAPTER ${progress}|${visits}|*checkpoint|3|0`)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    }
    const click = async (index: number, target: string) => {
      const parts = (await read(`(function(){var m=kag.current,l=m.links[${index}];
        var x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1);
        if(!l.fixed[0]){x+=m.lineLayerOriginX+m.getLineLayerLeftOffset();y+=m.lineLayerOriginY+m.getLineLayerTopOffset();}
        for(var p=m;p!==null;p=p.parent){x+=p.left;y+=p.top;}
        return [x,y,l.w[0],l.h[0],l.target,int(m.selProcessLock)].join("|");})()`)).split('|')
      expect(parts).toHaveLength(6); expect(parts[4]).toBe(target); expect(parts[5]).toBe('0')
      const [x, y, width, height] = parts.slice(0, 4).map(Number)
      expect(width).toBeGreaterThan(0); expect(height).toBeGreaterThan(0)
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(640)
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(480)
      await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      observations.push({ click: target, point: [x, y], box })
      await canvas.click({ position: { x: x! * box!.width / 640, y: y! * box!.height / 480 }, timeout: 5000 })
    }
    const backup = async (name: string) => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), data = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] },
        entry = data.files.find((file) => file.path === 'Release/savedata/custom0.kdt')
      await info.attach(name, { body: bytes, contentType: 'application/json' })
      expect(entry).toBeDefined()
      expect(data.files.every((file) => !file.path.includes('Tools/') && !file.path.includes('>'))).toBe(true)
      const slot = Buffer.from(entry!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('customProgress'); expect(slot.toString('utf16le')).toContain('*checkpoint')
      if (binary) {
        const compiled = data.files.find((file) => file.path === 'Release/savedata/custom-observer.cjs')
        expect(compiled).toBeDefined(); expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      observations.push({ backup: name, gameId: data.gameId, slotSha256: createHash('sha256').update(slot).digest('hex') })
      return { gameId: data.gameId, slot }
    }
    const stop = async () => {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }
    try {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#entry').fill('boot.tjs')
      await page.locator('#files').setInputFiles({ name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.bytes })
      await ready(); await state(0, 1, true)
      await click(0, '*selected'); await state(7, 2)
      await click(0, '*save'); await state(7, 3)
      expect(await read('customStored()')).toBe('7|*checkpoint')
      const before = await backup('custom-entry-before-library.json')
      await info.attach('custom-entry-saved-route', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await click(1, '*change'); await state(99, 4)
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await stop(); await page.reload()
      // A saved library entry keeps both its project root and startup script,
      // independently of the next import's unrelated player settings.
      await page.locator('#entry').fill('startup.tjs')
      await page.locator('#project-mode').selectOption('root')
      await page.locator('#project-root').fill('Release/Tools/')
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await ready(); await state(0, 1, true)
      const after = await backup('custom-entry-after-library.json')
      expect(after.gameId).toBe(before.gameId); expect(after.slot.equals(before.slot)).toBe(true)
      expect(await read('customStored()')).toBe('7|*checkpoint')
      await click(1, '*load'); await state(7, 2)
      await info.attach('custom-entry-restored-route', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('custom-entry-observations', { body: JSON.stringify({ input: fixture.evidence, observations, errors,
        scope: 'Player-selected ZIP startup, including inert MZ-prefixed EXE archive input, unmodified original KAG system, real route/save/load links, frozen library project/entry and unchanged native bookmark bytes after a full refresh. The host never executes the input stub.' }, null, 2), contentType: 'application/json' }),
      () => info.attach('custom-entry-input', { body: fixture.bytes, contentType: fixture.mimeType }),
      () => info.attach('custom-entry-source', { body: customEntryStory + '\n' + customEntryObserver, contentType: 'text/plain' }),
      async () => info.attach('custom-entry-logs', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Custom ZIP entry or library cleanup failed', { cause: failures[0] })
  })
