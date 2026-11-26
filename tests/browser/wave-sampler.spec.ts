import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { waveSamplerGameFiles, waveSamplerSource } from '../helpers/wave-sampler.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, type CapturedPhaseAudio } from '../helpers/web-phase-vocoder.ts'

const frequencies = [500, 1000, 1500] as const
function observePhrases(output: CapturedPhaseAudio) {
  const [left, right] = output.channels
  expect(output.channels).toHaveLength(2); expect(right).toHaveLength(left!.length)
  for (let frame = 0; frame < left!.length; frame++) {
    const l = left![frame]!, r = right![frame]!
    if (!Number.isFinite(l) || r !== -l)
      throw new Error(`Stereo PCM differs at frame ${frame}: ${l},${r}`)
  }
  const rows: { at: number; frequency: number; amplitude: number }[] = []
  for (let window = 0; ; window++) {
    const at = Math.round(window * output.sampleRate / 10), end = Math.round((window + 1) * output.sampleRate / 10)
    if (end > left!.length) break
    const frames = end - at
    const amplitudes = frequencies.map((frequency) => {
      let real = 0, imaginary = 0
      for (let frame = 0; frame < frames; frame++) {
        const angle = 2 * Math.PI * frequency * frame / output.sampleRate, sample = left![at + frame]!
        real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle)
      }
      return Math.hypot(real, imaginary) * 2 / frames
    }), amplitude = Math.max(...amplitudes)
    rows.push({ at, frequency: frequencies[amplitudes.indexOf(amplitude)]!, amplitude })
  }
  return rows
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a game hears all three WAV phrases despite sampler metadata and switches to an explicit SLI phrase`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Whole song and explicit phrase$/ }) }).locator('canvas[data-window-id]'),
      click = async (x: number, marker: string) => {
        const box = await canvas.boundingBox(); expect(box).not.toBeNull()
        await canvas.click({ position: { x: x * box!.width / 240, y: 30 * box!.height / 60 }, timeout: 5000 })
        await expect(page.getByText(marker, { exact: true })).toBeVisible()
      }, whole = async (name: string) => {
        await beginPhaseCapture(page, 3)
        const output = await endPhaseCapture(page), rows = observePhrases(output), sequence: number[] = []
        await attachPhaseCapture(info, name, output, { rows, frequencies, sectionSeconds: .5, samplerOnly: 1000 })
        expect(rows).toHaveLength(30)
        for (const row of rows) {
          expect(row.amplitude).toBeGreaterThan(.18)
          if (sequence.at(-1) !== row.frequency) sequence.push(row.frequency)
        }
        for (const frequency of frequencies) expect(rows.filter((row) => row.frequency === frequency).length).toBeGreaterThanOrEqual(6)
        expect(sequence.length).toBeGreaterThanOrEqual(6)
        for (let index = 1; index < sequence.length; index++)
          expect(sequence[index]).toBe(frequencies[(frequencies.indexOf(sequence[index - 1] as (typeof frequencies)[number]) + 1) % 3])
        await evaluate(page, 'samplerSound.status+":"+samplerSound.looping', 'play:1')
      }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("sampler.tjs","savedata/sampler.cjs",false,true,false);Scripts.execStorage("savedata/sampler.cjs");samplerMenu();'
          : 'Scripts.execStorage("sampler.tjs");samplerMenu();') },
        { name: 'sampler.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveSamplerSource) },
        ...Object.entries(waveSamplerGameFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('sampler-menu-ready', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      await whole('actual-whole-song-loop')

      await beginPhaseCapture(page, 3)
      await click(118, 'sampler-finish')
      const finishing = await endPhaseCapture(page), finishingRows = observePhrases(finishing)
      await attachPhaseCapture(info, 'disabled-loop-plays-remaining-tail', finishing, { rows: finishingRows, seekFrame: 36000, sourceRate: 48000 })
      expect(finishingRows.some((row) => row.frequency === 1500 && row.amplitude > .3)).toBe(true)
      for (const plane of finishing.channels)
        expect(plane.slice(-Math.round(finishing.sampleRate / 5))).toEqual(Array(Math.round(finishing.sampleRate / 5)).fill(0))
      await evaluate(page, 'samplerSound.status+":"+samplerSound.looping', 'stop:0')

      await click(198, 'sampler-phrase')
      // Retain the real transition audio too; the public seek requests its
      // destination pages before the following steady SLI observation.
      await beginPhaseCapture(page, .4)
      await attachPhaseCapture(info, 'explicit-phrase-entry', await endPhaseCapture(page))
      await beginPhaseCapture(page, 1)
      const phrase = await endPhaseCapture(page), phraseRows = observePhrases(phrase)
      await attachPhaseCapture(info, 'explicit-sli-third-phrase', phrase, { rows: phraseRows })
      for (const row of phraseRows) { expect(row.frequency).toBe(1500); expect(row.amplitude).toBeGreaterThan(.45) }
      await evaluate(page, 'samplerSound.status+":"+samplerSound.looping', 'play:0')
      await click(38, 'sampler-whole'); await whole('whole-song-restored-after-sli')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-sampler-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave sampler music playback or cleanup failed', { cause: failures[0] })
  })
