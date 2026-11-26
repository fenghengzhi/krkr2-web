import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { spatialGameFiles, spatialSource } from '../helpers/wave-spatial.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

// Independent amplitudes for the authored 440/880 Hz voices. The explicit
// Web two-speaker profile uses equal power and inverse distance; no physical
// DirectSound device, HRTF, room effect or sound-bank equivalence is asserted.
const center = .25 * Math.SQRT1_2
const stages = [
  { position: '-1|0|0', channels: 1, tones: [[.25, 0], [0, 0]], silent: 1 },
  { position: '1|0|0', channels: 1, tones: [[0, 0], [.25, 0]], silent: 0 },
  { position: '0|0|1', channels: 1, tones: [[center, 0], [center, 0]], equal: true },
  { position: '0|0|4', channels: 1, tones: [[center / 4, 0], [center / 4, 0]], equal: true, distanceGain: .25 },
  { position: '0|2|0', channels: 1, tones: [[center / 2, 0], [center / 2, 0]], equal: true, distanceGain: .5 },
  { position: '-1|0|0', channels: 1, tones: [[.125, .0625], [0, 0]], silent: 1 },
  { position: '-4|0|0', channels: 2, tones: [[.25, 0], [0, .125]] },
] as const

function toneAmplitudes(samples: readonly number[], rate: number): number[] {
  const real = [0, 0], imaginary = [0, 0], frequencies = [440, 880]
  let weight = 0
  for (let frame = 0; frame < samples.length; frame++) {
    const sample = samples[frame]!
    if (!Number.isFinite(sample)) throw new Error('Nonfinite spatial Wave sample at ' + frame)
    const window = .5 - .5 * Math.cos(2 * Math.PI * frame / (samples.length - 1))
    weight += window
    for (let tone = 0; tone < frequencies.length; tone++) {
      const angle = 2 * Math.PI * frequencies[tone]! * frame / rate
      real[tone]! += sample * window * Math.cos(angle)
      imaginary[tone]! += sample * window * Math.sin(angle)
    }
  }
  return real.map((value, tone) => 2 * Math.hypot(value, imaginary[tone]!) / weight)
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real Wave position buttons move a voice between speakers and attenuate distant dialogue`, async ({ page }, info) => {
    test.setTimeout(120000)
    const errors: string[] = [], failures: unknown[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', {
      hasText: /^Spatial sound$/,
    }) }).locator('canvas[data-window-id]'),
      click = async (x: number, marker: string) => {
        const point = await pointerPixel(canvas, x, 30)
        await page.mouse.click(point.x, point.y)
        await expect(page.getByText(marker, { exact: true })).toBeVisible()
      }
    let near: number[][] | undefined, outputRate: number | undefined
    try {
      const config = 'wsuse3d=yes\r\n', startup = binary
        ? 'Scripts.compileStorage("spatial.tjs",System.dataPath+"spatial.cjs",false,true,false);Scripts.execStorage(System.dataPath+"spatial.cjs");spatialMenu();'
        : 'Scripts.execStorage("spatial.tjs");spatialMenu();'
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#files').setInputFiles([
        { name: 'Spatial.exe', mimeType: 'application/octet-stream', buffer: Buffer.from([77, 90]) },
        { name: 'Spatial.cf', mimeType: 'text/plain', buffer: Buffer.from(config, 'ascii') },
        { name: 'data.xp3', mimeType: 'application/octet-stream', buffer: xp3Fixture({
          ...spatialGameFiles(), 'startup.tjs': startup, 'spatial.tjs': spatialSource,
        }).bytes },
      ])
      await expect(page.getByText('spatial-ready:yes', { exact: true })).toBeVisible()
      await expect(canvas).toBeVisible()
      await evaluate(page, 'System.exeName', 'game://./Spatial.exe')
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      // spatialMenu has completed the first real play, so the actual mixer
      // node exists before its output is tapped.
      await openPhaseCapture(page)
      for (const [stage, expected] of stages.entries()) {
        if (stage) await click(40, 'spatial-stage:' + stage)
        await evaluate(page, '[spatialMusic.posX,spatialMusic.posY,spatialMusic.posZ,spatialMusic.status,spatialMusic.channels,spatialMusic.bits].join("|")',
          `${expected.position}|play|${expected.channels}|16`)
        const before = await nativePhasePosition(page)
        expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
        expect(before.snapshot.sampleRate).toBe(48000); expect(before.snapshot.sampleCount).toBe(9600)
        expect(before.snapshot.channels).toBe(expected.channels)
        await beginPhaseCapture(page, .25)
        const output = await endPhaseCapture(page), amplitudes = output.channels.map((samples) => toneAmplitudes(samples, output.sampleRate))
        await attachPhaseCapture(info, 'wave-spatial-stage-' + stage, output, { before, expected, amplitudes })
        expect(output.channels).toHaveLength(2)
        if (outputRate === undefined) outputRate = output.sampleRate
        expect(output.sampleRate).toBe(outputRate)
        for (let channel = 0; channel < 2; channel++) {
          expect(output.channels[channel]).toHaveLength(Math.ceil(output.sampleRate * .25))
          for (let tone = 0; tone < 2; tone++)
            expect(Math.abs(amplitudes[channel]![tone]! - expected.tones[channel]![tone]!)).toBeLessThan(.003)
        }
        if ('silent' in expected) {
          const plane = output.channels[expected.silent]!
          expect(plane).toEqual(Array(plane.length).fill(0))
        }
        if ('equal' in expected) expect(output.channels[0]).toEqual(output.channels[1])
        if (stage === 2) near = amplitudes
        if ('distanceGain' in expected) for (let channel = 0; channel < 2; channel++)
          expect(Math.abs(amplitudes[channel]![0]! / near![channel]![0]! - expected.distanceGain)).toBeLessThan(.003)
        await evaluate(page, 'int(spatialMusic.phrases>0)', '1')
        observations.push({ stage, expected, before, sampleRate: output.sampleRate, amplitudes })
        if (stage === 4) {
          await click(120, 'spatial-pause:1:1')
          const paused = await nativePhasePosition(page)
          expect(paused.snapshot.paused).toBe(true)
          await beginPhaseCapture(page, .1)
          const silence = await endPhaseCapture(page)
          await attachPhaseCapture(info, 'wave-spatial-paused', silence, { paused })
          expect(silence.channels).toHaveLength(2)
          for (const plane of silence.channels) expect(plane).toEqual(Array(plane.length).fill(0))
          expect((await nativePhasePosition(page)).snapshot.position).toBe(paused.snapshot.position)
          await click(120, 'spatial-pause:2:0')
          expect((await nativePhasePosition(page)).snapshot.paused).toBe(false)
        }
      }
      await evaluate(page, 'System.getArgument("-wsuse3d")', 'no')
      await info.attach('wave-spatial-buttons', { body: await canvas.screenshot(), contentType: 'image/png' })
      await click(200, 'spatial-stopped:0')
      await beginPhaseCapture(page, .1)
      const stopped = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'wave-spatial-stopped', stopped)
      expect(stopped.channels).toHaveLength(2)
      for (const plane of stopped.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-spatial-game', { contentType: 'application/json', body: JSON.stringify({
      observations, errors, logs: await page.locator('#logs').innerText(),
      scope: 'Original Wave setPos/posX/Y/Z through real game buttons and the actual AudioWorklet. Exact silent/equal planes, two independent tone amplitudes and measured distance ratios verify the explicit Web two-speaker profile. No physical DirectSound or HRTF equivalence is claimed.',
    }, null, 2) }) } catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Spatial Wave playback or cleanup failed', { cause: failures[0] })
  })
