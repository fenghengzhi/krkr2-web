import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { conditionalGameFiles, conditionalSource } from '../helpers/wave-conditional-unit.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: conditional music plays its first middle phrase and drives the game branch before later-loop transitions`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', {
      hasText: /^Conditional music phrases$/,
    }) }).locator('canvas[data-window-id]'), click = async (x: number) => {
      const point = await pointerPixel(canvas, x, 30); await page.mouse.click(point.x, point.y)
    }, pause = async (serial: number) => {
      await click(90); await expect(page.getByText(`branch-paused:${serial}`, { exact: true })).toBeVisible()
      const before = await nativePhasePosition(page)
      await beginPhaseCapture(page, .1); const silence = await endPhaseCapture(page)
      await attachPhaseCapture(info, `branch-paused-${serial}`, silence, { before })
      for (const plane of silence.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      expect((await nativePhasePosition(page)).snapshot.position).toBe(before.snapshot.position)
    }, hear = async (serial: number, x: number, middle: boolean) => {
      await beginPhaseCapture(page, 2); await click(x)
      await expect(page.getByText(`branch-choice:${serial}:${middle ? 'middle' : 'next'}`, { exact: true })).toBeVisible()
      const output = await endPhaseCapture(page)
      await attachPhaseCapture(info, `branch-${serial}-actual-music`, output, { middle, sourceRate: 8000,
        windows: [[.012, .042, 400], [.062, .092, middle ? 800 : 1200], [.162, .192, 1200]] })
      expect(output.channels).toHaveLength(2)
      const left = output.channels[0]!, right = output.channels[1]!, first = left.findIndex((sample) => Math.abs(sample) > .002)
      expect(first).toBeGreaterThanOrEqual(0)
      expect(left.length - first).toBeGreaterThan(output.sampleRate * .3)
      let zeros = 0, longest = 0
      for (let frame = first; frame < left.length; frame++) {
        if (!Number.isFinite(left[frame]!) || !Number.isFinite(right[frame]!) || right[frame] !== -left[frame]! / 2)
          throw new Error(`Conditional stereo differs at output frame ${frame}: ${left[frame]},${right[frame]}`)
        zeros = left[frame] === 0 ? zeros + 1 : 0; longest = Math.max(longest, zeros)
      }
      expect(longest).toBeLessThanOrEqual(Math.ceil(output.sampleRate / 8000) * 2)
      for (const [from, to, tone] of [[.012, .042, 400], [.062, .092, middle ? 800 : 1200], [.162, .192, 1200]] as const) {
        const start = first + Math.round(from * output.sampleRate), end = first + Math.round(to * output.sampleRate),
          amplitudes = [400, 800, 1200].map((frequency) => {
            let real = 0, imaginary = 0
            for (let frame = start; frame < end; frame++) {
              const phase = frame * 2 * Math.PI * frequency / output.sampleRate
              real += left[frame]! * Math.cos(phase); imaginary += left[frame]! * Math.sin(phase)
            }
            return 2 * Math.hypot(real, imaginary) / (end - start)
          })
        for (const [index, frequency] of [400, 800, 1200].entries())
          if (frequency === tone) expect(amplitudes[index]).toBeGreaterThan(.20)
          else expect(amplitudes[index]).toBeLessThan(.01)
      }
      await evaluate(page, '[branchMusic.first,branchMusic.flags[0],branchMusic.status].join("|")', `${middle ? 'middle' : 'next'}|1|play`)
    }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("branch.tjs","savedata/branch.cjs",false,true,false);Scripts.execStorage("savedata/branch.cjs");branchMenu();'
          : 'Scripts.execStorage("branch.tjs");branchMenu();') },
        { name: 'branch.tjs', mimeType: 'text/plain', buffer: Buffer.from(conditionalSource) },
        ...Object.entries(conditionalGameFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('branch-ready', { exact: true })).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      await hear(0, 30, true); await pause(0)
      await hear(1, 150, true); await pause(1)
      await hear(2, 210, false)
      await info.attach('conditional-game-choice', { body: await canvas.screenshot(), contentType: 'image/png' })
      const focus = await pointerPixel(canvas, 10, 75)
      await page.mouse.click(focus.x, focus.y); await page.keyboard.press('Escape')
      await expect(page.getByText('branch-stopped', { exact: true })).toBeVisible()
      await beginPhaseCapture(page, .1); const stopped = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'conditional-stopped', stopped)
      for (const plane of stopped.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('conditional-game-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Conditional music game or cleanup failed', { cause: failures[0] })
  })
