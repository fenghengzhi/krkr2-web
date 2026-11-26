import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { waveTailFiles, waveTailSource } from '../helpers/wave-tail.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a player's play button reaches the real SLI endpoint and starts a different stereo music file exactly once`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({
      has: page.locator('.game-window-title', { hasText: /^Music tail handoff$/ }),
    }).locator('canvas[data-window-id]')
    const click = async (x: number) => {
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await canvas.click({ position: { x: x * box!.width / 180, y: 30 * box!.height / 60 } })
    }
    const silence = async (name: string) => {
      await beginPhaseCapture(page, 0.2)
      const output = await endPhaseCapture(page)
      await attachPhaseCapture(info, name, output, { expected: [0, 0] })
      expect(output.channels).toHaveLength(2)
      for (const channel of output.channels) {
        expect(channel.length).toBe(Math.ceil(output.sampleRate * 0.2))
        expect(channel).toEqual(Array(channel.length).fill(0))
      }
    }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("tail.tjs","savedata/tail.cjs",false,true,false);Scripts.execStorage("savedata/tail.cjs");'
          : 'Scripts.execStorage("tail.tjs");') },
        { name: 'tail.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveTailSource + '\nwaveTailMenu();') },
        ...Object.entries(waveTailFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('wave-tail-ready', { exact: true })).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await openPhaseCapture(page)
      await click(90)
      await expect(page.getByText('wave-tail-paused', { exact: true })).toHaveCount(1)
      await silence('paused-before-endpoint')
      await evaluate(page, 'waveTailState()', 'play,stop||0')
      await evaluate(page, 'int(tailCurrent.samplePosition==tailHeldPosition)', '1')
      // Arm the passive side-tap before the real click. The complete capture
      // must contain the first music, then its successor; readyState, a label
      // alone, and a silent sample buffer cannot satisfy this observation.
      await beginPhaseCapture(page, 3)
      await click(30)
      await expect(page.getByText('wave-tail-play:play', { exact: true })).toHaveCount(1)
      const output = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'actual-endpoint-music-handoff', output,
        { first: [0.25, -0.5], next: [0.5, 0.125], nativeLabelPosition: 48000, sourceRate: 48000 })
      expect(output.channels).toHaveLength(2)
      const [left, right] = output.channels
      expect(left!.length).toBe(Math.ceil(output.sampleRate * 3)); expect(right!.length).toBe(left!.length)
      let phase: 'waiting' | 'first' | 'gap' | 'next' = 'waiting', firstFrames = 0, nextFrames = 0, gapFrames = 0
      for (let i = 0; i < left!.length; i++) {
        const l = left![i]!, r = right![i]!
        if (l === 0.25 && r === -0.5) {
          if (phase !== 'waiting' && phase !== 'first')
            throw new Error(`First file reappeared at capture frame ${i}: ${l},${r}, phase=${phase}`)
          phase = 'first'; firstFrames++
        } else if (l === 0.5 && r === 0.125) {
          if (!firstFrames) throw new Error(`Next file preceded the first at capture frame ${i}: ${l},${r}`)
          phase = 'next'; nextFrames++
        } else {
          // The explicit files do not overlap. A callback/next decoder page
          // boundary may be silent, but every observed channel must remain
          // exactly zero there, and no silence may reappear in the looped next file.
          if (l !== 0 || r !== 0 || phase === 'next')
            throw new Error(`Invalid handoff sample at capture frame ${i}: ${l},${r}, phase=${phase}`)
          if (phase === 'first' || phase === 'gap') { phase = 'gap'; gapFrames++ }
        }
      }
      expect(firstFrames).toBeGreaterThan(output.sampleRate * 0.75)
      expect(nextFrames).toBeGreaterThan(output.sampleRate * 0.25)
      expect(phase).toBe('next')
      await info.attach('wave-tail-phase-counts', { contentType: 'application/json', body: JSON.stringify({
        firstFrames, nextFrames, gapFrames, sampleRate: output.sampleRate,
        scope: 'Every captured stereo sample compared exactly; no hardware gapless-playback claim.',
      }) })
      await expect(page.getByText('wave-tail-next:play', { exact: true })).toHaveCount(1)
      await evaluate(page, 'waveTailState()', 'stop,play|head,tail,stop|1')
      await evaluate(page, '[tailCurrent.samplePosition,tailCurrent.position,tailStopPositions.join(",")].join("|")', '0|0|0:0')
      await beginPhaseCapture(page, 0.2)
      const steady = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'steady-next-file', steady, { expected: [0.5, 0.125] })
      expect(steady.channels[0]).toEqual(Array(Math.ceil(steady.sampleRate * 0.2)).fill(0.5))
      expect(steady.channels[1]).toEqual(Array(Math.ceil(steady.sampleRate * 0.2)).fill(0.125))
      await click(150)
      await expect(page.getByText('wave-tail-manual:stop,stop,1', { exact: true })).toHaveCount(1)
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await silence('manual-stop-of-next-file')
      await expect(page.getByText('wave-tail-next:play', { exact: true })).toHaveCount(1)

      // Replay through a real menu button, this time choosing the successor
      // from onStatusChanged only after both public cursors have reset to zero.
      // A tail event alone cannot make this route audible.
      await beginPhaseCapture(page, 3)
      await click(30)
      await expect(page.getByText('wave-stop-route-started', { exact: true })).toHaveCount(1)
      const completed = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'zero-cursor-stop-callback-handoff', completed,
        { first: [.25, -.5], next: [.5, .125], expectedStoppedPosition: 0 })
      expect(completed.channels).toHaveLength(2)
      const [first, second] = completed.channels
      expect(first).toHaveLength(Math.ceil(completed.sampleRate * 3)); expect(second).toHaveLength(first!.length)
      let completedPhase = 0, completedFirst = 0, completedNext = 0
      for (let frame = 0; frame < first!.length; frame++) {
        const l = first![frame]!, r = second![frame]!
        if (l === .25 && r === -.5 && completedPhase <= 1) { completedPhase = 1; completedFirst++ }
        else if (l === .5 && r === .125 && completedFirst > 0) { completedPhase = 3; completedNext++ }
        else if (l === 0 && r === 0 && completedPhase < 3) { if (completedPhase === 1) completedPhase = 2 }
        else throw new Error(`Stop-callback handoff frame ${frame}: ${l},${r}, phase=${completedPhase}`)
      }
      expect(completedFirst).toBeGreaterThan(completed.sampleRate * .75)
      expect(completedNext).toBeGreaterThan(completed.sampleRate * .25)
      expect(completedPhase).toBe(3)
      await expect(page.getByText('wave-stop-next:play', { exact: true })).toHaveCount(1)
      await evaluate(page, 'waveTailState()+"|"+tailStopPositions.join(",")', 'stop,play|head,tail,stop|1|0:0')
      await info.attach('wave-stop-menu', { body: await canvas.screenshot(), contentType: 'image/png' })
      await click(150)
      await expect(page.getByText('wave-tail-manual:stop,stop,1', { exact: true })).toHaveCount(2)
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await silence('manual-stop-after-completion-route')
      await evaluate(page, 'waveTailClose()', 'closed')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-tail-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Real endpoint music handoff or cleanup failed', { cause: failures[0] })
  })
