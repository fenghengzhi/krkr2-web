import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { waveFreeFiles, waveFreeSource } from '../helpers/wave-free.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: game releases and resumes two Wave tracks while independent CDDA audio continues`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', {
      hasText: /^Release and resume music$/,
    }) }).locator('canvas[data-window-id]')
    const click = async (x: number) => {
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await canvas.click({ position: { x: x * box!.width / 240, y: 30 * box!.height / 90 } })
    }
    const capture = async (name: string, expected: number) => {
      await beginPhaseCapture(page, 0.2)
      const output = await endPhaseCapture(page)
      await attachPhaseCapture(info, name, output, { expected, waveA: 0.25, waveB: 0.125, cdda: 0.0625 })
      expect(output.channels).toHaveLength(2)
      expect(output.endFrame - output.startFrame).toBeGreaterThan(output.sampleRate * 0.19)
      for (const samples of output.channels) {
        expect(samples).toHaveLength(output.endFrame - output.startFrame)
        for (let i = 0; i < samples.length; i++)
          if (samples[i] !== expected) throw new Error(`${name}: frame ${i} is ${samples[i]}, expected ${expected}`)
      }
    }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("free.tjs","savedata/free.cjs",false,true,false);Scripts.execStorage("savedata/free.cjs");'
          : 'Scripts.execStorage("free.tjs");') },
        { name: 'free.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveFreeSource + '\nwaveFreeMenu();') },
        ...Object.entries(waveFreeFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('wave-free-ready:play,play,play,play', { exact: true })).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await openPhaseCapture(page)
      await capture('two-wave-and-cdda', 0.4375)
      await click(40)
      await expect(page.getByText('wave-free-release:stop,stop,play,play', { exact: true })).toBeVisible()
      await capture('only-independent-cdda', 0.0625)
      // Fade belongs to the sound object and finishes once after release.
      await expect(page.getByText('wave-free-fade:a:1', { exact: true })).toBeVisible()
      await evaluate(page, '[freeA.done,freeA.volume].join(",")', '1,0')
      await evaluate(page, 'freeOrder.join(";")', 'a:stop,play;b:stop,stop')
      await evaluate(page, '[freeA.samplePosition,freeB.samplePosition].join(",")', '0,0')
      await info.attach('released-game', { body: await canvas.screenshot(), contentType: 'image/png' })
      await click(120)
      await expect(page.getByText('wave-free-resume:play,play,play,play', { exact: true })).toBeVisible()
      await capture('recreated-wave-buffers', 0.4375)
      await evaluate(page, '[freeA.done,freeA.marks.count>=2,freeB.marks.count>=2].join(",")', '1,1,1')
      await click(200)
      await expect(page.getByText('wave-free-off:stop,stop,stop,stop', { exact: true })).toBeVisible()
      await capture('all-stopped', 0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-free-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave release game or cleanup failed', { cause: failures[0] })
  })
