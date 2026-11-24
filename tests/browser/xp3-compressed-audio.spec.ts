import { expect, test } from '@playwright/test'
import { httpServer } from '../helpers/http-server.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { createLongCompressedXp3, xp3AudioRegions, xp3CompressedAudioHeader, xp3SegmentScript } from '../helpers/xp3-segment-fixtures.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture, endPhaseCapture,
  attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a single XP3 zlib segment above 64 MiB plays distinct WAVE ranges and releases them`, async ({ page }, info) => {
    test.setTimeout(150000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await createLongCompressedXp3({ startup: (binary
      ? 'Scripts.compileStorage("compressed-audio.tjs","savedata/compressed-audio.cjs",false,true,false);Scripts.execStorage("savedata/compressed-audio.cjs");'
      : 'Scripts.execStorage("compressed-audio.tjs");') + '\nDebug.message("xp3-compressed-ready");' }),
      server = await httpServer({ '/compressed-audio.xp3': { bytes: fixture.bytes, etag: '"xp3-compressed-129"' } }),
      meter = page.locator('#sound-level')
    try {
      const wave = fixture.entries.find((entry) => entry.name === fixture.waveName)!
      expect(wave.size).toBeGreaterThan(64 * 1024 * 1024)
      expect(wave.segments).toHaveLength(1)
      expect(wave.segments[0]!.compressed).toBe(true)
      expect(wave.sha256).toBe(fixture.waveSha256)
      expect(44 + fixture.farSample * 2).toBeGreaterThan(64 * 1024 * 1024)
      await info.attach('compressed-audio.xp3', { body: fixture.bytes, contentType: 'application/octet-stream' })
      await page.locator('#remote-url').fill(server.url + '/compressed-audio.xp3')
      await page.locator('#load-url').click()
      await expect(page.getByText('xp3-compressed-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      // The original text and executable UTF-16 entries cross both zlib/raw
      // segment boundaries, including a split inside a two-byte code unit.
      await evaluate(page, 'xp3SegmentScript', xp3SegmentScript)
      await evaluate(page, 'xp3CompressedText()', fixture.segmentText)
      await evaluate(page, 'xp3CompressedOpen()', xp3CompressedAudioHeader)
      await evaluate(page, '(xp3Audio.play(),xp3Audio.status)', 'play')
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await openPhaseCapture(page)
      const capture = async (region: (typeof xp3AudioRegions)[number]) => {
        await expect(page.getByText(`xp3-compressed-label:${region.id}:${region.id}`, { exact: true })).toBeVisible({ timeout: 15000 })
        const before = await nativePhasePosition(page)
        expect(before.snapshot.sampleRate).toBe(fixture.wave.rate)
        expect(before.snapshot.sampleCount).toBe(fixture.wave.samples)
        expect(before.snapshot.position).toBeGreaterThanOrEqual(region.startSample)
        const end = region.id === 'prefix' ? fixture.backSample : region.id === 'back' ? fixture.farSample : fixture.wave.samples
        expect(before.snapshot.position).toBeLessThan(end)
        await beginPhaseCapture(page, 0.5, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page), metrics = await attachPhaseCapture(info, `compressed-${region.id}`, output,
          { region, before, waveSha256: fixture.waveSha256, physicalWaveBytes: fixture.wave.size })
        observations.push({ region, before, completionPosition: output.completionPosition, metrics })
        expect(output.completionPosition?.error).toBeUndefined()
        expect(output.completionPosition?.observation?.snapshot.position).toBeGreaterThan(before.snapshot.position)
        expect(output.completionPosition?.observation?.snapshot.position).toBeLessThan(end)
        for (const channel of metrics) {
          expect(channel.nonfinite).toBe(0)
          expect(channel.spectrum.count).toBe(8192)
          expect(Math.abs(channel.spectrum.peakHz - region.frequency)).toBeLessThanOrEqual(1)
          // Independent waveform levels differ along with frequency. The
          // copy-only observer cannot make a wrong source offset sound right.
          const expectedRms = region.amplitude / 32768 / Math.SQRT2
          expect(Math.abs(channel.rms - expectedRms)).toBeLessThan(0.02)
        }
        await expect.poll(() => meter.getAttribute('data-stream-voices')).toBe('1')
        expect(Number(await meter.getAttribute('data-stream-bytes'))).toBeGreaterThan(0)
        expect(Number(await meter.getAttribute('data-stream-bytes'))).toBeLessThanOrEqual(4096 * 16 * 4)
        expect(Number(await meter.getAttribute('data-stream-reserved-bytes'))).toBe(4096 * 16 * 4)
      }
      await capture(xp3AudioRegions[0])
      await evaluate(page, `xp3CompressedSeek(${fixture.farSample},"far")`, String(fixture.farSample))
      await evaluate(page, '(xp3Audio.paused=false,xp3Audio.status)', 'play')
      await capture(xp3AudioRegions[2])
      await evaluate(page, `xp3CompressedSeek(${fixture.backSample},"back")`, String(fixture.backSample))
      await evaluate(page, '(xp3Audio.paused=false,xp3Audio.status)', 'play')
      await capture(xp3AudioRegions[1])
      await evaluate(page, 'xp3CompressedClose()', 'closed')
      await expect.poll(() => meter.getAttribute('data-stream-voices')).toBe('0')
      await expect.poll(() => meter.getAttribute('data-stream-pending')).toBe('0')
      await expect.poll(() => meter.getAttribute('data-stream-reserved-bytes')).toBe('0')
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('xp3-compressed-audio-evidence', { contentType: 'application/json', body: JSON.stringify({
        backend, binary, archiveBytes: fixture.bytes.length, archiveSha256: fixture.sha256,
        waveBytes: fixture.wave.size, waveSha256: fixture.waveSha256, entries: fixture.entries,
        observations, transport: server.stats(), requests: server.requests, logs: await page.locator('#logs').innerText(), errors,
        failures: failures.map((error) => error instanceof Error ? error.message : String(error)),
        scope: 'One real 72-MiB WAVE zlib segment, independent input bytes, source/compiled program and text crossing segments, original labels and exact paused seek positions, three distinct actual Worklet frequencies/levels. HTTP byte counts describe compressed transport, not decoded memory.',
      }, null, 2) })
    } catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('#sound-status')).toHaveText('声音已关闭。')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await server.close() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Compressed XP3 WAVE or cleanup failed', { cause: failures[0] })
  })
