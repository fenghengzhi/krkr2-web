import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { waveReopenExpected, waveReopenFiles, waveReopenSource } from '../helpers/wave-reopen.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture } from '../helpers/web-phase-vocoder.ts'

const buttonSource = String.raw`
var reopenWindow=new Window();reopenWindow.caption="Wave reopen";reopenWindow.setInnerSize(160,80);reopenWindow.visible=true;
var reopenRoot=new Layer(reopenWindow,null);reopenWindow.add(reopenRoot);reopenRoot.setSize(160,80);reopenRoot.fillRect(0,0,160,80,0xff203040);
var reopenButton=new Layer(reopenWindow,reopenRoot);reopenWindow.add(reopenButton);reopenButton.setPos(10,10,120,40);reopenButton.fillRect(0,0,120,40,0xff30a060);reopenButton.visible=true;
var reopenStage=0,reopenMusic;
function reopenClick(){
 if(reopenStage==0){reopenMusic=new ReopenWave();reopenMusic.open("reopen-a.wav");reopenMusic.looping=true;reopenMusic.play();reopenMusic.fade(0,1000000000);}
 else if(reopenStage==1){reopenMusic.open("reopen-b.wav");reopenMusic.play();}
 else if(reopenStage==2){try{reopenMusic.open("missing-reopen.wav");}catch(e){Debug.message("reopen-missing:"+reopenMusic.status);}}
 else if(reopenStage==3){reopenMusic.open("reopen-a.wav");reopenMusic.play();}
 else return;
 reopenStage++;Debug.message("reopen-stage:"+reopenStage+":"+[reopenMusic.status,reopenMusic.volume,reopenMusic.completed.count].join(","));
}
reopenButton.onClick=function(){global.reopenClick();};
Debug.message("reopen-button-ready");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real game clicks reopen Wave music without completing its inherited fade or retaining old PCM`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("reopen-control.tjs","savedata/reopen-control.cjs",false,true,false);Scripts.execStorage("savedata/reopen-control.cjs");'
          : 'Scripts.execStorage("reopen-control.tjs");') },
        { name: 'reopen-control.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveReopenSource + buttonSource) },
        ...Object.entries(waveReopenFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('reopen-button-ready', { exact: true })).toBeVisible()
      for (const [kind, expected] of Object.entries(waveReopenExpected))
        await evaluate(page, `waveReopenObserve("${kind}")`, expected)
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      const button = page.locator('canvas[data-window-id]').first(),
        click = async (stage: number, expected: string) => {
          await button.click({ position: { x: 40, y: 25 } })
          await expect(page.getByText(`reopen-stage:${stage}:${expected}`, { exact: true })).toHaveCount(1)
        }, capture = async (name: string, expected: number) => {
          await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(expected)
          await beginPhaseCapture(page, 0.2)
          const output = await endPhaseCapture(page)
          await attachPhaseCapture(info, name, output, { expected })
          expect(output.channels.length).toBe(2)
          for (const channel of output.channels) {
            expect(channel.length).toBeGreaterThan(0)
            expect(channel).toEqual(Array(channel.length).fill(expected))
          }
        }
      await click(1, 'play,100000,0')
      await openPhaseCapture(page)
      await capture('wave-first-media', 0.5)
      await click(2, 'play,100000,0')
      await capture('wave-reopened-media', 0.25)
      await click(3, 'unload,100000,0')
      await expect(page.getByText('reopen-missing:unload', { exact: true })).toHaveCount(1)
      await capture('wave-failed-media-retired', 0)
      await click(4, 'play,100000,0')
      await capture('wave-recovered-media', 0.5)
      await evaluate(page, '(reopenMusic.stopFade(),[reopenMusic.status,reopenMusic.volume,reopenMusic.completed.join(",")].join("|"))', 'play|0|0')
      await capture('wave-original-fade-target', 0)
      await evaluate(page, '(invalidate reopenMusic,int(!isvalid reopenMusic))', '1')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-reopen-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave game input/playback or cleanup failed', { cause: failures[0] })
  })
