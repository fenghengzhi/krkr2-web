import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagEmbeddingGameSource, kagEmbeddingStory } from '../helpers/kag-embedding.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode observer' : 'source observer'}: original KAG displays embedded bracket names as text and real clicks continue the story`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = [], failures: unknown[] = [], observations: { phase: number; state: string }[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    const readState = async () => {
      const prefix = `emb-story-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.locator('#expression').fill(`${JSON.stringify(prefix)}+embStoryState()`)
      await page.locator('#evaluate').click()
      const output = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(output).toBeVisible({ timeout: 5000 })
      const state = ((await output.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 64) observations.push({ phase: Number(state.split('|', 1)[0]), state })
      return state
    }
    try {
      expect(createHash('sha256').update(original).digest('hex'))
        .toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      const utf16 = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
      await page.locator('#files').setInputFiles([
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'first.ks', mimeType: 'text/plain', buffer: utf16(kagEmbeddingStory) },
        { name: 'embedding-observer.tjs', mimeType: 'text/plain', buffer: utf16(kagEmbeddingGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: utf16(binary
          ? 'Scripts.compileStorage("embedding-observer.tjs","savedata/embedding-observer.cjs",false,true,false);Scripts.execStorage("savedata/embedding-observer.cjs");'
          : 'Scripts.execStorage("embedding-observer.tjs");') },
      ])
      await expect(page.getByText('emb-story-observer-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      const canvas = page.locator('#stage canvas[data-window-id]')
      await expect(canvas).toHaveCount(1)
      for (const [phase, text] of [[1, '[A][r]'], [2, 'NEXT [B]']] as const) {
        const expected = `${phase}|${text}|1|1|l`
        await expect.poll(readState, { timeout: 15000 }).toBe(expected)
        await expect(page.locator('#logs .error')).toHaveCount(0)
        await canvas.scrollIntoViewIfNeeded()
        await info.attach(`embedded-story-page-${phase}`, { body: await canvas.screenshot(), contentType: 'image/png' })
        const box = await canvas.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.width).toBeGreaterThan(0); expect(box!.height).toBeGreaterThan(0)
        // Actual player input, outside any test-created layer or synthetic
        // handler. Original MainWindow/Conductor process both line waits.
        await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.8)
      }
      await expect(page.getByText('emb-story-finished', { exact: true })).toBeVisible()
      await expect.poll(readState, { timeout: 15000 }).toBe('3|NEXT [B]|0|0|s')
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('embedded-story-source', { body: kagEmbeddingStory, contentType: 'text/plain' })
      await info.attach('embedded-story-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Original KAG framework; only the authored observer is compiled. Exact original HistoryLayer text and wait state plus actual clicks are asserted; screenshots preserve rendered output without assuming host font glyph identity.' }, null, 2), contentType: 'application/json' })
      await info.attach('embedded-story-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
    } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG embedding story or cleanup failed', { cause: failures[0] })
  })
