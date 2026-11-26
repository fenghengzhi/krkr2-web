import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { test, expect, libraryDirectories } from '../helpers/library-browser.ts'
import { remoteResumeGame, resumeBlockBytes } from '../helpers/remote-resume-game.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode cancellation and changed version' : 'source connection loss'}: remote KAG downloads resume after refresh and retain the actual scene and bookmark offline`, async ({ page }, info) => {
    test.setTimeout(180000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await remoteResumeGame(binary), failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [],
      title = `Resumable KAG ${backend} ${binary ? 'compiled' : 'source'}`,
      draft = page.locator('.library-download'), game = page.locator('.library-game'), canvas = page.locator('#stage canvas[data-window-id]'),
      afterCloseRequests: string[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (fixture.closed && request.url().startsWith(fixture.server.url + '/')) afterCloseRequests.push(request.url())
    })
    const read = async (expression: string) => {
      const prefix = `resume-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Download game observer is unavailable')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(line).toBeVisible({ timeout: 5000 })
      const value = ((await line.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 160) observations.push({ expression, value })
      return value
    }
    const state = async (value: number, visits: number, opening = false) => {
      await expect.poll(() => read('resumeState()'), { timeout: 15000 }).toBe(opening
        ? `0|RESUME READY|${visits}|*choice|2|0`
        : `${value}|SCENE ${value}|${visits}|*checkpoint|3|0`)
    }
    const ready = async () => {
      await expect(page.getByText('resume-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen')
      if (await leave.isVisible()) await leave.click()
      await expect(canvas).toHaveCount(1); await expect(canvas).toHaveAttribute('width', '640')
      await state(0, 1, true)
    }
    const load = async () => {
      await page.locator('#remote-kind').selectOption('manifest')
      await page.locator('#remote-url').fill(fixture.server.url + '/manifest.json')
      await page.locator('#load-url').click(); await ready()
    }
    const clickLink = async (index: number, target: string) => {
      const fields = (await read(`(function(){var m=kag.current,l=m.links[${index}],x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1);
        if(!l.fixed[0]){x+=m.lineLayerOriginX+m.getLineLayerLeftOffset();y+=m.lineLayerOriginY+m.getLineLayerTopOffset();}
        for(var p=m;p!==null;p=p.parent){x+=p.left;y+=p.top;}return [x,y,l.w[0],l.h[0],l.target,int(m.selProcessLock)].join("|");})()`)).split('|')
      expect(fields).toHaveLength(6); expect(fields[4]).toBe(target); expect(fields[5]).toBe('0')
      const [x, y, width, height] = fields.slice(0, 4).map(Number)
      expect(width).toBeGreaterThan(0); expect(height).toBeGreaterThan(0)
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(640)
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(480)
      await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await canvas.click({ position: { x: x! * box!.width / 640, y: y! * box!.height / 480 }, timeout: 5000 })
    }
    const storage = async (id?: string) => page.evaluate(async (id) => {
      const counts = await new Promise<Record<string, number>>((resolve, reject) => {
        const request = indexedDB.open('krkr2-library')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result, stores = ['catalog', 'downloads', 'downloadRequests', 'downloadBlocks'], tx = db.transaction(stores),
            requests = stores.map((name) => tx.objectStore(name).count())
          tx.onabort = () => { db.close(); reject(tx.error) }
          tx.oncomplete = () => { resolve(Object.fromEntries(stores.map((name, i) => [name, requests[i]!.result]))); db.close() }
        }
      })
      let firstBlockSha256: string | undefined
      if (id) {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('krkr2-library-v1'),
          file = await (await (await root.getDirectoryHandle(id)).getFileHandle('1')).getFile(),
          block = await file.slice(0, 1048576).arrayBuffer()
        if (block.byteLength !== 1048576) throw new Error('Confirmed first block is incomplete')
        firstBlockSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', block))].map((v) => v.toString(16).padStart(2, '0')).join('')
      }
      return { counts, firstBlockSha256 }
    }, id)
    const interrupt = async (cancel: boolean) => {
      fixture.arm()
      const heldBefore = fixture.held.requests
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect.poll(() => fixture.held.requests).toBe(heldBefore + 1)
      expect(await libraryDirectories(page)).toHaveLength(1)
      await expect(page.locator('#cancel-library')).toHaveText('停止下载')
      if (cancel) await page.locator('#cancel-library').click()
      else fixture.disconnect()
      await expect(page.locator('#cancel-library')).toBeHidden({ timeout: 5000 })
      await expect(draft).toHaveCount(1); await expect(game).toHaveCount(0)
      if (cancel) await expect(page.locator('#library-operation')).toHaveText('下载已停止，可从未完成下载继续或移除。')
      await expect.poll(() => fixture.server.stats().aborted).toBeGreaterThan(0)
      const id = await draft.getAttribute('data-library-download-id'); expect(id).not.toBeNull()
      const partial = await storage(id!)
      expect(partial.firstBlockSha256).toBe(fixture.firstBlockSha256)
      expect(partial.counts.downloads).toBe(1); expect(partial.counts.downloadRequests).toBe(1)
      expect(partial.counts.downloadBlocks).toBeGreaterThanOrEqual(2)
      expect(partial.counts.catalog).toBe(0)
      observations.push({ interruptedBy: cancel ? 'cancel' : 'connection-loss', id, partial,
        operation: await page.locator('#library-operation').innerText(), transport: fixture.snapshot() })
      fixture.restore(); fixture.manifestAvailable(false)
      await page.reload()
      await expect(draft).toHaveCount(1); await expect(draft.locator('h3')).toHaveText(title)
      // Explicitly discard any browser form restoration. Continue uses only
      // the saved row, with no URL entered again after reload.
      await page.locator('#remote-url').fill('')
      await expect(page.locator('#remote-url')).toHaveValue('')
      await expect(draft.getByRole('button', { name: '继续下载', exact: true })).toBeEnabled()
      expect(await draft.getAttribute('data-library-download-id')).toBe(id)
      expect(await storage(id!)).toEqual(partial)
      return { id: id!, partial }
    }
    const backup = async (name: string) => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), data = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] },
        record = data.files.find((file) => file.path === 'savedata/resume0.kdt')
      expect(record).toBeDefined()
      const slot = Buffer.from(record!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('resumeValue'); expect(slot.toString('utf16le')).toContain('*checkpoint')
      if (binary) expect(data.files.some((file) => file.path === 'savedata/resume-game.cjs' &&
        Buffer.from(file.base64, 'base64').toString('ascii', 0, 4) === 'TJS2')).toBe(true)
      await info.attach(name, { body: bytes, contentType: 'application/json' })
      return { gameId: data.gameId, sha256: createHash('sha256').update(slot).digest('hex') }
    }
    try {
      await load()
      let saved = await interrupt(binary)
      if (binary) {
        fixture.version(2)
        const changedAt = fixture.server.requests.length
        await draft.getByRole('button', { name: '继续下载', exact: true }).click()
        await expect(page.locator('#library-operation')).toContainText('Game sources changed')
        await expect(page.locator('#cancel-library')).toBeHidden()
        await expect(game).toHaveCount(0); await expect(draft).toHaveCount(1)
        expect(await storage(saved.id)).toEqual(saved.partial)
        const changedGets = fixture.server.requests.slice(changedAt).filter((request) => request.method === 'GET')
        expect(changedGets.length).toBeGreaterThan(0)
        expect(changedGets.every((request) => request.range === 'bytes=0-0')).toBe(true)
        observations.push({ changedVersionRejected: true, requests: changedGets })
        await draft.getByRole('button', { name: '移除下载', exact: true }).click()
        await expect(draft).toHaveCount(0)
        expect(await libraryDirectories(page)).toEqual([])
        expect((await storage()).counts).toEqual({ catalog: 0, downloads: 0, downloadRequests: 0, downloadBlocks: 0 })
        fixture.version(1); fixture.manifestAvailable(true)
        await load(); saved = await interrupt(true)
      }
      const resumeAt = fixture.server.requests.length
      await draft.getByRole('button', { name: '继续下载', exact: true }).click()
      await expect(game).toHaveCount(1); await expect(game.locator('h3')).toHaveText(title)
      await expect(draft).toHaveCount(0); await expect(page.locator('#cancel-library')).toBeHidden()
      await expect(page.locator('#library-operation')).toContainText('已复用')
      expect(await game.getAttribute('data-library-id')).toBe(saved.id)
      const resumedGets = fixture.server.requests.slice(resumeAt).filter((request) => request.method === 'GET'),
        patchGets = resumedGets.filter((request) => request.path === '/patch.xp3')
      expect(patchGets.some((request) => request.range === 'bytes=1048576-2097151')).toBe(true)
      for (const request of patchGets) {
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.range ?? '')
        expect(range).not.toBeNull()
        if (Number(range![1]) < resumeBlockBytes) expect(request.range).toBe('bytes=0-0')
        else expect(request.match).toBe('"' + fixture.evidence[1]!.sha256 + '"')
      }
      expect(resumedGets.some((request) => request.path === '/manifest.json')).toBe(false)
      expect((await storage()).counts).toEqual({ catalog: 1, downloads: 0, downloadRequests: 0, downloadBlocks: 0 })
      observations.push({ resumedGets, operation: await page.locator('#library-operation').innerText(), id: saved.id })
      await fixture.close(); await page.reload()
      await game.getByRole('button', { name: '启动', exact: true }).click(); await ready()
      await clickLink(0, '*scene'); await state(7, 2)
      expect(await read('resumePixels()')).toBe('3368601|255')
      const picture = await canvas.screenshot({ timeout: 5000 }), decoded = readScreenshotPng(picture),
        offset = (Math.floor(3 * decoded.height / 480) * decoded.width + Math.floor(3 * decoded.width / 640)) * 4
      expect([...decoded.rgba.subarray(offset, offset + 4)]).toEqual([51, 102, 153, 255])
      await info.attach('resumed-game-scene', { body: picture, contentType: 'image/png' })
      await clickLink(0, '*save'); await state(7, 3)
      expect(await read('resumeStored()')).toBe('7|*checkpoint')
      const before = await backup('resumed-bookmark-before.json')
      await clickLink(1, '*change'); await state(99, 4)
      await page.reload(); await game.getByRole('button', { name: '启动', exact: true }).click(); await ready()
      expect(await backup('resumed-bookmark-after.json')).toEqual(before)
      await clickLink(1, '*load'); await state(7, 2)
      expect(await read('resumePixels()')).toBe('3368601|255')
      expect(afterCloseRequests).toEqual([]); expect(errors).toEqual([])
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('remote-resume-observations', { body: JSON.stringify({ backend, binary, inputs: fixture.evidence,
        firstBlockSha256: fixture.firstBlockSha256, observations, errors, afterCloseRequests, transport: fixture.snapshot() }, null, 2), contentType: 'application/json' }),
      () => info.attach('remote-resume-authored-source', { body: fixture.source, contentType: 'text/plain' }),
      async () => info.attach('remote-resume-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#cancel-library').isVisible()) {
        await page.locator('#cancel-library').click(); await expect(page.locator('#cancel-library')).toBeHidden({ timeout: 5000 })
      }
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    try { await fixture.close() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Remote download continuation or cleanup failed', { cause: failures[0] })
  })
