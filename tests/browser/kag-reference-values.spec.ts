import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagReferenceGameSource, kagReferenceStory } from '../helpers/kag-reference-values.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: original KAG forwards the same game actor and callback through player line waits`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = [], failures: unknown[] = [], observations: string[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    const readState = async () => {
      const prefix = `reference-story-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      // This submits the existing console UI handler without moving the real
      // pointer away from the player's last click. Only the reads are synthetic.
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Reference story console is disabled')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+referenceStoryState()`)
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
        { name: 'first.ks', mimeType: 'text/plain', buffer: utf16(kagReferenceStory) },
        { name: 'reference-game.tjs', mimeType: 'text/plain', buffer: utf16(kagReferenceGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: utf16(binary
          ? 'Scripts.compileStorage("reference-game.tjs","savedata/reference-game.cjs",false,true,false);Scripts.execStorage("savedata/reference-game.cjs");'
          : 'Scripts.execStorage("reference-game.tjs");') },
      ])
      await expect(page.getByText('reference-story-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      const canvas = page.locator('#stage canvas[data-window-id]')
      await expect(canvas).toHaveCount(1)
      for (const phase of [1, 2]) {
        await expect.poll(readState, { timeout: 15000 }).toBe(`${phase}|${phase}|ACTOR ${phase}|1|l|0`)
        await expect(page.getByText(`reference-story-step:${phase}`, { exact: true })).toHaveCount(1)
        await expect(page.locator('#logs .error')).toHaveCount(0)
        await canvas.scrollIntoViewIfNeeded()
        await info.attach(`reference-story-${phase}`, { body: await canvas.screenshot(), contentType: 'image/png' })
        const box = await canvas.boundingBox()
        expect(box).not.toBeNull(); expect(box!.width).toBeGreaterThan(0); expect(box!.height).toBeGreaterThan(0)
        await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.8)
      }
      await expect.poll(readState, { timeout: 15000 }).toBe('3|2|ACTOR 2|0|s|1')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('reference-story-source', { body: kagReferenceStory, contentType: 'text/plain' })
      await info.attach('reference-story-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Original KAG framework and real player line-wait clicks. Only authored game tags are compiled in bytecode mode. Actor/callback identity is checked by those handlers; exact History text and macro unwinding are checked through read-only observations.' }, null, 2), contentType: 'application/json' })
      await info.attach('reference-story-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
    } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG reference story or cleanup failed', { cause: failures[0] })
  })
