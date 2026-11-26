import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { loadVorbisSpeakers, vorbisSpeakerCases, vorbisSpeakerFiles, vorbisSpeakerSource,
  type VorbisSpeakerCase } from '../helpers/vorbis-speakers.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition,
  type CapturedPhaseAudio } from '../helpers/web-phase-vocoder.ts'

// Compare tone amplitudes without requiring decoder phase alignment. The input is the
// separately decoded FFmpeg stereo file, never the production mixer output.
function amplitude(samples: ArrayLike<number>, rate: number, frequency: number): number {
  let real = 0, imaginary = 0
  for (let at = 0; at < samples.length; at++) {
    const angle = 2 * Math.PI * frequency * at / rate, value = samples[at]!
    real += value * Math.cos(angle); imaginary += value * Math.sin(angle)
  }
  return 2 * Math.hypot(real, imaginary) / samples.length
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real surround Ogg music keeps rear, side and center speakers through game pause and SLI seek`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    let capturing = false, deliveredEvents = 0, deliveredLabels = 0, voiceId: number | undefined
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({
      has: page.locator('.game-window-title', { hasText: /^Surround Ogg music$/ }),
    }).locator('canvas[data-window-id]')
    const click = async (x: number, marker: string) => {
      const point = await pointerPixel(canvas, x, 30)
      await page.mouse.click(point.x, point.y)
      await expect(page.getByText(marker, { exact: true })).toBeVisible()
    }
    const recordEvents = (output: CapturedPhaseAudio) => {
      const range = output.eventRange
      expect(range).toBeDefined(); expect(range!.gapStart).toBe(deliveredEvents)
      expect(range!.start - range!.gapStart).toBe(output.gapEvents!.length)
      expect(range!.end - range!.start).toBe(output.events.length)
      for (const { message } of [...output.gapEvents!, ...output.events]) {
        if (message.type === 'event' && message.event.type === 'error') throw new Error(message.event.message)
        if (message.type === 'event' && message.event.type === 'label') {
          expect(message.event.label).toBe('phrase'); deliveredLabels++
        }
      }
      deliveredEvents = range!.end
    }
    const capture = async (entry: VorbisSpeakerCase, label: string) => {
      const reference = loadVorbisSpeakers(entry), start = 24000 - reference.decodedStart,
        before = (await nativePhasePosition(page, voiceId)).snapshot
      voiceId = before.id
      expect(before.status).toBe('play'); expect(before.paused).toBe(false)
      expect(before.channels).toBe(entry.channels); expect(before.sampleRate).toBe(48000)
      expect(Number.isSafeInteger(start)).toBe(true); expect(start).toBeGreaterThanOrEqual(0)
      expect(reference.stereo).toHaveLength(2)
      await beginPhaseCapture(page, .5, { positionVoiceOnComplete: before.id })
      const output = await endPhaseCapture(page), metrics = await attachPhaseCapture(info, label, output, {
        source: entry.name, sourceChannels: entry.channels, sourceMask: entry.mask,
        decodedStart: reference.decodedStart, referenceGlobalWindow: [24000, 48000], before,
      }), after = output.completionPosition?.observation?.snapshot
      recordEvents(output)
      expect(output.completionPosition?.error).toBeUndefined(); expect(after).toBeDefined()
      expect(after!.id).toBe(before.id); expect(after!.status).toBe('play'); expect(after!.paused).toBe(false)
      expect(after!.channels).toBe(entry.channels)
      expect(output.channels).toHaveLength(2)
      const spectra: unknown[] = []
      observations.push({ label, before, after, sampleRate: output.sampleRate, metrics, spectra })
      for (const channel of [0, 1]) {
        const actual = output.channels[channel]!, expected = reference.stereo[channel]!.subarray(start, start + 24000)
        expect(actual).toHaveLength(Math.ceil(output.sampleRate * .5)); expect(expected).toHaveLength(24000)
        expect(actual.every(Number.isFinite)).toBe(true); expect([...expected].every(Number.isFinite)).toBe(true)
        expect(metrics[channel]!.nonfinite).toBe(0)
        for (const frequency of entry.frequencies) {
          const wanted = amplitude(expected, 48000, frequency), observed = amplitude(actual, output.sampleRate, frequency)
          spectra.push({ channel, frequency, expected: wanted, actual: observed })
          expect(Math.abs(observed - wanted), `${label}, channel ${channel}, ${frequency} Hz`).toBeLessThanOrEqual(.002)
        }
      }
      return after!
    }
    const silence = async (label: string) => {
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await beginPhaseCapture(page, .2)
      const output = await endPhaseCapture(page)
      await attachPhaseCapture(info, label, output)
      recordEvents(output)
      expect(output.channels).toHaveLength(2)
      for (const channel of output.channels) {
        expect(channel).toHaveLength(Math.ceil(output.sampleRate * .2))
        expect(channel).toEqual(Array(channel.length).fill(0))
      }
    }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("surround.tjs","savedata/surround.cjs",false,true,false);Scripts.execStorage("savedata/surround.cjs");vorbisMenu();'
          : 'Scripts.execStorage("surround.tjs");vorbisMenu();') },
        { name: 'surround.tjs', mimeType: 'text/plain', buffer: Buffer.from(vorbisSpeakerSource) },
        ...Object.entries(vorbisSpeakerFiles()).map(([name, bytes]) => ({
          name, mimeType: name.endsWith('.ogg') ? 'audio/ogg' : 'text/plain', buffer: Buffer.from(bytes),
        })),
      ])
      await expect(page.getByText('vorbis-menu-ready', { exact: true })).toBeVisible()
      await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      for (const [index, entry] of vorbisSpeakerCases.entries()) {
        await click(38, `vorbis-track:${index + 1}:${entry.name}`)
        await evaluate(page, 'vorbisMusic.channels+"|"+vorbisMusic.status', `${entry.channels}|play`)
        if (!capturing) { await openPhaseCapture(page); capturing = true }
        await capture(entry, entry.name + '-independent-stereo')
        if (index === 0) {
          await click(118, 'vorbis-pause:1')
          const paused = (await nativePhasePosition(page, voiceId)).snapshot
          expect(paused.paused).toBe(true)
          await silence('five-real-pause')
          expect((await nativePhasePosition(page, voiceId)).snapshot.position).toBe(paused.position)
          await click(118, 'vorbis-pause:0'); await capture(entry, 'five-real-resume')
          const labelsBefore = deliveredLabels
          await click(198, 'vorbis-seek:0')
          const after = await capture(entry, 'five-seek-through-SLI')
          expect(after.position).toBeGreaterThanOrEqual(24000); expect(after.position).toBeLessThan(72000)
          expect(deliveredLabels).toBeGreaterThan(labelsBefore)
          await evaluate(page, 'vorbisLabels>0', '1')
        }
      }
      await info.attach('surround-ogg-menu', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await canvas.focus()
      await expect(page.locator('#stage textarea.game-text-input')).toBeFocused()
      await page.keyboard.press('Escape', { delay: 200 })
      await expect(page.getByText('vorbis-stopped', { exact: true })).toBeVisible()
      await evaluate(page, 'vorbisMusic.status', 'stop')
      await silence('escape-stopped-surround-music')
      expect((await nativePhasePosition(page, voiceId)).snapshot.status).toBe('stop')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('vorbis-speaker-game', { body: JSON.stringify({ backend, binary, observations, errors,
        deliveredEvents, deliveredLabels, logs: await page.locator('#logs').innerText(),
        scope: 'Real game buttons and native WaveSoundBuffer on the real AudioWorklet. Every captured sample is finite; stereo frequency amplitudes compare with independent FFmpeg stereo bytes at source 0.5–1s, allowing 0.002 for decoder/resampler differences. This is not a bit-exact cross-decoder PCM claim.' }, null, 2), contentType: 'application/json' })
    } catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Vorbis speaker game or cleanup failed', { cause: failures[0] })
  })
