import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { legacyGameDistribution, legacyGamePaths, legacyGameFirst, legacyGameChapter, legacyGameObserver } from '../helpers/legacy-zip-game.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode observer' : 'source observer'}: a Japanese ZIP game reopens its chapter and KAG slot with the library's filename encoding`, async ({ page }, info) => {
    test.setTimeout(150000)
    const errors: string[] = [], failures: unknown[] = [], observations: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await legacyGameDistribution(binary), title = `Japanese ZIP ${backend} ${binary ? 'compiled' : 'source'}`,
      item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) }),
      canvas = page.locator('#stage canvas[data-window-id]')
    const read = async (expression: string) => {
      const prefix = `legacy-library-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Legacy ZIP observer is unavailable')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const output = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(output).toBeVisible({ timeout: 5000 })
      const value = ((await output.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 160) observations.push({ expression, value })
      return value
    }
    const ready = async () => {
      await expect(page.getByText('legacy-zip-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator('#project-status')).toContainText('ソ/data.xp3>')
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
      expect(await read('legacyPaths()')).toBe(legacyGamePaths)
    }
    const state = async (progress: number, visits: number, choice = false) => {
      await expect.poll(() => read('legacyState()'), { timeout: 15000 }).toBe(choice
        ? `0|ARCHIVE READY|${visits}|*choice|2|0`
        : `${progress}|CHAPTER 表 ${progress}|${visits}|*checkpoint|3|0`)
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
      const slot = value.files.find((file) => file.path === 'ソ/savedata/legacy0.kdt')
      expect(slot).toBeDefined(); expect(value.files.some((file) => file.path.includes('>') || file.path.includes('\\'))).toBe(false)
      const slotBytes = Buffer.from(slot!.base64, 'base64'), text = slotBytes.toString('utf16le')
      expect(slotBytes.length).toBeGreaterThan(100)
      expect(text).toContain('legacyProgress'); expect(text).toContain('*checkpoint'); expect(text).toContain('表.ks')
      if (binary) {
        const compiled = value.files.find((file) => file.path === 'ソ/savedata/legacy-observer.cjs')
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
      await page.locator('#zip-encoding').selectOption('shift_jis')
      await page.locator('#files').setInputFiles({ name: 'japanese-edition.zip', mimeType: 'application/zip', buffer: fixture.bytes })
      await ready(); await state(0, 1, true)
      await clickLink(0, '*selected'); await state(7, 2)
      await clickLink(0, '*save'); await state(7, 3)
      expect(await read('legacyStoredState()')).toBe('7|*checkpoint')
      const before = await backup('japanese-slot-before-library.json')
      await info.attach('japanese-saved-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await clickLink(1, '*change'); await state(99, 4)
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      // This setting belongs to a future import. The stored game's raw ZIP
      // names must keep the exact Shift-JIS decoding selected at registration.
      await page.locator('#zip-encoding').selectOption('gbk')
      await stop(); await page.reload()
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#zip-encoding').selectOption('gbk')
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await ready(); await state(0, 1, true)
      expect(await read('legacyStoredState()')).toBe('7|*checkpoint')
      const after = await backup('japanese-slot-after-library.json')
      expect(after.gameId).toBe(before.gameId); expect(after.slotBytes.equals(before.slotBytes)).toBe(true)
      await clickLink(1, '*load'); await state(7, 2)
      await info.attach('japanese-restored-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      expect(await read('legacyPaths()')).toBe(legacyGamePaths)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    const reports = [
      () => info.attach('legacy-zip-library-observations', { body: JSON.stringify({ backend, binary,
        input: fixture.evidence, observations, errors,
        scope: 'Original KAG loads an outer Japanese text file and an inner Japanese chapter ZIP using raw unflagged CP932 names, clicks save/change/load, and restores the same slot bytes after library restart while the next import is set to GBK. Only the authored observer is compiled.' }, null, 2), contentType: 'application/json' }),
      () => info.attach('legacy-zip-game-input', { body: fixture.bytes, contentType: 'application/zip' }),
      () => info.attach('legacy-zip-game-authored-source', { body: legacyGameFirst + '\n' + legacyGameChapter + '\n' + legacyGameObserver, contentType: 'text/plain' }),
      async () => info.attach('legacy-zip-game-logs', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]
    for (const report of reports) try { await report() } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Japanese ZIP game library route or cleanup failed', { cause: failures[0] })
  })
