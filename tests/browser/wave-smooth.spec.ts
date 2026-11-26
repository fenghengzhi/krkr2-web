import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { smoothCycle, smoothShortCycle, smoothSamples, waveSmoothFiles, waveSmoothSource } from '../helpers/wave-smooth.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

const buttons = String.raw`
var smoothWindow=new Window();smoothWindow.caption="Smooth music";smoothWindow.setInnerSize(160,80);smoothWindow.visible=true;
var smoothRoot=new Layer(smoothWindow,null);smoothWindow.add(smoothRoot);smoothRoot.setSize(160,80);smoothRoot.fillRect(0,0,160,80,0xff203040);
var smoothButton=new Layer(smoothWindow,smoothRoot);smoothWindow.add(smoothButton);smoothButton.setPos(10,10,120,40);smoothButton.fillRect(0,0,120,40,0xff408060);smoothButton.visible=true;
var smoothMusic=new SmoothSound(),smoothClicks=0,smoothDeviceRate=1000;
smoothMusic.open("smooth-listen.wav");smoothMusic.samplePosition=72;smoothMusic.paused=true;smoothMusic.play();
function smoothClick(){
 if(smoothClicks==0 || smoothClicks==2)smoothMusic.paused=false;
 else if(smoothClicks==1)smoothMusic.paused=true;
 else if(smoothClicks==3){smoothMusic.open("smooth-listen-short.wav");smoothMusic.samplePosition=72;smoothMusic.frequency=smoothDeviceRate;smoothMusic.play();}
 else return;
 smoothClicks++;Debug.message("smooth-click:"+smoothClicks+":"+int(smoothMusic.paused));
}
smoothButton.onClick=function(){global.smoothClick();};Debug.message("smooth-button-ready");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real Smooth loop buttons deliver every native PCM16 sample through the Worklet`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("smooth.tjs","savedata/smooth.cjs",false,true,false);Scripts.execStorage("savedata/smooth.cjs");'
          : 'Scripts.execStorage("smooth.tjs");') },
        { name: 'smooth.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveSmoothSource + buttons) },
        ...Object.entries(waveSmoothFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('smooth-button-ready', { exact: true })).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      await beginPhaseCapture(page, 0.05)
      const initial = await endPhaseCapture(page)
      for (const channel of initial.channels) expect(channel).toEqual(Array(channel.length).fill(0))
      // Use the real public frequency control to consume one source sample per
      // device sample. Node separately covers normal 1000-Hz playback. This
      // makes full browser PCM comparison independent of resampling phase.
      await evaluate(page, `(smoothDeviceRate=${initial.sampleRate},smoothMusic.frequency=smoothDeviceRate,[smoothMusic.samplePosition,smoothMusic.filters.count].join(","))`, '72,0')
      const button = page.locator('canvas[data-window-id]').first(), click = async (at: number, paused: boolean) => {
        await button.click({ position: { x: 40, y: 25 } })
        await expect(page.getByText(`smooth-click:${at}:${paused ? 1 : 0}`, { exact: true })).toHaveCount(1)
      }, capture = async (name: string, cycle: readonly number[]) => {
        await beginPhaseCapture(page, 0.72)
        const output = await endPhaseCapture(page), expected = smoothSamples(cycle)
        await attachPhaseCapture(info, name, output, { cycle, unitSampleStep: true })
        expect(output.channels).toHaveLength(2)
        for (const channel of output.channels) {
          expect(channel.length).toBeGreaterThan(expected.length)
          // Alignment selects a cyclic phase only. Every captured byte-valued
          // sample is then compared exactly against the independent literals.
          const phase = expected.findIndex((_, offset) => expected.every((_value, at) =>
            channel[at] === expected[(offset + at) % expected.length]))
          expect(phase, 'The first cycle must match an authored rotation exactly').toBeGreaterThanOrEqual(0)
          expect(channel).toEqual(Array.from({ length: channel.length }, (_, at) => expected[(phase + at) % expected.length]!))
        }
      }
      await click(1, false); await capture('smooth-unequal-ramps', smoothCycle)
      await click(2, true)
      const paused = await nativePhasePosition(page)
      await beginPhaseCapture(page, 0.1)
      const silence = await endPhaseCapture(page)
      for (const channel of silence.channels) expect(channel).toEqual(Array(channel.length).fill(0))
      expect((await nativePhasePosition(page)).snapshot.position).toBe(paused.snapshot.position)
      await click(3, false); await capture('smooth-resumed-private-tail', smoothCycle)
      await click(4, false); await capture('smooth-clipped-at-disabled-link', smoothShortCycle)
      await evaluate(page, '(invalidate smoothMusic,0)', '0')
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('smooth-game-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Smooth Wave browser or cleanup failed', { cause: failures[0] })
  })
