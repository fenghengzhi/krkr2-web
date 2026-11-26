import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagNameGameSource, kagNameStory } from '../helpers/kag-names.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: original KAG plays distinct localized macros after a real choice`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    const read = async (expression: string) => {
      const prefix = `names-game-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Localized name observer is disabled')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const output = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(output).toBeVisible({ timeout: 5000 })
      const value = ((await output.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 64) observations.push({ expression, value })
      return value
    }
    try {
      expect(createHash('sha256').update(original).digest('hex'))
        .toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      const utf16 = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
      await page.locator('#files').setInputFiles([
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'first.ks', mimeType: 'text/plain', buffer: utf16(kagNameStory) },
        { name: 'names-game.tjs', mimeType: 'text/plain', buffer: utf16(kagNameGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: utf16(binary
          ? 'Scripts.compileStorage("names-game.tjs","savedata/names-game.cjs",false,true,false);Scripts.execStorage("savedata/names-game.cjs");'
          : 'Scripts.execStorage("names-game.tjs");') },
      ])
      await expect(page.getByText('names-game-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      const canvas = page.locator('#stage canvas[data-window-id]')
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
      await expect.poll(() => read('nameGameState()'), { timeout: 15000 }).toBe('0|*choice|Continue|0|s|1|1|1|1')
      const link = (await read(`(function(){var m=kag.current,l=m.links[0],x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1);
        if(!l.fixed[0]){x+=m.lineLayerOriginX+m.getLineLayerLeftOffset();y+=m.lineLayerOriginY+m.getLineLayerTopOffset();}
        for(var p=m;p!==null;p=p.parent){x+=p.left;y+=p.top;}
        return [x,y,l.w[0],l.h[0],l.target,int(m.selProcessLock)].join("|");})()`)).split('|')
      expect(link).toHaveLength(6); expect(link[4]).toBe('*picked'); expect(link[5]).toBe('0')
      const [x, y, width, height] = link.slice(0, 4).map(Number)
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(640)
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(480)
      expect(width).toBeGreaterThan(0); expect(height).toBeGreaterThan(0)
      await canvas.scrollIntoViewIfNeeded()
      let box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await page.mouse.click(box!.x + x! * box!.width / 640, box!.y + y! * box!.height / 480)
      for (const [phase, text] of [[1, 'HERO 7/2'], [2, 'friend 3']] as const) {
        await expect.poll(() => read('nameGameState()'), { timeout: 15000 })
          .toBe(`${phase}|*picked|${text}|1|l|0|1|1|1`)
        await expect(page.locator('#logs .error')).toHaveCount(0)
        await canvas.scrollIntoViewIfNeeded()
        await info.attach(`localized-macro-${phase}`, { body: await canvas.screenshot(), contentType: 'image/png' })
        box = await canvas.boundingBox(); expect(box).not.toBeNull()
        // Only actual player clicks advance the original MessageLayer wait.
        await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.8)
      }
      await expect.poll(() => read('nameGameState()'), { timeout: 15000 }).toBe('3|*end|END|0|s|0|1|1|1')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('localized-names-game-source', { body: kagNameStory + '\n' + kagNameGameSource, contentType: 'text/plain' })
      await info.attach('localized-names-game-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Original KAG template, authored localized macro/argument names. Actual link and two line-wait clicks; exact History and return state. Only the authored observer script is compiled.' }, null, 2), contentType: 'application/json' })
      await info.attach('localized-names-game-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
    } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG localized names game or cleanup failed', { cause: failures[0] })
  })
