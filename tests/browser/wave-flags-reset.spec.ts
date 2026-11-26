import { expect, test } from '@playwright/test'
import { waveResetFiles, waveResetSource } from '../helpers/wave-flags-reset.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition, type CapturedPhaseAudio } from '../helpers/web-phase-vocoder.ts'

interface FlagControl { op: string; id?: number; index?: number; value?: number; at: number }
function amplitudes(output: CapturedPhaseAudio) {
  const plane = output.channels[0]!, length = Math.round(output.sampleRate / 10), rows: number[][] = []
  for (let start = 0; start + length <= plane.length; start += length) {
    rows.push([440, 660, 1100].map((hz) => {
      let real = 0, imaginary = 0
      for (let i = 0; i < length; i++) {
        const angle = 2 * Math.PI * hz * i / output.sampleRate, sample = plane[start + i]!
        real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle)
      }
      return Math.hypot(real, imaginary) * 2 / length
    }))
  }
  return rows
}
for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a game resets its playing music route in one Worklet command and hears only the legitimate next phrase`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.addInitScript(() => {
      const Native = AudioWorkletNode, root = globalThis as typeof globalThis & { __waveFlagControls: FlagControl[] }
      root.__waveFlagControls = []
      window.AudioWorkletNode = class extends Native {
        constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
          super(context, name, options)
          if (name !== 'krkr2-mixer') return
          const send = this.port.postMessage.bind(this.port)
          this.port.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
            const command = (message as { command?: Omit<FlagControl, 'at'> })?.command
            if (command?.op === 'flag' || command?.op === 'resetFlags')
              root.__waveFlagControls.push({ ...command, at: performance.now() })
            if (Array.isArray(transfer)) send(message, transfer)
            else send(message, transfer ?? {})
          }
        }
      }
    })
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Music branch reset$/ }) }).locator('canvas[data-window-id]'),
      controls = () => page.evaluate(() => (globalThis as typeof globalThis & { __waveFlagControls: FlagControl[] }).__waveFlagControls),
      click = async (x: number, marker: string) => {
        const point = await pointerPixel(canvas, x, 30); await page.mouse.click(point.x, point.y)
        await expect(page.getByText(marker, { exact: true })).toBeVisible()
      }, capture = async (name: string, hz: number) => {
        await beginPhaseCapture(page, .5)
        const output = await endPhaseCapture(page), rows = amplitudes(output)
        await attachPhaseCapture(info, name, output, { hz, rows })
        expect(output.channels).toHaveLength(2)
        for (let i = 0; i < output.channels[0]!.length; i++)
          if (!Number.isFinite(output.channels[0]![i]) || output.channels[1]![i] !== -output.channels[0]![i]!)
            throw new Error(`${name}: stereo output differs at frame ${i}`)
        for (const row of rows) {
          expect(row[hz === 440 ? 0 : 1]).toBeGreaterThan(.3)
          expect(row[2]).toBeLessThan(.03)
        }
        observations.push({ name, rows })
      }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("reset.tjs","savedata/reset.cjs",false,true,false);Scripts.execStorage("savedata/reset.cjs");resetMenu();'
          : 'Scripts.execStorage("reset.tjs");resetMenu();') },
        { name: 'reset.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveResetSource) },
        ...Object.entries(waveResetFiles(true)).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('reset-ready', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      await capture('old-game-phrase', 440)
      const before = (await controls()).length
      await beginPhaseCapture(page, 1)
      await click(38, 'reset-applied')
      const transition = await endPhaseCapture(page), rows = amplitudes(transition)
      await attachPhaseCapture(info, 'actual-reset-transition', transition, { rows })
      for (const row of rows) expect(row[2], 'the partial-clear third phrase must never sound').toBeLessThan(.03)
      const sent = (await controls()).slice(before)
      expect(sent.map((command) => command.op)).toEqual(['resetFlags'])
      await expect(page.getByText('reset-label:next', { exact: true }).first()).toBeVisible()
      await expect(page.getByText('reset-label:wrong', { exact: true })).toHaveCount(0)
      await capture('legitimate-new-game-phrase', 660)
      const state = (await nativePhasePosition(page)).snapshot
      expect(state.status).toBe('play'); expect(state.flags).toEqual(Array(16).fill(0))
      await click(198, 'reset-paused:1')
      const held = (await nativePhasePosition(page)).snapshot.position
      await beginPhaseCapture(page, .2)
      const silence = await endPhaseCapture(page); await attachPhaseCapture(info, 'real-game-paused', silence)
      for (const plane of silence.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      expect((await nativePhasePosition(page)).snapshot.position).toBe(held)
      await click(198, 'reset-paused:0'); await capture('resumed-new-game-phrase', 660)
      await click(118, 'reset-restarted'); await capture('reopened-original-game-phrase', 440)
      await info.attach('music-route-game', { body: await canvas.screenshot(), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-flags-reset', { body: JSON.stringify({ observations, controls: await controls(), logs: await page.locator('#logs').innerText(), errors }, null, 2), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Music route reset or cleanup failed', { cause: failures[0] })
  })
