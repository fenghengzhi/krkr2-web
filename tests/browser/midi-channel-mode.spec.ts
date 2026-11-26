import { expect, test } from '@playwright/test'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { midiChannelModeFiles, midiChannelModeSource } from '../helpers/midi-channel-mode.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

// Authored A4/E5 notes: a chord in poly mode, only E5 after mono releases the
// previous note (including a damper-held A4). This is not a GS sound-bank oracle.
const stages = [
  { name: 'polyphonic-chord', chord: true }, { name: 'monophonic-lead', chord: false },
  { name: 'monophonic-damper', chord: false }, { name: 'polyphonic-restored', chord: true },
]

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: game music buttons switch real SMF chords and solo leads without leaving damper notes sounding`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^MIDI solo and chord$/ }) }).locator('canvas[data-window-id]')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("mode.tjs","savedata/mode.cjs",false,true,false);Scripts.execStorage("savedata/mode.cjs");modeMenu();'
          : 'Scripts.execStorage("mode.tjs");modeMenu();') },
        { name: 'mode.tjs', mimeType: 'text/plain', buffer: Buffer.from(midiChannelModeSource) },
        ...Object.entries(midiChannelModeFiles()).map(([name, bytes]) => ({ name, mimeType: 'audio/midi', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('channel-mode-ready', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      for (const [stage, expected] of stages.entries()) {
        if (stage) {
          const point = await pointerPixel(canvas, 80, 30); await page.mouse.click(point.x, point.y)
          await expect(page.getByText(`channel-mode-step:${stage}:play`, { exact: true })).toHaveCount(1)
        }
        // Wait on the actual song clock, not wall time: mono's existing .09s
        // release envelope has fully retired A4 before this observation.
        await expect.poll(async () => (await nativePhasePosition(page)).snapshot.position).toBeGreaterThan(52920)
        const before = await nativePhasePosition(page)
        expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
        await beginPhaseCapture(page, .5, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page), after = output.completionPosition?.observation?.snapshot
        await attachPhaseCapture(info, `channel-mode-${stage}-${expected.name}`, output, { before, after, expected,
          scope: 'Real Worklet stereo PCM and independent A4/E5 spectral energy; no Windows hardware/timbre equivalence.' })
        expect(output.completionPosition?.error).toBeUndefined(); expect(after).toBeDefined()
        expect(after!.id).toBe(before.snapshot.id); expect(after!.position).toBeGreaterThan(before.snapshot.position)
        expect(output.channels).toHaveLength(2)
        const [left, right] = output.channels
        expect(left).toHaveLength(Math.ceil(output.sampleRate * .5)); expect(right).toEqual(left)
        let weight = 0
        const frequencies = [440, 659.2551138257398], real = [0, 0], imaginary = [0, 0]
        for (let frame = 0; frame < left!.length; frame++) {
          const value = left![frame]!
          if (!Number.isFinite(value)) throw new Error(`Nonfinite channel-mode PCM at ${stage}/${frame}`)
          const window = .5 - .5 * Math.cos(2 * Math.PI * frame / (left!.length - 1))
          weight += window
          for (let tone = 0; tone < 2; tone++) {
            const angle = 2 * Math.PI * frequencies[tone]! * frame / output.sampleRate
            real[tone]! += value * window * Math.cos(angle); imaginary[tone]! += value * window * Math.sin(angle)
          }
        }
        const amplitude = real.map((value, at) => 2 * Math.hypot(value, imaginary[at]!) / weight)
        expect(amplitude[1]).toBeGreaterThan(.01)
        if (expected.chord) expect(Math.abs(amplitude[0]! / amplitude[1]! - 1)).toBeLessThan(.001)
        else expect(amplitude[0]! / amplitude[1]!).toBeLessThan(.0001)
        observations.push({ stage, expected, before, after, amplitude })
      }
      await expect(page.locator('.game-text-input')).toBeFocused(); await page.keyboard.press('Escape')
      await expect(page.getByText('channel-mode-stopped', { exact: true })).toHaveCount(1)
      await beginPhaseCapture(page, .1)
      const stopped = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'channel-mode-stopped', stopped)
      for (const channel of stopped.channels) expect(channel).toEqual(Array(channel.length).fill(0))
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('midi-channel-mode-observations', { body: JSON.stringify({ observations, errors,
      logs: await page.locator('#logs').innerText() }), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'MIDI mono/poly playback or cleanup failed', { cause: failures[0] })
  })
