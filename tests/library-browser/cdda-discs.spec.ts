import { test, expect } from '../helpers/library-browser.ts'
import { cddaLibraryGame } from '../helpers/cdda-library.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture, endPhaseCapture,
  attachPhaseCapture } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: player disc bindings survive library refresh and editable mappings select the actual CUE audio`, async ({ page }, info) => {
    test.setTimeout(150000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [],
      original = 'E=Second/disc.cue\nD=First/disc.cue\nD.label=Game Music', swapped = 'D=Second/disc.cue\nE=First/disc.cue\nE.label=Game Music',
      title = `Two discs ${backend} ${binary ? 'compiled' : 'source'}`,
      item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) }),
      canvas = page.locator('.game-window[data-window-id]').filter({
        has: page.locator('.game-window-title', { hasText: /^Two-disc game$/ }),
      }).locator('canvas[data-window-id]')
    let capturing = false
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const record = () => page.evaluate(() => new Promise<{
      gameId: string; cddaDiscs?: { drive: string; cue: string; volumeLabel?: string }[]; files: { path: string; hashes: string[] }[]
    }>((resolve, reject) => {
      const opening = indexedDB.open('krkr2-library')
      opening.onerror = () => reject(opening.error)
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction('games'), request = tx.objectStore('games').getAll()
        tx.onabort = () => { db.close(); reject(tx.error) }
        tx.oncomplete = () => {
          db.close()
          if (request.result.length !== 1) { reject(new Error('Expected one stored disc game')); return }
          const game = request.result[0]
          resolve({ gameId: game.gameId, cddaDiscs: game.cddaDiscs,
            files: game.files.map((file: { path: string; hashes: string[] }) => ({ path: file.path, hashes: file.hashes })) })
        }
      }
    }))
    const choose = async (index: number, name: string, duration: number) => {
      const message = page.getByText(`disc-choice:${name}:${duration}`, { exact: true }), before = await message.count(),
        box = await canvas.boundingBox()
      expect(box).not.toBeNull()
      await canvas.click({ position: { x: box!.width * (48 + index * 100) / 400, y: box!.height * 28 / 80 } })
      await expect(message).toHaveCount(before + 1)
      const picture = await canvas.screenshot({ timeout: 5000 }), image = readScreenshotPng(picture),
        at = (Math.floor(image.height * 70 / 80) * image.width + Math.floor(image.width / 2)) * 4
      expect([...image.rgba.subarray(at, at + 4)]).toEqual(duration === 2000 ? [51, 102, 153, 255] : [153, 85, 51, 255])
      await info.attach(`disc-${observations.length}-${name.replace(':', '-')}`, { body: picture, contentType: 'image/png' })
      observations.push({ name, duration, screenshot: [image.width, image.height] })
    }
    const tone = async (name: string, hz: number) => {
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      if (!capturing) { await openPhaseCapture(page); capturing = true }
      await beginPhaseCapture(page, 0.5)
      const capture = await endPhaseCapture(page), metrics = await attachPhaseCapture(info, name, capture, { expectedHz: hz })
      expect(metrics).toHaveLength(2)
      for (const channel of metrics) {
        expect(channel.nonfinite).toBe(0)
        expect(channel.rms).toBeGreaterThan(0.1)
        expect(channel.spectrum.count).toBe(8192)
        expect(Math.abs(channel.spectrum.peakHz - hz)).toBeLessThanOrEqual(1)
      }
      observations.push({ name, hz, metrics })
    }
    const closeCapture = async () => {
      if (capturing) {
        try { await closePhaseCapture(page) } finally { capturing = false }
      }
    }
    const stop = async () => {
      const cleanup: unknown[] = []
      try { await closeCapture() } catch (error) { cleanup.push(error) }
      try {
        if (await page.locator('#stop').isEnabled()) await page.locator('#stop').dispatchEvent('click')
        await expect(page.locator('#status')).toHaveText('待机')
        await expect(canvas).toHaveCount(0)
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      } catch (error) { cleanup.push(error) }
      if (cleanup.length === 1) throw cleanup[0]
      if (cleanup.length) throw new AggregateError(cleanup, 'Disc capture and player retirement failed', { cause: cleanup[0] })
    }
    try {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#cdda-discs').fill(original)
      await page.locator('#files').setInputFiles({ name: 'data.xp3', mimeType: 'application/octet-stream', buffer: cddaLibraryGame(binary) })
      await expect(page.getByText('two-disc-ready:none', { exact: true })).toBeVisible()
      await choose(0, 'D:1', 2000); await tone('import-disc-d', 440)
      await choose(1, 'E:1', 3000); await tone('import-disc-e', 880)
      await choose(3, 'E:1', 3000)
      await expect(page.getByText('disc-labels:E|D', { exact: true }).last()).toBeVisible()
      await choose(2, '1', 3000)
      // Future import controls cannot replace this live session's frozen bindings.
      await page.locator('#cdda-discs').fill(swapped)
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      const before = await record()
      expect(before.cddaDiscs).toEqual([{ drive: 'E', cue: 'Second/disc.cue' }, { drive: 'D', cue: 'First/disc.cue', volumeLabel: 'Game Music' }])
      observations.push({ saved: before })
      await stop(); await page.reload()
      // Even a malformed temporary-import editor is irrelevant to a saved game.
      await page.locator('#cdda-discs').fill('not a drive binding')
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await expect(page.getByText('two-disc-ready:1', { exact: true })).toBeVisible()
      await choose(0, 'D:1', 2000); await tone('library-disc-d', 440)
      await choose(1, 'E:1', 3000); await tone('library-disc-e', 880)
      await choose(3, 'E:1', 3000)
      await expect(page.getByText('disc-labels:E|D', { exact: true }).last()).toBeVisible()
      await choose(2, '1', 3000)
      expect(await record()).toEqual(before)
      await item.locator('summary').click()
      const editor = item.getByRole('textbox', { name: '库中游戏光盘映射', exact: true })
      await expect(editor).toHaveValue(original)
      await editor.fill('D=First/disc.cue\nd=Second/disc.cue')
      await item.getByRole('button', { name: '保存设置', exact: true }).click()
      await expect(page.locator('#logs .error')).toContainText('盘符 D 重复')
      expect(await record()).toEqual(before)
      await info.attach('invalid-disc-settings-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
      await page.locator('#clear-log').click()
      await editor.fill(swapped)
      await item.getByRole('button', { name: '保存设置', exact: true }).click()
      await expect.poll(async () => (await record()).cddaDiscs).toEqual([
        { drive: 'D', cue: 'Second/disc.cue' }, { drive: 'E', cue: 'First/disc.cue', volumeLabel: 'Game Music' },
      ])
      // Editing next-start settings leaves the currently playing disc set intact.
      await choose(0, 'D:1', 2000)
      await closeCapture()
      await page.locator('#restart').click()
      await expect(page.getByText('two-disc-ready:D:1', { exact: true })).toBeVisible()
      await choose(0, 'D:1', 3000); await tone('edited-disc-d', 880)
      await choose(1, 'E:1', 2000); await tone('edited-disc-e', 440)
      await choose(3, 'D:1', 3000); await tone('label-found-on-remapped-drive', 880)
      await expect(page.getByText('disc-labels:D|E', { exact: true }).last()).toBeVisible()
      await choose(2, '1', 3000)
      const after = await record()
      expect(after.gameId).toBe(before.gameId); expect(after.files).toEqual(before.files)
      observations.push({ edited: after })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('disc-library-observations', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })
      await info.attach('disc-library-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
    } catch (error) { failures.push(error) }
    try { await stop(); expect(errors).toEqual([]) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'CDDA library game or cleanup failed', { cause: failures[0] })
  })
