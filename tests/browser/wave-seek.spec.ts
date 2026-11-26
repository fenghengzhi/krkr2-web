import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { waveSeekFiles, waveSeekSource } from '../helpers/wave-seek.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

const buttonSource = String.raw`
var seekWindow=new Window();seekWindow.caption="Wave seek";seekWindow.setInnerSize(160,80);seekWindow.visible=true;
var seekRoot=new Layer(seekWindow,null);seekWindow.add(seekRoot);seekRoot.setSize(160,80);seekRoot.fillRect(0,0,160,80,0xff203040);
var seekButton=new Layer(seekWindow,seekRoot);seekWindow.add(seekButton);seekButton.setPos(10,10,120,40);seekButton.fillRect(0,0,120,40,0xff30a060);seekButton.visible=true;
var seekMusic=new SeekWave(),seekClicks=0;
seekMusic.open("seek-constant.wav");seekMusic.paused=true;seekMusic.play();seekMusic.position=1;
function waveSeekClick(){waveSeekInvalid(seekMusic,1323000);seekMusic.paused=false;seekClicks++;Debug.message("seek-click:"+seekClicks+":"+seekMusic.status);}
seekButton.onClick=function(){global.waveSeekClick();};
Debug.message("wave-seek-button-ready");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real Wave seek buttons retain audible music and exact paused sample boundaries`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("seek.tjs","savedata/seek.cjs",false,true,false);Scripts.execStorage("savedata/seek.cjs");'
          : 'Scripts.execStorage("seek.tjs");') },
        { name: 'seek.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveSeekSource + buttonSource) },
        ...Object.entries(waveSeekFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('wave-seek-button-ready', { exact: true })).toBeVisible()
      await evaluate(page, '(waveSeekInvalid(seekMusic,1323000),[seekMusic.samplePosition,seekMusic.position,seekMusic.paused,seekMusic.status].join("|"))', '44|0|1|play')
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await openPhaseCapture(page)
      const capture = async (name: string, expected: number) => {
        await beginPhaseCapture(page, 0.2)
        const output = await endPhaseCapture(page)
        await attachPhaseCapture(info, name, output, { expected })
        expect(output.channels).toHaveLength(2)
        for (const channel of output.channels) {
          expect(channel.length).toBeGreaterThan(0)
          expect(channel).toEqual(Array(channel.length).fill(expected))
        }
      }
      await capture('wave-seek-paused', 0)
      await evaluate(page, '[seekMusic.samplePosition,seekMusic.paused].join(",")', '44,1')
      const button = page.locator('canvas[data-window-id]').first()
      await button.click({ position: { x: 40, y: 25 } })
      await expect(page.getByText('seek-click:1:play', { exact: true })).toHaveCount(1)
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0.25)
      await capture('wave-seek-playing', 0.25)
      const before = await nativePhasePosition(page)
      await button.click({ position: { x: 40, y: 25 } })
      await expect(page.getByText('seek-click:2:play', { exact: true })).toHaveCount(1)
      const after = await nativePhasePosition(page)
      expect(after.snapshot.epoch).toBe(before.snapshot.epoch)
      expect(after.snapshot.position).toBeGreaterThanOrEqual(before.snapshot.position)
      await capture('wave-seek-rejected-while-playing', 0.25)
      await evaluate(page, '(seekMusic.paused=true,seekMusic.position=1,[seekMusic.samplePosition,seekMusic.status].join(","))', '44,play')
      await capture('wave-seek-repaused', 0)
      await evaluate(page, '(seekMusic.position=4611686018427387904,seekMusic.samplePosition)', '0')
      // The short, nonconstant file provides actual SLI observations at both
      // boundaries; the SDK independently runs the same first-label controls.
      await evaluate(page, '(seekMusic.open("seek.wav"),seekMusic.position=1,seekMusic.looping=true,seekMusic.play(),0)', '0')
      await expect.poll(async () => {
        const snapshot = await nativePhasePosition(page)
        return snapshot.snapshot.position
      }).toBeGreaterThan(1000)
      await evaluate(page, '[seekMusic.markers[0],seekMusic.markers[1],seekMusic.markers[2]].join(",")', 'ms44,sample45,later')
      await evaluate(page, '(seekMusic.stop(),invalidate seekMusic,0)', '0')
      await capture('wave-seek-retired', 0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-seek-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave seek browser or cleanup failed', { cause: failures[0] })
  })
