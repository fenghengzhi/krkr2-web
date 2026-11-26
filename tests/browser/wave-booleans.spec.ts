import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { waveBooleanExpected, waveBooleanFiles, waveBooleanSource } from '../helpers/wave-booleans.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: actual game buttons pause a fractional-real Wave request, resume both channels, and continue past a short loop's end`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({
      has: page.locator('.game-window-title', { hasText: /^Wave pause and loop$/ }),
    }).locator('canvas[data-window-id]')
    const click = async (x: number) => {
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await canvas.click({ position: { x: x * box!.width / 180, y: 30 * box!.height / 60 } })
    }
    const capture = async (name: string, expected: readonly [number, number]) => {
      await beginPhaseCapture(page, 0.2)
      const output = await endPhaseCapture(page)
      await attachPhaseCapture(info, name, output, { expected, clipFrames: 24, sourceRate: 1000 })
      expect(output.channels).toHaveLength(2)
      // The capture lasts over eight complete source durations. Silence after
      // one pass therefore cannot satisfy a "looping" result accidentally.
      expect(output.endFrame - output.startFrame).toBeGreaterThan(output.sampleRate * 0.19)
      for (let channel = 0; channel < 2; channel++) {
        const samples = output.channels[channel]!
        expect(samples.length).toBe(output.endFrame - output.startFrame)
        expect(samples).toEqual(Array(samples.length).fill(expected[channel]))
      }
    }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("wave-bool.tjs","savedata/wave-bool.cjs",false,true,false);Scripts.execStorage("savedata/wave-bool.cjs");'
          : 'Scripts.execStorage("wave-bool.tjs");') },
        { name: 'wave-bool.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveBooleanSource + '\nwaveBooleanMenu();') },
        ...Object.entries(waveBooleanFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('wave-bool-menu:play,1,1', { exact: true })).toBeVisible()
      for (const [name, expected] of Object.entries(waveBooleanExpected))
        await evaluate(page, `waveBooleanObserve("${name}")`, expected)
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await openPhaseCapture(page)
      await capture('initial-real-paused', [0, 0])
      await evaluate(page, 'waveBooleanState()', 'play,1,1,0,0')
      await click(30)
      await expect(page.getByText('wave-bool-resume:0', { exact: true })).toHaveCount(1)
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBeGreaterThan(0.4)
      await capture('fractional-loop-across-eof', [0.25, -0.5])
      await evaluate(page, '[boolMusic.status,boolMusic.paused,boolMusic.looping].join(",")', 'play,0,1')
      await click(90)
      await expect(page.getByText('wave-bool-pause:1', { exact: true })).toHaveCount(1)
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await evaluate(page, '(global.boolHeldPosition=boolMusic.samplePosition,[boolMusic.status,boolMusic.paused,boolMusic.looping].join(","))', 'play,1,1')
      await capture('negative-real-paused', [0, 0])
      await evaluate(page, 'int(boolMusic.samplePosition==boolHeldPosition)', '1')
      await click(30)
      await expect(page.getByText('wave-bool-resume:0', { exact: true })).toHaveCount(2)
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBeGreaterThan(0.4)
      await capture('resumed-native-boolean-loop', [0.25, -0.5])
      await click(150)
      await expect(page.getByText('wave-bool-once:0', { exact: true })).toHaveCount(1)
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await evaluate(page, '[boolMusic.status,boolMusic.paused,boolMusic.looping].join(",")', 'stop,0,0')
      await capture('numeric-string-zero-natural-end', [0, 0])
      await evaluate(page, 'waveBooleanClose()', 'closed')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-boolean-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave boolean game or cleanup failed', { cause: failures[0] })
  })
