import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { waveFrequencyExpected, waveFrequencyFiles, waveFrequencySource } from '../helpers/wave-frequency.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture, endPhaseCapture,
  attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: Wave frequency zero restores each real file's original audible rate through the Worker`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("frequency.tjs","savedata/frequency.cjs",false,true,false);Scripts.execStorage("savedata/frequency.cjs");'
          : 'Scripts.execStorage("frequency.tjs");') },
        { name: 'frequency.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveFrequencySource) },
        ...Object.entries(waveFrequencyFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('wave-frequency-ready', { exact: true })).toBeVisible()
      await evaluate(page, 'waveFrequencyObserve()', waveFrequencyExpected)
      await evaluate(page, '(function(){global.fqMusic=new WaveSoundBuffer(null);fqMusic.open("frequency-tone.wav");fqMusic.looping=true;fqMusic.frequency=16000;fqMusic.play();return fqMusic.frequency;})()', '16000')
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      // This established helper taps the actual application mixer output into
      // a copy-only worklet. It neither synthesizes expected PCM nor changes
      // the voice's frequency, pause or source position.
      await openPhaseCapture(page)
      const capture = async (name: string, expectedHz: number, publicFrequency: number, inputRate: number) => {
        const before = await nativePhasePosition(page)
        expect(before.snapshot.frequency).toBe(publicFrequency)
        expect(before.snapshot.sampleRate).toBe(inputRate)
        await beginPhaseCapture(page, 0.5, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page), metrics = await attachPhaseCapture(info, name, output,
          { before, publicFrequency, inputRate, expectedHz })
        expect(output.completionPosition?.error).toBeUndefined()
        expect(output.completionPosition?.observation?.snapshot.frequency).toBe(publicFrequency)
        expect(output.completionPosition?.observation?.snapshot.sampleRate).toBe(inputRate)
        for (const channel of metrics) {
          expect(channel.nonfinite).toBe(0)
          expect(channel.rms).toBeGreaterThan(0.1)
          expect(channel.spectrum.count).toBeGreaterThanOrEqual(8192)
          // The observer reports a 1-Hz DFT peak. Exact source samples and
          // positions are independently checked by the hosted Node consumer.
          expect(Math.abs(channel.spectrum.peakHz - expectedHz)).toBeLessThanOrEqual(1)
        }
      }
      await capture('frequency-double', 1000, 16000, 8000)
      await evaluate(page, '(fqMusic.frequency=0,fqMusic.frequency)', '0')
      await capture('frequency-original', 500, 0, 8000)
      await evaluate(page, '(fqMusic.frequency=4000,fqMusic.frequency)', '4000')
      await capture('frequency-half', 250, 4000, 8000)
      await evaluate(page, '(fqMusic.frequency=4294967296,fqMusic.frequency)', '0')
      await capture('frequency-narrowed-original', 500, 0, 8000)
      await evaluate(page, '(fqMusic.open("frequency-other-tone.wav"),fqMusic.frequency)', '16000')
      await evaluate(page, '(fqMusic.frequency=0,fqMusic.play(),fqMusic.frequency)', '0')
      await capture('frequency-reopened-original', 750, 0, 16000)
      await evaluate(page, '(fqMusic.paused=true,fqMusic.samplePosition=160,fqMusic.frequency=0,fqMusic.samplePosition)', '160')
      await beginPhaseCapture(page, 0.1)
      const paused = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'frequency-paused', paused)
      expect(paused.channels.every((channel) => channel.every((sample) => sample === 0))).toBe(true)
      await evaluate(page, '[fqMusic.frequency,fqMusic.samplePosition].join(",")', '0,160')
      await evaluate(page, '(invalidate fqMusic,int(!isvalid fqMusic))', '1')
      await expect.poll(() => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value)).toBe(0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-frequency-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave frequency browser or cleanup failed', { cause: failures[0] })
  })
