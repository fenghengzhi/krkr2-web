import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { installFirstFrameRecoveryGate, videoFirstFrameRecoverySource,
  type FirstFrameRecoveryWindow } from '../helpers/video-first-frame-recovery.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'
import { installVideoAudioChannelProbe, observeVideoAudioChannels } from '../helpers/video-audio-channel-probe.ts'
import { installHandoffReadbacks, captureHandoff } from '../helpers/video-handoff-capture.ts'
import { compareFirstFrameParents } from '../helpers/video-first-frame-controls.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a stalled cutscene candidate recovers with a real silent frame and preserves the paused game`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], pixels: unknown[] = [], observations: unknown[] = []
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    await observeVideoFrames(page, { passive: true }); await installVideoAudioProbe(page)
    await installVideoAudioChannelProbe(page); await installHandoffReadbacks(page)
    await installFirstFrameRecoveryGate(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const gate = () => page.evaluate(() => {
      const gate = (window as unknown as FirstFrameRecoveryWindow).firstFrameRecoveryGate
      return { attempts: gate.attempts, frames: gate.frames, pending: gate.pending() }
    })
    try {
      game = await launchWindowAttention(page, backend, binary, videoFirstFrameRecoverySource,
        [{ name: 'cutscene.mp4', mimeType: 'video/mp4',
          buffer: readFileSync(resolve('out/verification/video-tracks/numbered-multitrack.mp4')) }], true)
      await expect(page.getByText('cutscene-recovery-ready', { exact: true })).toBeVisible()
      const surface = game.surface('Cutscene recovery'), canvas = surface.locator('canvas[data-window-id]'),
        capture = async () => {
          const value = await captureHandoff(page, surface, (readback) => pixels.push(readback))
          pixels.push(value)
          expect(value.media.paused).toBe(true); expect(value.media.seeking).toBe(false)
          expect(value.production?.pixels).toEqual(value.reads.cpu)
          expect(value.reads.cpuRepeated).toEqual(value.reads.cpu)
          expect(value.reads.cpuRedrawn).toEqual(value.reads.cpu)
          for (const x of [0, 80]) {
            const painted: number[] = []
            for (let y = 0; y < 48; y++) {
              const from = (y * value.paint.width + x) * 4
              painted.push(...value.paint.pixels.slice(from, from + 64 * 4))
            }
            expect(painted).toEqual(value.reads.cpu)
          }
          return value
        }, before = await capture()
      expect((await gate()).attempts).toEqual([])
      for (const [round, mode] of ['recover', 'denied', 'cancel'].entries()) {
        await page.evaluate((mode) => {
          ;(window as unknown as FirstFrameRecoveryWindow).firstFrameRecoveryGate.arm = mode as 'recover' | 'denied' | 'cancel'
        }, mode)
        await canvas.click({ position: { x: 80, y: 65 } })
        await expect.poll(async () => (await gate()).attempts.length).toBe(round + 1)
        const attempt = (await gate()).attempts[round]!
        expect(attempt.mode).toBe(mode); expect(attempt.private).toBe(true); expect(attempt.muted).toBe(true)
        expect(attempt.gains).toEqual([0, 0]); expect(attempt.oldTime).toBe(before.media.position)
        if (mode !== 'recover') {
          await expect(page.getByText(`cutscene-recovered:${round}:pause:10`, { exact: true })).toHaveCount(0)
          const held = await capture()
          expect(held.media).toEqual(before.media); expect(held.paint).toEqual(before.paint)
          expect(held.screen).toEqual(before.screen)
          const audio = await observeVideoAudioChannels(page)
          expect(audio.graphs).toHaveLength(2); expect(audio.errors).toEqual([])
          for (const graph of audio.graphs) for (const channel of graph.output) expect(channel.peak).toBe(0)
          observations.push({ phase: mode, gate: await gate(), audio })
        }
        if (mode === 'cancel') {
          // Keep the real warmup frame outstanding, then use the actual Stop
          // control while the game's public selectAudioStream call is pending.
          await expect.poll(async () => (await gate()).frames.some((frame) => frame.mode === 'cancel')).toBe(true)
          await page.locator('#stop').press('Enter')
          await game.waitForStopped()
          await page.evaluate(() => (window as unknown as FirstFrameRecoveryWindow).firstFrameRecoveryGate.late())
          await expect(page.locator('video,.video-presentation-surface')).toHaveCount(0)
          expect((await gate()).pending).toBe(0)
          break
        }
        if (mode === 'denied') {
          await expect.poll(async () => (await gate()).frames.some((frame) => frame.mode === 'denied')).toBe(true)
          await page.evaluate(() => (window as unknown as FirstFrameRecoveryWindow).firstFrameRecoveryGate.release())
        }
        await expect(page.getByText(`cutscene-recovered:${round}:pause:10`, { exact: true })).toBeVisible()
        const after = await capture()
        expect(after.media).toEqual(before.media); expect(after.paint).toEqual(before.paint)
        expect(after.screen).toEqual(before.screen)
        expect(after.production?.source).not.toBe(before.production?.source)
        expect((await gate()).frames.some((frame) => frame.mode === mode && frame.counter > 0)).toBe(true)
        expect((await observeVideoAudio(page)).liveUrls).toBe(1)
        expect((await observeVideoAudioChannels(page)).graphs).toHaveLength(1)
      }
      expect((await gate()).attempts.map((attempt) => attempt.mode)).toEqual(['recover', 'denied', 'cancel'])
    } catch (error) { failures.push(error) }
    // Only after the original assertion has failed, reserve foreground time
    // for its attachments, the two bounded controls and independent cleanup.
    // Product rVFC/seek waits and every original assertion keep their limits.
    if (failures.length && backend === 'asyncify' && !binary) test.setTimeout(info.timeout + 60000)
    try { await info.attach('first-frame-recovery-pixels.json.gz', {
      contentType: 'application/gzip', body: gzipSync(JSON.stringify(pixels)) }) } catch (error) { failures.push(error) }
    try { await info.attach('first-frame-recovery-observations', { contentType: 'application/json',
      body: JSON.stringify({ observations, gate: await gate(), media: await observeVideoMedia(page),
        audio: await observeVideoAudioChannels(page), logs: await page.locator('#logs').innerText() }) }) }
    catch (error) { failures.push(error) }
    if (failures.length && backend === 'asyncify' && !binary) try {
      await info.attach('independent-first-frame-parent-controls', { contentType: 'application/json',
        body: JSON.stringify(await compareFirstFrameParents(page)) })
    } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
      if (game) await game.waitForStopped()
      else await expect(page.locator('#status')).toHaveText('待机')
      expect((await observeVideoAudio(page)).liveUrls).toBe(0)
      expect((await observeVideoAudioChannels(page)).graphs).toHaveLength(0)
      await expect(page.locator('video,.video-presentation-surface')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Cutscene startup recovery or cleanup failed', { cause: failures[0] })
  })
