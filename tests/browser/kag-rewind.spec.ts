import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagRewindGameFiles, kagRewindGameSource } from '../helpers/kag-rewind.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: original KAG plays a filtered chapter with caller parameters and returns after actual clicks`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = [], failures: unknown[] = [], observations: string[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    const readState = async () => {
      const prefix = `rewind-game-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Scenario observer console is disabled')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+rewindGameState()`)
      const output = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(output).toBeVisible({ timeout: 5000 })
      const state = ((await output.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 64) observations.push(state)
      return state
    }
    try {
      expect(createHash('sha256').update(original).digest('hex'))
        .toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      const utf16 = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
      await page.locator('#files').setInputFiles([
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        ...Object.entries(kagRewindGameFiles).map(([name, text]) => ({ name, mimeType: 'text/plain', buffer: utf16(text) })),
        { name: 'rewind-game.tjs', mimeType: 'text/plain', buffer: utf16(kagRewindGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: utf16(binary
          ? 'Scripts.compileStorage("rewind-game.tjs","savedata/rewind-game.cjs",false,true,false);Scripts.execStorage("savedata/rewind-game.cjs");'
          : 'Scripts.execStorage("rewind-game.tjs");') },
      ])
      await expect(page.getByText('rewind-game-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      const canvas = page.locator('#stage canvas[data-window-id]')
      await expect(canvas).toHaveCount(1)
      for (const [phase, text] of [[1, 'PLAYER'], [2, 'CONTINUE PLAYER']] as const) {
        await expect.poll(readState, { timeout: 15000 }).toBe(`${phase}|${text}|1|l|1|0|AUX,2,1|PLAYER,1,0`)
        await expect(page.locator('#logs .error')).toHaveCount(0)
        await canvas.scrollIntoViewIfNeeded()
        await info.attach(`generated-chapter-${phase}`, { body: await canvas.screenshot(), contentType: 'image/png' })
        const box = await canvas.boundingBox()
        expect(box).not.toBeNull(); expect(box!.width).toBeGreaterThan(0); expect(box!.height).toBeGreaterThan(0)
        // Original MessageLayer/MainWindow receives the real player click.
        await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.8)
      }
      await expect.poll(readState, { timeout: 15000 }).toBe('3|CONTINUE PLAYER|0|s|0|1|AUX,2,1|PLAYER,1,0')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('rewind-game-inputs', { body: JSON.stringify({ files: kagRewindGameFiles, game: kagRewindGameSource }, null, 2), contentType: 'application/json' })
      await info.attach('rewind-game-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Unmodified original KAG template with authored documented scenario-filter hooks. Only the authored hook script is compiled. Actual line-wait clicks, caller parameters, conditional reset, exact History text and return stack are asserted.' }, null, 2), contentType: 'application/json' })
      await info.attach('rewind-game-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
    } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG filtered chapter or cleanup failed', { cause: failures[0] })
  })
