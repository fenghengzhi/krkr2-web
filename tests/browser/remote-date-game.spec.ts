import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { remoteDateGame } from '../helpers/remote-date-game.ts'
import { customEntryPaths } from '../helpers/custom-entry-distribution.ts'
import { kagGameControls } from '../helpers/kag-game-controls.ts'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: a large remote KAG release without an ETag pins date ranges and restores the same original bookmark`, async ({ page }, info) => {
    test.setTimeout(150000)
    await page.goto('/?backend=' + backend)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await remoteDateGame(), failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [],
      responses: { status: number; date?: string; modified?: string; etag?: string; range?: string }[] = [],
      canvas = page.locator('#stage canvas[data-window-id]'), { read, clickLink } = kagGameControls(page, observations)
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('response', (response) => {
      if (response.url() !== fixture.url) return
      const headers = response.headers()
      responses.push({ status: response.status(), date: headers.date, modified: headers['last-modified'],
        etag: headers.etag, range: headers['content-range'] })
    })
    const state = async (progress: number, visits: number, choice = false) => {
      await expect.poll(() => read('customState()'), { timeout: 15000 }).toBe(choice
        ? `0|CUSTOM ENTRY|${visits}|*choice|2|0`
        : `${progress}|CHAPTER ${progress}|${visits}|*checkpoint|3|0`)
    }, load = async () => {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#entry').fill('boot.tjs')
      await page.locator('#remote-kind').selectOption('file')
      await page.locator('#remote-url').fill(fixture.url)
      await page.locator('#load-url').click()
      await expect(page.getByText('custom-entry-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const fullscreen = page.locator('.leave-fullscreen')
      if (await fullscreen.isVisible()) await fullscreen.click()
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
      expect(await read('customPaths()')).toBe(customEntryPaths)
      await state(0, 1, true)
    }, backup = async (label: string) => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), saved = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] },
        record = saved.files.find((file) => file.path === 'Release/savedata/custom0.kdt')
      expect(record).toBeDefined(); expect(saved.gameId).not.toBe('')
      const slot = Buffer.from(record!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('*checkpoint')
      await info.attach(label, { body: bytes, contentType: 'application/json' })
      observations.push({ backup: label, gameId: saved.gameId, slotSha256: createHash('sha256').update(slot).digest('hex') })
      return { gameId: saved.gameId, slot }
    }, stop = async () => {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }, transport = (requestStart = 0) => {
      const rows = fixture.snapshot().requests.slice(requestStart).filter((row) => row.method === 'GET'), completed = rows.filter((row) => row.complete)
      expect(rows.length).toBeGreaterThan(3)
      expect(rows.every((row) => row.status === 206)).toBe(true)
      expect(completed.length).toBeGreaterThan(3)
      expect(completed.every((row) => !row.aborted && row.sent === row.to! - row.from! + 1)).toBe(true)
      expect(rows.every((row) => !row.ifMatch && !row.ifRange &&
        (row.range === 'bytes=0-0' || row.unmodifiedSince === fixture.lastModified))).toBe(true)
      expect(rows.some((row) => row.range === 'bytes=0-0')).toBe(true)
      for (const row of completed) {
        expect(row.responseETag).toBeUndefined()
        expect(row.responseLastModified).toBe(fixture.lastModified)
        expect(Date.parse(row.responseDate!) - Date.parse(row.responseLastModified!)).toBeGreaterThanOrEqual(60000)
      }
      for (const name of ['Release/data/boot.tjs', 'Release/data/first.ks', 'Release/data/engine.xp3']) {
        const member = fixture.members.find((entry) => entry.name === name)!
        expect(member.dataAt).toBeGreaterThan(64 * 1024 ** 2)
        // Range/cache blocks may split any member. The script bodies must be
        // read; the nested original XP3 only needs its initial stream anchor,
        // because subsequent archive reads legitimately remain demand-driven.
        const end = member.dataAt + (name.endsWith('.xp3') ? Math.min(32, member.packedBytes) : member.packedBytes),
          ranges = completed.map((row) => ({ from: Math.max(member.dataAt, row.from!), to: Math.min(end, row.to! + 1) }))
            .filter((range) => range.from < range.to).sort((a, b) => a.from - b.from)
        let coveredTo = member.dataAt
        for (const range of ranges) {
          if (range.from > coveredTo) break
          coveredTo = Math.max(coveredTo, range.to)
        }
        expect(coveredTo, 'Completed response coverage for ' + name).toBe(end)
      }
      // Some browser/Worker implementations do not route every response to
      // Page. Server records above are authoritative; these remain optional
      // passive observations and never replace required range coverage.
      for (const response of responses.filter((row) => row.status === 206)) {
        expect(response.etag).toBeUndefined(); expect(response.modified).toBe(fixture.lastModified)
        expect(Date.parse(response.date!) - Date.parse(response.modified!)).toBeGreaterThanOrEqual(60000)
        expect(response.range).toMatch(new RegExp('/' + fixture.size + '$'))
      }
      expect(fixture.snapshot().errors).toEqual([])
      observations.push({ phase: 'date-pinned-ranges', requestStart, responses: [...responses], transport: fixture.snapshot() })
    }
    try {
      expect(fixture.size).toBeGreaterThan(64 * 1024 ** 2)
      expect(fixture.size).toBeLessThan(76 * 1024 ** 2)
      await load()
      await clickLink(0, '*selected'); await state(7, 2)
      await clickLink(0, '*save'); await state(7, 3)
      expect(await read('customStored()')).toBe('7|*checkpoint')
      const before = await backup('date-game-before.json')
      await info.attach('date-game-saved-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      transport()
      await clickLink(1, '*change'); await state(99, 4)
      await stop()
      const reopenedRequestStart = fixture.snapshot().requests.length
      await page.reload(); await load()
      const after = await backup('date-game-after.json')
      expect(after.gameId).toBe(before.gameId); expect(after.slot.equals(before.slot)).toBe(true)
      await clickLink(1, '*load'); await state(7, 2)
      expect(await read('customStored()')).toBe('7|*checkpoint')
      await info.attach('date-game-restored-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      transport(reopenedRequestStart)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const finish of [
      () => info.attach('date-game-evidence', { body: JSON.stringify({ fixture: fixture.evidence, observations,
        responses, errors, transport: fixture.snapshot() }, null, 2), contentType: 'application/json' }),
      async () => info.attach('date-game-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
      stop, () => fixture.close(),
    ]) try { await finish() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Date-version remote game or cleanup failed', { cause: failures[0] })
  })
