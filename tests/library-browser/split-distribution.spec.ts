import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { splitDistributionGame } from '../helpers/split-distribution-game.ts'
import { combinedLauncherPaths, combinedLauncherStory, combinedLauncherObserver } from '../helpers/combined-launcher.ts'
import { httpServer, type HttpFixture } from '../helpers/http-server.ts'

for (const backend of ['asyncify', 'jspi']) for (const kind of ['numbered', 'pkzip'] as const)
  test(`${backend}/${kind === 'numbered' ? 'local .zip.001 source' : 'remote .z01 bytecode'}: all game volumes select the original KAG launcher and preserve a clicked route through library restart`, async ({ page }, info) => {
    test.setTimeout(150000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [], afterCloseRequests: string[] = []
    let sequence = 0, server: Awaited<ReturnType<typeof httpServer>> | undefined, serverClosed = false
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await splitDistributionGame(kind), title = `Split KAG ${backend} ${kind}`,
      item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) }),
      canvas = page.locator('#stage canvas[data-window-id]'),
      manifest = Buffer.from(JSON.stringify({ version: 1, files: fixture.volumes.map((volume) => volume.name).reverse() }))
    page.on('request', (request) => {
      if (serverClosed && server && request.url().startsWith(server.url + '/')) afterCloseRequests.push(request.url())
    })
    const read = async (expression: string) => {
      const prefix = `split-game-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Split game observer is unavailable')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(line).toBeVisible({ timeout: 5000 })
      const value = ((await line.textContent()) ?? '').slice(prefix.length)
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
    const state = async (progress: number, visits: number, opening = false) => {
      await expect.poll(() => read('combinedState()'), { timeout: 15000 }).toBe(opening
        ? `0|LAUNCHER READY|${visits}|*choice|2|0`
        : `${progress}|PATCH ROUTE ${progress}|${visits}|*checkpoint|3|0`)
      await expect(page.locator('#logs .error')).toHaveCount(0)
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
      observations.push({ target, x, y, box })
      await canvas.click({ position: { x: x! * box!.width / 640, y: y! * box!.height / 480 }, timeout: 5000 })
    }
    const backup = async (name: string) => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), value = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] },
        record = value.files.find((file) => file.path === 'Release/Profiles/combined0.kdt')
      expect(record).toBeDefined()
      expect(value.files.some((file) => file.path.includes('>') || file.path.includes('WrongProfiles/'))).toBe(false)
      const slot = Buffer.from(record!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('combinedProgress'); expect(slot.toString('utf16le')).toContain('*checkpoint')
      if (fixture.binary) {
        const compiled = value.files.find((file) => file.path === 'Release/Profiles/combined-observer.cjs')
        expect(compiled).toBeDefined(); expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      observations.push({ backup: name, gameId: value.gameId, slotSha256: createHash('sha256').update(slot).digest('hex') })
      await info.attach(name, { body: bytes, contentType: 'application/json' })
      return { gameId: value.gameId, slot }
    }
    const stop = async () => {
      if (await page.locator('#cancel-library').isVisible()) {
        await page.locator('#cancel-library').click(); await expect(page.locator('#cancel-library')).toBeHidden({ timeout: 5000 })
      }
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }
    const closeServer = async () => {
      if (server && !serverClosed) { serverClosed = true; await server.close() }
    }
    try {
      expect(fixture.evidence.cut.insideCompressedMember).toBe(true)
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#project-exe-directory').fill(''); await page.locator('#project-executable').fill('')
      if (kind === 'numbered') {
        expect(fixture.evidence.joinedSha256).toBe(fixture.evidence.zipSha256)
        await page.locator('#files').setInputFiles([...fixture.volumes].reverse().map((volume) => ({
          name: volume.name, mimeType: 'application/octet-stream', buffer: volume.bytes,
        })))
      } else {
        const files: Record<string, HttpFixture> = { '/manifest.json': { bytes: manifest, full: true } }
        for (const volume of fixture.volumes) files['/' + volume.name] = { bytes: volume.bytes, etag: '"' + volume.sha256 + '"' }
        server = await httpServer(files)
        await page.locator('#remote-kind').selectOption('manifest')
        await expect(page.locator('#project-mode')).toHaveValue('auto')
        await page.locator('#remote-url').fill(server.url + '/manifest.json'); await page.locator('#load-url').click()
      }
      await ready(); await state(0, 1, true)
      await clickLink(0, '*selected'); await state(7, 2)
      await clickLink(0, '*save'); await state(7, 3)
      expect(await read('combinedStoredState()')).toBe('7|*checkpoint')
      const saved = await backup('split-slot-before-library.json')
      await info.attach('split-selected-route', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await clickLink(1, '*change'); await state(99, 4)
      const copyAt = server?.requests.length ?? 0
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await expect(page.locator('.library-download')).toHaveCount(0)
      if (server) {
        expect(server.requests.filter((request) => request.path === '/manifest.json' && request.method === 'GET')).toHaveLength(1)
        for (const volume of fixture.volumes) {
          const ranges = server.requests.slice(copyAt).filter((request) => request.path === '/' + volume.name && request.method === 'GET')
            .map((request) => /^bytes=(\d+)-(\d+)$/.exec(request.range ?? ''))
          expect(ranges.length).toBeGreaterThan(0); expect(ranges.every(Boolean)).toBe(true)
          const ordered = ranges.map((range) => [Number(range![1]), Number(range![2])] as const).sort((a, b) => a[0] - b[0])
          let end = -1
          for (const [from, to] of ordered) { expect(from).toBeLessThanOrEqual(end + 1); end = Math.max(end, to) }
          expect(end).toBe(volume.bytes.length - 1)
        }
      }
      observations.push({ savedLibraryId: await item.getAttribute('data-library-id'), libraryDescription: await item.locator('p').first().innerText() })
      await stop(); await closeServer(); await page.reload()
      // An unrelated next import cannot replace the retained split package
      // or change its original selected executable and save directory.
      await page.locator('#project-mode').selectOption('root'); await page.locator('#project-root').fill('Release/Tools/')
      await page.locator('#project-exe-directory').fill('Release/'); await page.locator('#project-executable').fill('Setup.exe')
      await item.getByRole('button', { name: '启动', exact: true }).click(); await ready(); await state(0, 1, true)
      const restored = await backup('split-slot-after-library.json')
      expect(restored.gameId).toBe(saved.gameId); expect(restored.slot.equals(saved.slot)).toBe(true)
      await clickLink(1, '*load'); await state(7, 2)
      expect(await read('combinedStoredState()')).toBe('7|*checkpoint')
      expect(await read('combinedPaths()')).toBe(combinedLauncherPaths)
      await info.attach('split-restored-route', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      expect(afterCloseRequests).toEqual([]); expect(errors).toEqual([])
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    const reports = [
      () => info.attach('split-distribution-observations', { body: JSON.stringify({ backend, kind, input: fixture.evidence,
        observations, errors, afterCloseRequests, requests: server?.requests, stats: server?.stats(),
        scope: 'Numbered byte splits through local selection, and PKZIP disk-relative volumes through a remote manifest. Both run the original KAG launcher and authored route with real clicks, retain the slot and reopen from the disk library. These are complementary source/bytecode paths, not every format/transport Cartesian combination.' }, null, 2), contentType: 'application/json' }),
      () => info.attach('split-distribution-source', { body: combinedLauncherStory + '\n' + combinedLauncherObserver, contentType: 'text/plain' }),
      () => info.attach('split-distribution-manifest', { body: manifest, contentType: 'application/json' }),
      async () => info.attach('split-distribution-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
      ...fixture.volumes.map((volume) => () => info.attach(volume.name, { body: volume.bytes, contentType: 'application/octet-stream' })),
    ]
    for (const report of reports) try { await report() } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    try { await closeServer() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Split KAG distribution or cleanup failed', { cause: failures[0] })
  })
