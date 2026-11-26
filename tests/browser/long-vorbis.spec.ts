import { expect, test } from '@playwright/test'
import { longVorbisFiles, longVorbisSource } from '../helpers/long-vorbis.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: game buttons seek long Ogg music and loop its distant SLI phrase without losing stereo sound`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({
      has: page.locator('.game-window-title', { hasText: /^Long Ogg music$/ }),
    }).locator('canvas[data-window-id]'),
      click = async (x: number, marker: string) => {
        const point = await pointerPixel(canvas, x, 30)
        await page.mouse.click(point.x, point.y)
        await expect(page.getByText(marker, { exact: true })).toBeVisible()
      }, capture = async (name: string, hz: number, seconds = .5) => {
        const before = await nativePhasePosition(page)
        expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
        await beginPhaseCapture(page, seconds, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page), metrics = await attachPhaseCapture(info, name, output, { hz, before }),
          after = output.completionPosition?.observation?.snapshot
        expect(output.channels).toHaveLength(2); expect(after).toBeDefined()
        expect(after!.id).toBe(before.snapshot.id); expect(after!.status).toBe('play')
        expect(output.completionPosition?.error).toBeUndefined()
        expect(output.channels[0]).toHaveLength(Math.ceil(output.sampleRate * seconds))
        for (let channel = 0; channel < 2; channel++) {
          const metric = metrics[channel]!
          expect(metric.nonfinite).toBe(0)
          expect(metric.rms).toBeGreaterThan(channel ? .13 : .23)
          expect(metric.rms).toBeLessThan(channel ? .16 : .26)
          expect(Math.abs(metric.spectrum.peakHz - hz)).toBeLessThanOrEqual(1)
          const plane = output.channels[channel]!, window = Math.round(output.sampleRate / 20)
          let zeros = 0
          for (let frame = 0; frame < plane.length; frame++) {
            zeros = plane[frame] === 0 ? zeros + 1 : 0
            if (zeros >= 16) throw new Error(`${name} channel ${channel} has a silent gap ending at ${frame}`)
          }
          for (let at = 0; at + window <= plane.length; at += window) {
            let square = 0
            for (let i = at; i < at + window; i++) square += plane[i]! * plane[i]!
            if (Math.sqrt(square / window) < (channel ? .13 : .23))
              throw new Error(`${name} channel ${channel} lost its phrase at sample ${at}`)
          }
        }
        observations.push({ name, hz, before, after, metrics })
        return { before: before.snapshot, after: after! }
      }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("music.tjs","savedata/music.cjs",false,true,false);Scripts.execStorage("savedata/music.cjs");longMenu();'
          : 'Scripts.execStorage("music.tjs");longMenu();') },
        { name: 'music.tjs', mimeType: 'text/plain', buffer: Buffer.from(longVorbisSource) },
        ...Object.entries(longVorbisFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('long-ready', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      const initial = await capture('ordinary-start', 440)
      expect(initial.after.position).toBeGreaterThan(initial.before.position)
      await click(378, 'long-page-edge')
      const edge = await capture('page-edge-seek-440', 440)
      expect(edge.before.position).toBeGreaterThanOrEqual(192007)
      expect(edge.after.position).toBeGreaterThan(edge.before.position)
      await click(38, 'long-far')
      const far = await capture('actual-far-seek', 880)
      expect(far.before.position).toBeGreaterThanOrEqual(85 * 48000)
      expect(far.after.position).toBeGreaterThan(far.before.position)
      await click(118, 'long-back')
      const back = await capture('actual-backward-seek', 660)
      expect(back.before.position).toBeGreaterThanOrEqual(48 * 48000)
      expect(back.after.position).toBeLessThan(64 * 48000)
      await click(278, 'long-pause:1')
      const paused = await nativePhasePosition(page)
      await beginPhaseCapture(page, .2)
      const silence = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'real-game-pause', silence)
      for (const channel of silence.channels) expect(channel).toEqual(Array(channel.length).fill(0))
      expect((await nativePhasePosition(page)).snapshot.position).toBe(paused.snapshot.position)
      await click(278, 'long-pause:0'); await capture('resumed-middle-phrase', 660)
      await click(198, 'long-loop')
      // Three real seconds cross the distant 86s -> 84s link. Record all
      // output, including the seam; a bounded per-window check rejects gaps.
      const looping = await capture('distant-sli-phrase-and-seam', 880, 3)
      expect(looping.before.position).toBeGreaterThanOrEqual(84 * 48000)
      expect(looping.after.position).toBeLessThan(86 * 48000)
      // Observe distinct game-owned events, not repeated log rows that the UI
      // may coalesce. The literal name also drives the visible story panel.
      for (const ordinal of [1, 2])
        await expect(page.getByText(`long-label:late:${ordinal}`, { exact: true })).toBeVisible()
      await expect.poll(() => canvas.evaluate((node) => {
        const canvas = node as HTMLCanvasElement, copy = new OffscreenCanvas(canvas.width, canvas.height),
          context = copy.getContext('2d', { willReadFrequently: true })!
        context.drawImage(canvas, 0, 0)
        return [...context.getImageData(390, 90, 1, 1).data]
      })).toEqual([32, 128, 64, 255])
      await info.attach('long-vorbis-story-hooks', { contentType: 'image/png', body: await canvas.screenshot() })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('long-vorbis-game', { contentType: 'application/json', body: JSON.stringify({ observations, errors, logs: await page.locator('#logs').innerText() }, null, 2) }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Long Vorbis music game or cleanup failed', { cause: failures[0] })
  })
