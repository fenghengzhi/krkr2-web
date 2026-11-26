import { expect, test, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { waveFocusGameFiles, waveFocusSource } from '../helpers/wave-focus.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

type FocusObservation = { serial: number; muted: boolean; volume: number | undefined; acknowledged: boolean }
type FocusWindow = typeof globalThis & { __phaseNativeMixer?: AudioWorkletNode;
  __focusCommands?: FocusObservation[]; __closeFocusObserver?: () => void }

/** Passive command/reply barrier. Preserve every real postMessage argument;
 * this cannot create a focus event, change PCM, or send a mixer setting. */
async function observeFocusCommands(page: Page) {
  await page.evaluate(() => {
    const root = globalThis as FocusWindow, port = root.__phaseNativeMixer!.port,
      send = port.postMessage, rows = root.__focusCommands = [] as FocusObservation[],
      reply = (event: MessageEvent) => {
        if (event.data?.type !== 'reply') return
        const row = rows.find((item) => item.serial === event.data.serial)
        if (row && !event.data.error) row.acknowledged = true
      }
    port.postMessage = function (...args: [message: unknown, transfer?: Transferable[] | StructuredSerializeOptions]) {
      const packet = args[0] as { serial?: number; command?: { op?: string; muted?: boolean; volume?: number } }
      if (packet.command?.op === 'waveMuted' && typeof packet.serial === 'number')
        rows.push({ serial: packet.serial, muted: !!packet.command.muted, volume: packet.command.volume, acknowledged: false })
      Reflect.apply(send, port, args)
    } as MessagePort['postMessage']
    port.addEventListener('message', reply)
    root.__closeFocusObserver = () => { port.postMessage = send; port.removeEventListener('message', reply) }
  })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: shipped background volume keeps music audible after switching away and restores it on return`, async ({ page, context }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    let other: Page | undefined
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Background music level$/ }) }).locator('canvas[data-window-id]'),
      environment = () => page.evaluate(() => ({ focused: document.hasFocus(), hidden: document.hidden,
        commands: (globalThis as FocusWindow).__focusCommands ?? [] })),
      waitFocus = async (muted: boolean) => {
        await expect.poll(async () => {
          const state = await environment(), last = state.commands.at(-1)
          return { focused: state.focused, muted: last?.muted, volume: last?.volume, acknowledged: last?.acknowledged }
        }).toEqual({ focused: !muted, muted, volume: 25000, acknowledged: true })
      }, hear = async (stage: string, muted: boolean) => {
        const before = await nativePhasePosition(page), state = await environment(), seconds = muted ? 1.25 : .5
        expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
        expect(state.focused).toBe(!muted)
        await beginPhaseCapture(page, seconds, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page), after = output.completionPosition?.observation?.snapshot,
          expected = .5 * (muted ? 10 ** (-3010 / 2000) : 1)
        await attachPhaseCapture(info, stage, output, { before, after, state, expectedAmplitude: expected,
          nativeAttenuation: muted ? -3010 : 0 })
        expect(output.completionPosition?.error).toBeUndefined(); expect(after).toBeDefined()
        expect(after!.id).toBe(before.snapshot.id)
        const advanced = (after!.position - before.snapshot.position + before.snapshot.sampleCount) % before.snapshot.sampleCount
        expect(advanced).toBeGreaterThan(0)
        expect(after!.status).toBe('play'); expect(after!.volume).toBe(100000)
        expect(output.channels).toHaveLength(2); expect(output.channels[1]).toEqual(output.channels[0])
        const left = output.channels[0]!
        expect(left).toHaveLength(Math.ceil(output.sampleRate * seconds))
        let real = 0, imaginary = 0
        for (let frame = 0; frame < left.length; frame++) {
          const sample = left[frame]!
          if (!Number.isFinite(sample)) throw new Error(`Nonfinite background audio at ${frame}`)
          const angle = 2 * Math.PI * 750 * frame / output.sampleRate
          real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle)
        }
        const amplitude = Math.hypot(real, imaginary) * 2 / left.length
        expect(Math.abs(amplitude - expected)).toBeLessThan(expected * .01 + .0001)
        if (muted) expect(output.events.filter(({ message }) => message.type === 'event' && message.event.type === 'label').length).toBeGreaterThan(0)
        observations.push({ stage, state, before, after, amplitude, expected })
      }, click = async (x: number, marker: string) => {
        const point = await pointerPixel(canvas, x, 30); await page.mouse.click(point.x, point.y)
        await expect(page.getByText(marker, { exact: true })).toHaveCount(1)
      }
    try {
      // The player's explicit preference to keep a game running in the
      // background is independent of the game's own background music level.
      await page.locator('#pause-background').uncheck()
      await page.locator('#project-mode').selectOption('auto')
      const config = 'wsmute=deactive\r\nwsmutevol=25\r\n', files = { ...waveFocusGameFiles(), 'focus.tjs': waveFocusSource,
        'startup.tjs': binary
          ? 'Scripts.compileStorage("focus.tjs",System.dataPath+"focus.cjs",false,true,false);Scripts.execStorage(System.dataPath+"focus.cjs");focusMenu();'
          : 'Scripts.execStorage("focus.tjs");focusMenu();' }
      await page.locator('#files').setInputFiles([
        { name: 'Focus.exe', mimeType: 'application/octet-stream', buffer: Buffer.from([77, 90]) },
        { name: 'Focus.cf', mimeType: 'text/plain', buffer: Buffer.from(config, 'ascii') },
        { name: 'data.xp3', mimeType: 'application/octet-stream', buffer: xp3Fixture(files).bytes },
      ])
      await expect(page.getByText('focus-ready:0:deactive:25', { exact: true })).toBeVisible()
      await expect(canvas).toBeVisible(); await evaluate(page, 'System.exeName', 'game://./Focus.exe')
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await openPhaseCapture(page); await observeFocusCommands(page); await hear('foreground-music', false)

      other = await context.newPage(); await other.goto('about:blank')
      await other.setContent('<button>Read another page while music continues</button>')
      await other.bringToFront(); await other.getByRole('button').click()
      await waitFocus(true); await hear('background-music-at-shipped-level', true)
      await expect(page.locator('#status')).toHaveText('运行中')
      await page.bringToFront(); await waitFocus(false); await hear('foreground-music-restored', false)

      await click(40, 'focus-reopened:0')
      await evaluate(page, 'System.getArgument("-wsmute")+":"+System.getArgument("-wsmutevol")', 'never:100')
      await other.bringToFront(); await other.getByRole('button').click()
      await waitFocus(true); await hear('new-wave-keeps-shipped-minimum-and-volume', true)
      await page.bringToFront(); await waitFocus(false); await hear('new-wave-restored', false)
      await click(120, 'focus-paused:1')
      const paused = await nativePhasePosition(page)
      await beginPhaseCapture(page, .1)
      const silence = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'explicit-game-pause', silence, { paused })
      for (const plane of silence.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      expect((await nativePhasePosition(page)).snapshot.position).toBe(paused.snapshot.position)
      await click(120, 'focus-paused:0'); await hear('explicit-game-resume', false)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-focus-observations', { body: JSON.stringify({ observations, state: await environment(),
      errors, logs: await page.locator('#logs').innerText() }), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { await other?.close(); await page.bringToFront() } catch (error) { failures.push(error) }
    try { await page.evaluate(() => (globalThis as FocusWindow).__closeFocusObserver?.()); await closePhaseCapture(page) }
    catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Wave background music or cleanup failed', { cause: failures[0] })
  })
