import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { combinedLauncherDistribution, combinedLauncherPaths, combinedLauncherStory, combinedLauncherObserver } from '../helpers/combined-launcher.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode observer' : 'source observer'}: a combined game beside installer and tools restores its clicked KAG route from the library`, async ({ page }, info) => {
    test.setTimeout(150000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await combinedLauncherDistribution(binary),
      title = `Combined KAG ${backend} ${binary ? 'compiled' : 'source'}`,
      item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) }),
      canvas = page.locator('#stage canvas[data-window-id]')
    const read = async (expression: string): Promise<string> => {
      const prefix = `combined-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Combined game observer is unavailable')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const output = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(output).toBeVisible({ timeout: 5000 })
      const value = ((await output.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 160) observations.push({ expression, value })
      return value
    }
    const ready = async () => {
      await expect(page.getByText('combined-launcher-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator('#project-status')).toContainText('Release/Game.exe>')
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
      expect(await read('combinedPaths()')).toBe(combinedLauncherPaths)
    }
    const state = async (progress: number, visits: number, choice = false) => {
      await expect.poll(() => read('combinedState()'), { timeout: 15000 }).toBe(choice
        ? `0|LAUNCHER READY|${visits}|*choice|2|0`
        : `${progress}|PATCH ROUTE ${progress}|${visits}|*checkpoint|3|0`)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    }
    const clickLink = async (index: number, target: string) => {
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
    const backup = async (label: string) => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), value = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] }
      await info.attach(label, { body: bytes, contentType: 'application/json' })
      const slot = value.files.find((file) => file.path === 'Release/Profiles/combined0.kdt')
      expect(slot).toBeDefined(); expect(value.files.some((file) => file.path.includes('>') || file.path.includes('WrongProfiles/'))).toBe(false)
      const slotBytes = Buffer.from(slot!.base64, 'base64')
      expect(slotBytes.length).toBeGreaterThan(100)
      expect(slotBytes.toString('utf16le')).toContain('combinedProgress')
      expect(slotBytes.toString('utf16le')).toContain('*checkpoint')
      if (binary) {
        const compiled = value.files.find((file) => file.path === 'Release/Profiles/combined-observer.cjs')
        expect(compiled).toBeDefined(); expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      observations.push({ backup: label, gameId: value.gameId, slotBytes: slotBytes.length,
        slotSha256: createHash('sha256').update(slotBytes).digest('hex') })
      return { gameId: value.gameId, slotBytes }
    }
    const stop = async () => {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }
    try {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#project-exe-directory').fill(''); await page.locator('#project-executable').fill('')
      await page.locator('#files').setInputFiles({ name: 'combined-edition.zip', mimeType: 'application/zip', buffer: fixture.bytes })
      await ready(); await state(0, 1, true)
      await clickLink(0, '*selected'); await state(7, 2)
      await clickLink(0, '*save'); await state(7, 3)
      expect(await read('combinedStoredState()')).toBe('7|*checkpoint')
      const saved = await backup('combined-slot-before-library.json')
      await info.attach('combined-saved-route', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await clickLink(1, '*change'); await state(99, 4)
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await stop(); await page.reload()
      // Library reopen must use its recorded package and launcher, rather
      // than the unrelated selection intended for the next import.
      await page.locator('#project-mode').selectOption('root')
      await page.locator('#project-root').fill('Release/Tools/')
      await page.locator('#project-exe-directory').fill('Release/')
      await page.locator('#project-executable').fill('Setup.exe')
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await ready(); await state(0, 1, true)
      expect(await read('combinedStoredState()')).toBe('7|*checkpoint')
      const restored = await backup('combined-slot-after-library.json')
      expect(restored.gameId).toBe(saved.gameId); expect(restored.slotBytes.equals(saved.slotBytes)).toBe(true)
      await clickLink(1, '*load'); await state(7, 2)
      await info.attach('combined-restored-route', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      expect(await read('combinedPaths()')).toBe(combinedLauncherPaths)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    const reports = [
      () => info.attach('combined-launcher-observations', { body: JSON.stringify({ backend, binary,
        input: fixture.evidence, observations, errors,
        scope: 'Automatic multi-EXE ZIP selection, original KAG route/save/load link clicks, exact launcher/configuration/storage paths, unchanged bookmark bytes and persistent-library reopen. Only the authored observer is compiled; no native EXE executes.' }, null, 2), contentType: 'application/json' }),
      () => info.attach('combined-launcher-input', { body: fixture.bytes, contentType: 'application/zip' }),
      () => info.attach('combined-launcher-authored-source', { body: combinedLauncherStory + '\n' + combinedLauncherObserver, contentType: 'text/plain' }),
      async () => info.attach('combined-launcher-logs', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]
    for (const report of reports) try { await report() } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Combined KAG library route or cleanup failed', { cause: failures[0] })
  })
