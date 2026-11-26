import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { quadGameFiles, quadSource } from '../helpers/wave-quad.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: release configuration expands real music, keeps explicit stereo, and freezes the first Wave output policy`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', {
      hasText: /^Four speaker music$/,
    }) }).locator('canvas[data-window-id]'),
      click = async (x: number, marker: string) => {
        const point = await pointerPixel(canvas, x, 30); await page.mouse.click(point.x, point.y)
        await expect(page.getByText(marker, { exact: true })).toBeVisible()
      }, hear = async (stage: number) => {
        const before = await nativePhasePosition(page), mono = stage === 1, masked = stage === 2,
          // Independent expected stereo amplitudes from L/R/L/R and the
          // pre-existing Web rear coefficient, not a production query.
          gain = masked ? 1 : 1.70710678,
          expected = mono ? [[.125 * gain, 0], [.125 * gain, 0]] : [[.25 * gain, 0], [0, .125 * gain]]
        expect(before.snapshot.channels).toBe(masked ? 2 : 4)
        expect(before.snapshot.sampleCount).toBe(9600); expect(before.snapshot.sampleRate).toBe(48000)
        expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
        await beginPhaseCapture(page, .5); const output = await endPhaseCapture(page)
        await attachPhaseCapture(info, `quad-stage-${stage}`, output, { before, expected })
        expect(output.channels).toHaveLength(2)
        for (let channel = 0; channel < 2; channel++) {
          const plane = output.channels[channel]!
          expect(plane).toHaveLength(Math.ceil(output.sampleRate / 2))
          for (let frame = 0; frame < plane.length; frame++)
            if (!Number.isFinite(plane[frame]!) || (mono && plane[frame] !== output.channels[0]![frame]))
              throw new Error(`Invalid quad stage ${stage}, channel ${channel}, frame ${frame}`)
          for (const [index, frequency] of [440, 880].entries()) {
            let real = 0, imaginary = 0
            for (let frame = 0; frame < plane.length; frame++) {
              const angle = frame * 2 * Math.PI * frequency / output.sampleRate
              real += plane[frame]! * Math.cos(angle); imaginary += plane[frame]! * Math.sin(angle)
            }
            expect(Math.abs(2 * Math.hypot(real, imaginary) / plane.length - expected[channel]![index]!)).toBeLessThan(.005)
          }
        }
        await expect(page.getByText(`quad-loop:${stage}`, { exact: true })).toBeVisible()
        await evaluate(page, 'int(quadMusic.phrases>=2)', '1')
      }
    try {
      const config = 'wsexpandquad=yes\r\nwsuse3d=no\r\n',
        startup = binary ? 'Scripts.compileStorage("quad.tjs",System.dataPath+"quad.cjs",false,true,false);Scripts.execStorage(System.dataPath+"quad.cjs");quadMenu();'
          : 'Scripts.execStorage("quad.tjs");quadMenu();'
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#files').setInputFiles([
        { name: 'Quad.exe', mimeType: 'application/octet-stream', buffer: Buffer.from([77, 90]) },
        { name: 'Quad.cf', mimeType: 'text/plain', buffer: Buffer.from(config, 'ascii') },
        { name: 'data.xp3', mimeType: 'application/octet-stream', buffer: xp3Fixture({ ...quadGameFiles(), 'startup.tjs': startup, 'quad.tjs': quadSource }).bytes },
      ])
      await info.attach('quad-release-config', { body: config, contentType: 'text/plain' })
      await expect(page.getByText('quad-ready:yes:4', { exact: true })).toBeVisible()
      await evaluate(page, 'System.exeName', 'game://./Quad.exe')
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      await hear(0)
      await click(40, 'quad-stage:1:4'); await hear(1)
      await click(120, 'quad-pause:1:1'); const paused = await nativePhasePosition(page)
      await beginPhaseCapture(page, .1); const silence = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'quad-paused', silence, { paused })
      for (const plane of silence.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      expect((await nativePhasePosition(page)).snapshot.position).toBe(paused.snapshot.position)
      await click(120, 'quad-pause:2:0'); await hear(1)
      await click(40, 'quad-stage:2:2'); await hear(2)
      await click(40, 'quad-stage:3:4'); await hear(3)
      await evaluate(page, 'System.getArgument("-wsexpandquad")', 'no')
      await info.attach('quad-game-buttons', { body: await canvas.screenshot(), contentType: 'image/png' })
      await click(200, 'quad-stopped:0')
      await beginPhaseCapture(page, .1); const stopped = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'quad-stopped', stopped)
      for (const plane of stopped.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('quad-game-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Quad music game or cleanup failed', { cause: failures[0] })
  })
