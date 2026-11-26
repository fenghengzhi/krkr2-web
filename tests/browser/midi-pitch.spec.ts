import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { midiPitchFiles, midiPitchSource } from '../helpers/midi-pitch.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

// Independent audible expectations for the helper's authored MIDI controls.
// In the stock Windows GS profile coarse/fine tuning is captured at note-on;
// the wheel and CC121 act on the sounding note. No synthesizer code supplies
// this frequency oracle, and the observer only copies real Worklet output.
const stages = [
  { name: 'initial-note', hz: 440 },
  { name: 'coarse-change-held-note', hz: 440 },
  { name: 'coarse-new-note', hz: 880 },
  { name: 'wheel-held-note', hz: 440 },
  { name: 'controllers-reset-held-note', hz: 880 },
  { name: 'lower-new-note', hz: 220 },
  { name: 'fine-new-note', hz: 415.3046975799451 },
  { name: 'module-reset-new-note', hz: 440 },
] as const

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real music buttons tune new notes while held notes keep stock GS tuning`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [],
      files = midiPitchFiles(), source = midiPitchSource + '\npitchMenu();'
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({
      has: page.locator('.game-window-title', { hasText: /^MIDI musical tuning$/ }),
    }).locator('canvas[data-window-id]')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("pitch.tjs","savedata/pitch.cjs",false,true,false);Scripts.execStorage("savedata/pitch.cjs");'
          : 'Scripts.execStorage("pitch.tjs");') },
        { name: 'pitch.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
        ...Object.entries(files).map(([name, bytes]) => ({ name, mimeType: 'audio/midi', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('pitch-menu-ready', { exact: true })).toBeVisible()
      await expect(canvas).toBeVisible()
      await expect(canvas).toHaveJSProperty('width', 160)
      await expect(canvas).toHaveJSProperty('height', 60)
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await openPhaseCapture(page)
      for (const [stage, expected] of stages.entries()) {
        if (stage) {
          await canvas.scrollIntoViewIfNeeded()
          const point = await pointerPixel(canvas, 80, 30)
          await page.mouse.click(point.x, point.y)
          await expect(page.getByText(`pitch-step:${stage}:play`, { exact: true })).toHaveCount(1)
          observations.push({ stage, input: 'real Next click', point })
        }
        const before = await nativePhasePosition(page)
        expect(before.snapshot.status).toBe('play')
        expect(before.snapshot.paused).toBe(false)
        await beginPhaseCapture(page, .5, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page),
          metrics = await attachPhaseCapture(info, `midi-pitch-${stage}-${expected.name}`, output,
            { stage, expectedHz: expected.hz, before, scope: 'Actual application Worklet PCM; independent 1-Hz DFT peak.' }),
          after = output.completionPosition?.observation?.snapshot
        observations.push({ stage, expected, before, after, metrics })
        expect(output.completionPosition?.error).toBeUndefined()
        expect(after).toBeDefined()
        expect(after!.id).toBe(before.snapshot.id)
        expect(after!.status).toBe('play'); expect(after!.paused).toBe(false)
        expect(after!.position).toBeGreaterThan(before.snapshot.position)
        expect(output.channels).toHaveLength(2)
        expect(output.channels[0]).toHaveLength(Math.ceil(output.sampleRate * .5))
        expect(output.channels[1]).toEqual(output.channels[0])
        for (const channel of metrics) {
          expect(channel.nonfinite).toBe(0)
          expect(channel.rms).toBeGreaterThan(.001)
          expect(channel.spectrum.count).toBe(8192)
          expect(Math.abs(channel.spectrum.peakHz - expected.hz), expected.name).toBeLessThanOrEqual(1)
        }
      }
      // The helper's real Escape action stops the music without destroying
      // the application AudioContext, so silence remains directly observable.
      await expect(page.locator('.game-text-input')).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByText('pitch-stopped', { exact: true })).toHaveCount(1)
      await beginPhaseCapture(page, .1)
      const stopped = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'midi-pitch-game-stopped', stopped, { input: 'real Escape key' })
      expect(stopped.channels).toHaveLength(2)
      for (const channel of stopped.channels) {
        expect(channel).toHaveLength(Math.ceil(stopped.sampleRate * .1))
        expect(channel).toEqual(Array(channel.length).fill(0))
      }
      observations.push({ stoppedBy: 'Escape', frames: stopped.channels[0]!.length })
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('midi-pitch-game', { contentType: 'application/json', body: JSON.stringify({
        source, stages, observations, errors,
        files: Object.entries(files).map(([name, bytes]) => ({ name, bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') })),
        logs: await page.locator('#logs').innerText(),
        scope: 'Eight real Worklet captures separated only by the game Next button. Coarse tuning of a held note must remain 440 Hz until the helper restarts the note; pitch wheel and CC121 then update that held note. This is the documented Web stock-GS compatibility profile, not a recording of Windows device timbre.' }, null, 2) })
    } catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MIDI pitch game or cleanup failed', { cause: failures[0] })
  })
