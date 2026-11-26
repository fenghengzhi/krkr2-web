import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { midiVolumeFiles, midiVolumePublicExpected, midiVolumeSource } from '../helpers/midi-volume.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

const buttons = String.raw`
var mvWindow=new Window();mvWindow.caption="MIDI music volume";mvWindow.setInnerSize(160,80);mvWindow.visible=true;
var mvRoot=new Layer(mvWindow,null);mvWindow.add(mvRoot);mvRoot.setSize(160,80);mvRoot.fillRect(0,0,160,80,0xff203040);
var mvButton=new Layer(mvWindow,mvRoot);mvWindow.add(mvButton);mvButton.setPos(10,10,120,40);mvButton.fillRect(0,0,120,40,0xff408060);mvButton.visible=true;
var mvMusic=new VolumeMidi(),mvStep=0;
mvMusic.open("midi-volume.mid");mvMusic.looping=true;
function midiVolumeClick(){
 if(mvStep==0){mvMusic.volume=50000;mvMusic.play();}
 else if(mvStep==1)mvMusic.volume=790;
 else if(mvStep==2)mvMusic.volume=1580;
 else if(mvStep==3){mvMusic.volume=50000;mvMusic.fade(0,120);}
 else if(mvStep==4){mvMusic.open("midi-volume.mid");mvMusic.play();}
 else if(mvStep==5)mvMusic.volume=100000;
 else return;
 mvStep++;Debug.message("midi-volume-step:"+mvStep+":"+mvMusic.status);
}
mvButton.onClick=function(){global.midiVolumeClick();};
Debug.message("midi-volume-button-ready");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: game MIDI controls reach silent 7-bit buckets and recover actual Worklet music`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("volume.tjs","savedata/volume.cjs",false,true,false);Scripts.execStorage("savedata/volume.cjs");'
          : 'Scripts.execStorage("volume.tjs");') },
        { name: 'volume.tjs', mimeType: 'text/plain', buffer: Buffer.from(midiVolumeSource + buttons) },
        ...Object.entries(midiVolumeFiles()).map(([name, bytes]) => ({ name, mimeType: 'audio/midi', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('midi-volume-button-ready', { exact: true })).toBeVisible()
      await evaluate(page, 'midiVolumePublicControls()', midiVolumePublicExpected)
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      const button = page.locator('canvas[data-window-id]').first(), click = async (stage: number) => {
        await button.click({ position: { x: 40, y: 25 } })
        await expect(page.getByText(`midi-volume-step:${stage}:play`, { exact: true })).toHaveCount(1)
      }, capture = async (name: string, silent: boolean) => {
        const before = await nativePhasePosition(page)
        expect(before.snapshot.paused).toBe(false); expect(before.snapshot.status).toBe('play')
        await beginPhaseCapture(page, 0.2, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page), metrics = await attachPhaseCapture(info, name, output, { before, silent })
        expect(output.completionPosition?.error).toBeUndefined()
        const after = output.completionPosition?.observation?.snapshot
        expect(after).toBeDefined(); expect(after!.position).toBeGreaterThan(before.snapshot.position)
        expect(output.channels).toHaveLength(2)
        for (let channel = 0; channel < output.channels.length; channel++) {
          expect(metrics[channel]!.nonfinite).toBe(0)
          if (silent) expect(output.channels[channel]).toEqual(Array(output.channels[channel]!.length).fill(0))
          else expect(metrics[channel]!.rms).toBeGreaterThan(0.0001)
        }
      }
      await click(1); await openPhaseCapture(page); await capture('midi-half-channel-49', false)
      await click(2); await evaluate(page, '[mvMusic.volume,mvMusic.volume2,mvMusic.paused].join(",")', '790,100000,0')
      await capture('midi-channel-rounds-to-zero', true)
      await click(3); await capture('midi-next-channel-step', false)
      await evaluate(page, '(mvMusic.paused=true,0)', '0')
      const paused = await nativePhasePosition(page)
      await beginPhaseCapture(page, 0.1)
      const pauseOutput = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'midi-individual-pause', pauseOutput)
      for (const channel of pauseOutput.channels) expect(channel).toEqual(Array(channel.length).fill(0))
      expect((await nativePhasePosition(page)).snapshot.position).toBe(paused.snapshot.position)
      await evaluate(page, '(mvMusic.paused=false,0)', '0')
      await click(4)
      await expect.poll(async () => (await nativePhasePosition(page)).snapshot.volume).toBe(0)
      await expect(page.getByText('midi-volume-fade:1', { exact: true })).toHaveCount(1)
      await evaluate(page, 'mvMusic.completed', '1'); await capture('midi-fade-complete', true)
      await click(5); await capture('midi-zero-volume-reopened', true)
      await click(6); await capture('midi-reopened-volume-restored', false)
      await evaluate(page, '(invalidate mvMusic,0)', '0')
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('midi-volume-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MIDI music volume or cleanup failed', { cause: failures[0] })
  })
