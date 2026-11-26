import { expect, test } from '@playwright/test'
import { mp3Game, mp3Reference, type Mp3Variant } from '../helpers/cdda-mp3.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture, endPhaseCapture,
  attachPhaseCapture, nativePhasePosition, type CapturedPhaseAudio } from '../helpers/web-phase-vocoder.ts'

function amplitude(samples: ArrayLike<number>, rate: number, frequency: number) {
  let real = 0, imaginary = 0
  for (let at = 0; at < samples.length; at++) {
    const angle = 2 * Math.PI * frequency * at / rate, value = samples[at]!
    real += value * Math.cos(angle); imaginary += value * Math.sin(angle)
  }
  return 2 * Math.hypot(real, imaginary) / samples.length
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: game buttons play CBR and VBR MP3 disc tracks with real seek, pause and looping`, async ({ page }, info) => {
    test.setTimeout(150000)
    const errors: string[] = [], failures: unknown[] = [], observations: unknown[] = []
    let capturing = false, voiceId: number | undefined, eventsThrough = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto('/?backend=' + backend)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const reference = mp3Reference(), canvas = page.locator('.game-window').filter({
      has: page.locator('.game-window-title', { hasText: /^Compressed CD music$/ }),
    }).locator('canvas[data-window-id]')
    const click = async (x: number, marker: string) => {
      const point = await pointerPixel(canvas, x, 30)
      await page.mouse.click(point.x, point.y)
      await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 15000 })
    }, recordEvents = (capture: CapturedPhaseAudio) => {
      const range = capture.eventRange
      expect(range).toBeDefined(); expect(range!.gapStart).toBe(eventsThrough)
      expect(range!.start - range!.gapStart).toBe(capture.gapEvents!.length)
      expect(range!.end - range!.start).toBe(capture.events.length)
      for (const { message } of [...capture.gapEvents!, ...capture.events])
        if (message.type === 'event' && message.event.type === 'error') throw new Error(message.event.message)
      eventsThrough = range!.end
    }, listen = async (variant: Mp3Variant, track: number, phase: 'opening' | 'resume' | 'seek' | 'loop') => {
      const odd = track % 2 === 1, windowName = phase === 'seek' ? odd ? 'change40' : 'far100' : odd ? 'opening' : 'track2',
        window = variant.windows.find((row) => row.name === windowName)!, expected = reference.windows.get(window.file)!,
        offset = windowName === 'change40' || windowName === 'track2' ? 66150 : 22050,
        before = (await nativePhasePosition(page)).snapshot
      voiceId = before.id
      expect(before.status).toBe('play'); expect(before.paused).toBe(false)
      expect(before.sampleRate).toBe(44100); expect(before.channels).toBe(2); expect(before.bits).toBe(32)
      expect(before.sampleCount).toBe(odd ? 2646000 : 2646137)
      expect(before.looping).toBe(true)
      await beginPhaseCapture(page, .5, { positionVoiceOnComplete: before.id })
      const capture = await endPhaseCapture(page), after = capture.completionPosition?.observation?.snapshot,
        metrics = await attachPhaseCapture(info, `mp3-track-${track}-${phase}`, capture,
          { variant: variant.name, track, phase, before, referenceFile: window.file,
            referenceFrames: [window.start + offset, window.start + offset + 22050] })
      recordEvents(capture)
      expect(capture.completionPosition?.error).toBeUndefined(); expect(after).toBeDefined()
      expect(after!.id).toBe(before.id); expect(after!.status).toBe('play'); expect(after!.paused).toBe(false)
      expect(after!.position).toBeGreaterThanOrEqual(0); expect(after!.position).toBeLessThan(after!.sampleCount)
      expect(capture.channels).toHaveLength(2); expect(expected).toHaveLength(2)
      const spectra: unknown[] = []
      observations.push({ variant: variant.name, track, phase, before, after, metrics, spectra })
      for (const channel of [0, 1]) {
        const actual = capture.channels[channel]!, wanted = expected[channel]!.subarray(offset, offset + 22050)
        expect(actual).toHaveLength(Math.ceil(capture.sampleRate * .5)); expect(wanted).toHaveLength(22050)
        expect(actual.every(Number.isFinite)).toBe(true); expect([...wanted].every(Number.isFinite)).toBe(true)
        expect(metrics[channel]!.nonfinite).toBe(0); expect(metrics[channel]!.audibleSeconds).toBeGreaterThan(.4)
        for (const frequency of [440, 550, 660, 880]) {
          const observed = amplitude(actual, capture.sampleRate, frequency), target = amplitude(wanted, 44100, frequency)
          spectra.push({ channel, frequency, observed, expected: target })
          expect(Math.abs(observed - target), `${variant.name}/${track}/${phase}, channel ${channel}, ${frequency} Hz`).toBeLessThan(.005)
        }
      }
      return after!
    }, silence = async (label: string) => {
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await beginPhaseCapture(page, .2)
      const capture = await endPhaseCapture(page)
      await attachPhaseCapture(info, label, capture); recordEvents(capture)
      expect(capture.channels).toHaveLength(2)
      for (const channel of capture.channels) {
        expect(channel).toHaveLength(Math.ceil(capture.sampleRate * .2))
        expect(channel).toEqual(Array(channel.length).fill(0))
      }
    }
    try {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#files').setInputFiles({ name: 'data.xp3', mimeType: 'application/octet-stream',
        buffer: xp3Fixture(mp3Game(binary, reference.files)).bytes })
      await expect(page.getByText('mp3-ready', { exact: true })).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      for (const track of [1, 2, 3, 4]) {
        const variant = reference.manifest.variants.find((row) => row.name === (track <= 2 ? 'cbr' : 'vbr'))!
        await click(40, `mp3-choice:${track}:${track}:play:${track % 2 ? 60000 : 60003}`)
        if (!capturing) { await openPhaseCapture(page); capturing = true }
        await listen(variant, track, 'opening')
        if (track === 1) {
          await click(200, 'mp3-pause:1:1')
          const paused = (await nativePhasePosition(page, voiceId)).snapshot
          expect(paused.paused).toBe(true)
          await silence('mp3-actual-pause')
          expect((await nativePhasePosition(page, voiceId)).snapshot.position).toBe(paused.position)
          await click(200, 'mp3-pause:2:0')
          await listen(variant, track, 'resume')
        }
        await click(120, `mp3-seek:${track}`)
        const sought = await listen(variant, track, 'seek')
        expect(sought.position).toBeGreaterThanOrEqual(40 * 44100)
        expect(sought.position).toBeLessThan(45 * 44100)
        await click(280, `mp3-loop:${track}`)
        await expect.poll(async () => (await nativePhasePosition(page, voiceId)).snapshot.position, { timeout: 5000 }).toBeLessThan(44100)
        const looped = await listen(variant, track, 'loop')
        expect(looped.position).toBeLessThan(3 * 44100)
      }
      await click(360, 'mp3-stop:0')
      await evaluate(page, 'mp3Music.status+"|"+mp3Music.samplePosition', 'stop|0')
      await silence('mp3-actual-stop')
      expect((await nativePhasePosition(page, voiceId)).snapshot.status).toBe('stop')
      await info.attach('mp3-cue-game-menu', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('mp3-cue-game-observations', { body: JSON.stringify({ backend, binary,
      reference: reference.manifest, observations, errors, eventsThrough, logs: await page.locator('#logs').innerText(),
      scope: 'Real CDDASoundBuffer buttons and AudioWorklet output on two ordinary MP3 CUE files/four tracks. Stereo frequency amplitudes compare with independent FFmpeg gapless windows; 0.005 permits different decoders/resampling. Pause/stop require every captured sample zero. No bit-exact cross-decoder claim.' }, null, 2), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MP3 disc game or cleanup failed', { cause: failures[0] })
  })
