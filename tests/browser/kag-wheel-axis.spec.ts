import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagGameControls } from '../helpers/kag-game-controls.ts'
import { wheelAxisSource, wheelAxisStory } from '../helpers/kag-wheel-axis.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: horizontal scrolling cannot advance original KAG dialogue while vertical wheel retains history and reading`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [],
      { read, clickLink } = kagGameControls(page, observations, { firstReadTimeout: 30000 }),
      canvas = page.locator('#stage canvas[data-window-id]'),
      original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const state = async (phase: number, history: boolean, stopped = false) => {
      let fields: string[] = []
      await expect.poll(async () => {
        fields = (await read('wheelAxisState()')).split('|')
        return fields.length === 8 && fields[0] === String(phase) && fields[1] === '*reading' &&
          fields[5] === (stopped ? '0' : '1') && fields[6] === (stopped ? 's' : 'l') && fields[7] === (history ? '1' : '0')
      }, { timeout: 15000 }).toBe(true)
      return fields.slice(0, 7).join('|')
    }
    const wheel = async (x: number, y: number) => {
      await canvas.scrollIntoViewIfNeeded()
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await canvas.hover({ position: { x: box!.width * .5, y: box!.height * .5 } })
      observations.push({ actualWheel: [x, y], box })
      await page.mouse.wheel(x, y)
    }
    const closeHistory = async (phase: number, cursor: string) => {
      await canvas.focus()
      await expect(page.locator('#stage textarea.game-text-input')).toBeFocused()
      await page.keyboard.press('Escape', { delay: 200 })
      expect(await state(phase, false)).toBe(cursor)
      // Preserve KAG's deliberate 150ms guard against reading immediately
      // after a wheel/keypress closes History. Observing it never advances.
      await expect.poll(() => read('int(System.getTickCount()-kag.lastHistoryHiddenTick>150)'), { timeout: 5000 }).toBe('1')
    }
    try {
      expect(createHash('sha256').update(original).digest('hex')).toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      const wide = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
      await page.locator('#files').setInputFiles([
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'first.ks', mimeType: 'text/plain', buffer: wide(wheelAxisStory) },
        { name: 'wheel-axis.tjs', mimeType: 'text/plain', buffer: wide(wheelAxisSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: wide(binary
          ? 'Scripts.compileStorage("wheel-axis.tjs","savedata/wheel-axis.cjs",false,true,false);Scripts.execStorage("savedata/wheel-axis.cjs");'
          : 'Scripts.execStorage("wheel-axis.tjs");') },
      ])
      await expect(page.getByText('wheel-axis-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const exit = page.locator('.leave-fullscreen'); if (await exit.isVisible()) await exit.click()
      await expect(canvas).toHaveCount(1)
      const first = await state(1, false)
      await wheel(120, 0); await wheel(-120, 0)
      // The following admitted vertical event is a real ordering barrier:
      // History must open with the very first reading cursor and text still
      // retained, not merely observe the old state before queued input runs.
      await wheel(0, -120); expect(await state(1, true)).toBe(first)
      const firstHistory = await read('wheelAxisHistory()')
      expect(firstHistory).toContain('FIRST LINE'); expect(firstHistory).not.toContain('SECOND LINE')
      await info.attach('horizontal-input-kept-first-history', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await closeHistory(1, first)
      await wheel(0, 120); const second = await state(2, false)
      expect(second).not.toBe(first)
      await wheel(-240, 0); await wheel(0, -120)
      expect(await state(2, true)).toBe(second)
      const secondHistory = await read('wheelAxisHistory()')
      expect(secondHistory).toContain('FIRST LINE'); expect(secondHistory).toContain('SECOND LINE')
      expect(secondHistory).not.toContain('CHAPTER COMPLETE')
      await closeHistory(2, second)
      await wheel(0, 120); await state(3, false, true)
      expect(await read('kag.current.numLinks')).toBe('1')
      await clickLink(0, '*reading'); await state(1, false)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('wheel-axis-author-source', { body: wheelAxisSource + '\n' + wheelAxisStory, contentType: 'text/plain' }),
      () => info.attach('wheel-axis-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Original KAG MainWindow/HistoryLayer input handlers; real Playwright horizontal and vertical wheel, Escape and chapter link. Author script only observes state; no injected WheelEvent or direct game handler call. Fractional units and defaultPrevented are independently covered through the production DOM coordinator in Node.' }, null, 2), contentType: 'application/json' }),
      async () => info.attach('wheel-axis-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter(worker => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Original KAG wheel route or cleanup failed', { cause: failures[0] })
  })
