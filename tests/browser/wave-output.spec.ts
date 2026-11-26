import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { waveOutputGameFiles, waveOutputSource } from '../helpers/wave-output.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition, type CapturedPhaseAudio } from '../helpers/web-phase-vocoder.ts'

function tones(output: CapturedPhaseAudio, mode: 'i16' | 'i16m', anti: boolean) {
  const [left, right] = output.channels
  expect(output.channels).toHaveLength(2); expect(left).toHaveLength(Math.ceil(output.sampleRate / 2))
  expect(right).toHaveLength(left!.length)
  for (let frame = 0; frame < left!.length; frame++) {
    const l = left![frame]!, r = right![frame]!
    if (!Number.isFinite(l) || !Number.isFinite(r) || (mode === 'i16m' && l !== r) ||
        (anti && (mode === 'i16m' ? l !== 0 || r !== 0 : r !== -l)))
      throw new Error(`Forced ${mode} ${anti ? 'anti-phase' : 'dual-tone'} PCM differs at ${frame}: ${l},${r}`)
  }
  const amplitudes = output.channels.map((plane) => [440, 660, 880].map((hz) => {
    let real = 0, imaginary = 0
    for (let frame = 0; frame < plane.length; frame++) {
      const angle = frame * 2 * Math.PI * hz / output.sampleRate
      real += plane[frame]! * Math.cos(angle); imaginary += plane[frame]! * Math.sin(angle)
    }
    return Math.hypot(real, imaginary) * 2 / plane.length
  }))
  const expected = anti ? mode === 'i16m' ? [[0, 0, 0], [0, 0, 0]] : [[0, .25, 0], [0, .25, 0]]
    : mode === 'i16m' ? [[.125, 0, .125], [.125, 0, .125]] : [[.25, 0, 0], [0, 0, .25]]
  for (let channel = 0; channel < 2; channel++) for (let tone = 0; tone < 3; tone++)
    expect(Math.abs(amplitudes[channel]![tone]! - expected[channel]![tone]!)).toBeLessThan(.005)
  return amplitudes
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a game hears forced mono or stereo, pauses and reopens with its original output policy`, async ({ page }, info) => {
    test.setTimeout(120000)
    const errors: string[] = [], files = waveOutputGameFiles()
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    for (const mode of ['i16m', 'i16'] as const) {
      const failures: unknown[] = [], channels = mode === 'i16m' ? 1 : 2,
        canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Wave output format$/ }) }).locator('canvas[data-window-id]'),
        click = async (x: number, marker: string) => {
          const point = await pointerPixel(canvas, x, 30); await page.mouse.click(point.x, point.y)
          await expect(page.getByText(marker, { exact: true })).toHaveCount(1)
        }, hear = async (stage: string, anti: boolean) => {
          const before = await nativePhasePosition(page)
          expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
          expect(before.snapshot.channels).toBe(channels); expect(before.snapshot.bits).toBe(16)
          await beginPhaseCapture(page, .5)
          const output = await endPhaseCapture(page)
          // Attach the untouched output before assertions, including any
          // erroneous channel separation or unexpected nonzero anti-phase.
          await attachPhaseCapture(info, `${mode}-${stage}`, output, { before, mode, anti })
          tones(output, mode, anti)
        }
      try {
        const startup = (mode === 'i16' ? 'System.setArgument("-wsforcecnv","i16");' : '') +
          (binary ? 'Scripts.compileStorage("output.tjs",System.dataPath+"output.cjs",false,true,false);Scripts.execStorage(System.dataPath+"output.cjs");outputMenu();'
            : 'Scripts.execStorage("output.tjs");outputMenu();'),
          game = { ...files, 'startup.tjs': startup, 'output.tjs': waveOutputSource }
        await page.locator('#project-mode').selectOption(mode === 'i16m' ? 'auto' : 'collection')
        if (mode === 'i16m') {
          // Real release configuration, before the first Wave is constructed.
          // This authored MZ marker is only resource data; never an executable.
          const configuration = 'wsforcecnv=i16m\r\n'
          await page.locator('#files').setInputFiles([
            { name: 'Output.exe', mimeType: 'application/octet-stream', buffer: Buffer.from([77, 90]) },
            { name: 'Output.cf', mimeType: 'text/plain', buffer: Buffer.from(configuration, 'ascii') },
            { name: 'data.xp3', mimeType: 'application/octet-stream', buffer: xp3Fixture(game).bytes },
          ])
          await info.attach('wave-output-release-config', { body: configuration, contentType: 'text/plain' })
          await expect(page.locator('#project-status')).toContainText('data.xp3>')
        } else await page.locator('#files').setInputFiles(Object.entries(game).map(([name, value]) => ({
          name, mimeType: name.endsWith('.wav') ? 'audio/wav' : 'text/plain',
          buffer: typeof value === 'string' ? Buffer.from(value) : Buffer.from(value),
        })))
        await expect(page.getByText(`output-ready:${mode}:16:${channels}`, { exact: true })).toBeVisible()
        if (mode === 'i16m') await evaluate(page, 'System.exeName', 'game://./Output.exe')
        await expect(canvas).toBeVisible()
        if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
        await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
        await hear('dual-voice-music', false)
        await click(40, `output-action:0:play:0:16:${channels}`)
        await hear('opposite-channel-dialogue', true)
        await click(120, `output-action:1:play:1:16:${channels}`)
        const paused = await nativePhasePosition(page)
        await beginPhaseCapture(page, .1)
        const silence = await endPhaseCapture(page)
        await attachPhaseCapture(info, `${mode}-game-paused`, silence, { paused })
        for (const plane of silence.channels) expect(plane).toEqual(Array(plane.length).fill(0))
        expect((await nativePhasePosition(page)).snapshot.position).toBe(paused.snapshot.position)
        await click(120, `output-action:1:play:0:16:${channels}`)
        await hear('resumed-dialogue', true)
        await click(200, `output-action:2:play:0:16:${channels}`)
        await evaluate(page, 'System.getArgument("-wsforcecnv")', mode === 'i16m' ? 'i16' : 'i16m')
        await hear('new-wave-retains-frozen-format', false)
        await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
      } catch (error) { failures.push(error) }
      try { await info.attach(`${mode}-wave-output-log`, { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
      catch (error) { failures.push(error) }
      try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
      try {
        if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
        await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
        expect(errors).toEqual([])
      } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, `Wave output ${mode} playback or cleanup failed`, { cause: failures[0] })
    }
  })
