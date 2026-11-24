import { magnifyPixelWindow } from '../helpers/pixel-window.ts'
import { test, expect, type Page } from '@playwright/test'
import { zipFixture, centralRecords } from '../helpers/zip-fixtures.ts'
import { attachStartup, observeStartup } from '../helpers/startup-observation.ts'
import { observeWorkerRpc } from '../helpers/worker-rpc-observation.ts'
import { httpServer } from '../helpers/http-server.ts'
import { remoteArchive } from '../helpers/remote-archive.ts'

async function expression(page: Page, source: string, value: string) {
  await expect(page.locator('#evaluate')).toBeEnabled()
  await page.locator('#expression').fill(source)
  await page.locator('#evaluate').click()
  await expect(page.locator('#logs p').last().locator('span')).toHaveText(value)
}
for (const backend of ['asyncify', 'jspi']) {
  for (const [kind, fixture] of [
    ['stored', '0-stream0-local640-zip640.zip'],
    ['deflate', '8-stream0-local640-zip640.zip'],
    ['zip64-stream', '8-stream1-local641-zip640.zip'],
  ]) {
    test(`${backend}: ${kind} ZIP runs Unicode scripts and images, rejects writes and restores saves`, async ({
      page,
    }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`/?backend=${backend}`)
      test.skip(
        backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
        'JSPI unavailable',
      )
      const file = {
        name: 'game.data',
        mimeType: 'application/octet-stream',
        buffer: zipFixture(fixture),
      }
      await page.locator('#files').setInputFiles(file)
      await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
      await expect(page.locator('canvas')).toHaveJSProperty('width', 2)
      await expect(page.locator('canvas')).toHaveJSProperty('height', 1)
      await magnifyPixelWindow(page.locator('canvas'))
      const screenshot = await page.locator('canvas').screenshot()
      const pixel = await page.evaluate(
        async (url) => {
          const image = await createImageBitmap(await (await fetch(url)).blob()),
            canvas = new OffscreenCanvas(image.width, image.height),
            context = canvas.getContext('2d')!
          context.drawImage(image, 0, 0)
          const result = [...context.getImageData(image.width / 2, image.height / 2, 1, 1).data]
          image.close()
          return result
        },
        'data:image/png;base64,' + screenshot.toString('base64'),
      )
      expect(pixel).toEqual([51, 102, 153, 255])
      await expression(page, 'Scripts.evalStorage("game.data>シーン/value.tjs")', '42')
      await expression(
        page,
        '(function(){var failures=0,d=%[];try{saved.save("game.data>empty.bin");}catch(e){failures++;}try{(Dictionary.saveStruct incontextof d)("game.data>empty.bin","b");}catch(e){failures++;}return failures;})()',
        '2',
      )
      await expression(
        page,
        '(function(){Storages.addAutoPath("game.data>folder/");return Storages.getPlacedPath("CAFÉ.TXT");})()',
        'game://./game.data>folder/café.txt',
      )
      await expect(page.locator('#save-status')).toContainText('1 个存档文件，已保存')
      await page.reload()
      await page.locator('#files').setInputFiles(file)
      await expect(page.locator('#logs')).toContainText('zip-ready:42:1')
      await page.locator('#stop').click()
      expect(errors).toEqual([])
    })
  }
  test(`${backend}: corrupt ZIP payload errors are visible and a clean reimport recovers`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    const bytes = zipFixture('0-stream0-local640-zip640.zip'),
      record = centralRecords(bytes).records.find((r) => r.name === 'startup.tjs')!
    bytes[record.data] ^= 1
    await page
      .locator('#files')
      .setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: bytes })
    await expect(page.locator('#logs')).toContainText('ZIP CRC32 mismatch: startup.tjs')
    await expect(page.locator('#choose-files')).toBeEnabled()
    await page
      .locator('#files')
      .setInputFiles({ name: 'clean.zip', mimeType: 'application/zip', buffer: zipFixture() })
    await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
    await page.locator('#stop').click()
  })
  test(`${backend}: stopping ZIP index-tail IO retires pending startup before any member executes`, async ({
    page,
  }, info) => {
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeStartup(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    const bytes = remoteArchive('zip'), { central, end } = centralRecords(bytes),
      held: { from: number; to: number; aborted: boolean; released: boolean; closedBeforeRelease: boolean }[] = []
    let armed = true, release: (() => void) | undefined
    const server = await httpServer({ '/index.zip': { bytes, etag: '"zip-index-stop-v1"',
      intercept(request, response) {
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
        if (!armed || request.method !== 'GET' || !range || request.headers['if-match'] !== '"zip-index-stop-v1"') return false
        const from = Number(range[1]), to = Math.min(bytes.length - 1, Number(range[2]))
        // The valid ZIP's directory and EOCD are beyond8MiB of payload. Hold
        // the actual index-tail read, after discovery and the initial prefix.
        if (from > central || to < end + 21) return false
        const record = { from, to, aborted: false, released: false, closedBeforeRelease: false }
        held.push(record)
        response.on('close', () => { record.aborted = !response.writableFinished })
        release = () => {
          record.released = true
          record.closedBeforeRelease = response.destroyed
          if (!response.destroyed && !response.writableEnded) {
            response.writeHead(206, { ETag: '"zip-index-stop-v1"',
              'Content-Range': `bytes ${from}-${to}/${bytes.length}`, 'Content-Length': to - from + 1 })
            response.end(bytes.subarray(from, to + 1))
          }
        }
        return true
      },
    } })
    try {
      await page.locator('#remote-url').fill(server.url + '/index.zip')
      await page.locator('#load-url').click()
      await expect.poll(() => held.length).toBe(1)
      const pending = (await observeWorkerRpc(page)).workers
      expect(pending).toHaveLength(1)
      expect(pending[0]!.pending.some((call) => call.method === 'start')).toBe(true)
      expect(pending[0]!.terminated).toBe(0)
      await expect(page.locator('#logs')).not.toContainText('zip-ready')
      // resources==1 is the mounted outer ZIP, not a published lazy index.
      await expect(page.locator('#runtime-info')).toContainText('· 1 个资源 ·')
      const aborted = server.stats().aborted
      await page.locator('#stop').click()
      await expect(page.locator('#stop')).toBeDisabled({ timeout: 1800 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => held[0]!.aborted).toBe(true)
      await expect.poll(() => server.stats().aborted).toBeGreaterThan(aborted)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      const retired = (await observeWorkerRpc(page)).workers
      expect(retired).toHaveLength(1)
      expect(retired[0]!.terminated).toBe(1)
      expect(retired[0]!.pending).toEqual([])
      expect(retired[0]!.calls).toBe(retired[0]!.replies)
      expect(retired[0]!.duplicateReplies).toBe(0)
      expect(retired[0]!.droppedPending).toBe(0)
      expect(retired[0]!.errors.some((error) => error.method === 'start')).toBe(true)
      expect(release).toBeDefined()
      release!()
      expect(held[0]!.released).toBe(true)
      expect(held[0]!.closedBeforeRelease).toBe(true)
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('#stage canvas')).toHaveCount(0)
      await expect(page.locator('#logs')).not.toContainText('zip-ready')
      expect((await observeWorkerRpc(page)).workers).toEqual(retired)
      await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      await expect(page.locator('#logs')).not.toContainText('Resource not found: startup.tjs')
      await expect(page.locator('#logs')).not.toContainText('ストレージ startup.tjs が見つかりません')
      await attachStartup(page, info, 'zip-index-retired-before-reimport', errors)
      // The identical valid ZIP must actually execute when its tail is served.
      armed = false
      await page.locator('#load-url').click()
      await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
      await expect(page.locator('#evaluate')).toBeEnabled()
      await expression(page, 'asset.getMainPixel(0,0)', String(0x336699))
      expect(held).toHaveLength(1)
      await page.locator('#stop').click()
      await expect(page.locator('#stop')).toBeDisabled()
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('zip-index-tail-io', { contentType: 'application/json',
      body: JSON.stringify({ central, end, size: bytes.length, held, requests: server.requests, stats: server.stats() }, null, 2) }) }
    catch (error) { failures.push(error) }
    try { await attachStartup(page, info, 'zip-index-stop', errors) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#stop')).toBeDisabled()
    } catch (error) { failures.push(error) }
    try { release?.(); await server.close() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'ZIP cancellation or evidence collection failed', { cause: failures[0] })
  })
}
