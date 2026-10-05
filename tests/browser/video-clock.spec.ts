import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
for (const container of ['numbered-multitrack', 'numbered-fragmented']) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}/${container}: public video clock follows stream cadence and integral media time`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = [], failures: unknown[] = [], readings: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeVideoFrames(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const source = String.raw`
var clockWindow=new Window();clockWindow.visible=true;clockWindow.setInnerSize(96,64);
var clockMovie=new VideoOverlay(clockWindow);clockMovie.visible=true;clockMovie.setBounds(0,0,64,48);
clockMovie.open("clock.mp4");clockMovie.pause();
Debug.message("clock-ready");
`
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("clock.tjs","savedata/clock.cjs",false,true,false);Scripts.execStorage("savedata/clock.cjs");'
          : 'Scripts.execStorage("clock.tjs");') },
        { name: 'clock.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
        { name: 'clock.mp4', mimeType: 'video/mp4', buffer: readFileSync(resolve(`out/verification/video-tracks/${container}.mp4`)) },
      ])
      await expect(page.getByText('clock-ready', { exact: true })).toBeVisible()
      const video = page.locator('video[data-video-id]')
      const inspect = () => video.evaluate((element) => {
        const video = element as HTMLVideoElement
        return { position: video.currentTime, duration: video.duration, paused: video.paused,
          seeking: video.seeking, ready: video.readyState, presentedTime: video.dataset.presentedTime }
      })
      const opened = await inspect()
      readings.push({ phase: 'opened', ...opened })
      // Cadence comes from the declared 12 fps source, not count / HTML duration.
      await evaluate(page, 'clockMovie.fps', '12')
      await evaluate(page, 'clockMovie.numberOfFrame', String(Math.trunc(opened.duration * 12 + 0.5)))
      await evaluate(page, 'clockMovie.totalTime', String(Math.trunc(opened.duration * 1000)))
      await evaluate(page, '(function(){clockMovie.frame=10;return clockMovie.frame+","+clockMovie.position;})()', '10,833')
      const sought = await inspect()
      readings.push({ phase: 'script-frame-10', ...sought })
      expect(sought.paused).toBe(true)
      expect(sought.seeking).toBe(false)
      expect(sought.ready).toBeGreaterThanOrEqual(2)
      expect(Math.abs(sought.position - 5 / 6)).toBeLessThanOrEqual(0.000001)
      // Feed the real decoder a sub-millisecond position which the integer TJS
      // setter cannot express. No clock getter, callback or image is mocked.
      await video.evaluate((element) => new Promise<void>((resolve, reject) => {
        const video = element as HTMLVideoElement,
          timer = setTimeout(() => done(new Error('Fractional clock fixture seek timed out')), 12000),
          seeked = () => { if (!video.seeking && video.readyState >= 2) done() },
          failed = () => done(new Error('Fractional clock fixture decode failed'))
        function done(error?: Error) {
          clearTimeout(timer); video.removeEventListener('seeked', seeked); video.removeEventListener('error', failed)
          error ? reject(error) : resolve()
        }
        video.addEventListener('seeked', seeked); video.addEventListener('error', failed)
        video.currentTime = 0.1296
      }))
      const fractional = await inspect()
      readings.push({ phase: 'native-decoder-fractional-clock', ...fractional })
      expect(Math.abs(fractional.position - 0.1296)).toBeLessThanOrEqual(0.000001)
      await evaluate(page, 'clockMovie.position+","+clockMovie.frame+","+clockMovie.fps', '130,2,12')
      await evaluate(page, '(function(){clockMovie.frame=6;return clockMovie.frame+","+clockMovie.position;})()', '6,500')
      readings.push({ phase: 'script-frame-6', ...await inspect() })
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('public-video-clock', { body: JSON.stringify({ backend, binary, container, readings, errors,
      logs: await page.locator('#logs').innerText() }), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('video,.video-plane')).toHaveCount(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Video clock scenario and cleanup failed', { cause: failures[0] })
  })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a VFR public frame seek accepts a real presentation within its sample interval`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = [], failures: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeVideoFrames(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const source = String.raw`
var variableWindow=new Window();variableWindow.visible=true;variableWindow.setInnerSize(96,64);
var variableMovie=new VideoOverlay(variableWindow);variableMovie.visible=true;variableMovie.setBounds(0,0,64,48);
variableMovie.open("variable.mp4");variableMovie.pause();Debug.message("variable-ready");
`
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("variable.tjs","savedata/variable.cjs",false,true,false);Scripts.execStorage("savedata/variable.cjs");'
          : 'Scripts.execStorage("variable.tjs");') },
        { name: 'variable.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
        { name: 'variable.mp4', mimeType: 'video/mp4', buffer: readFileSync(resolve('out/verification/video-tracks/numbered-variable.mp4')) },
      ])
      await expect(page.getByText('variable-ready', { exact: true })).toBeVisible()
      await evaluate(page, 'variableMovie.fps', '12')
      // Nominal VUI frame 2 lies inside the existing uneven interval for
      // decoded picture 1. Keep the original independent barcode observation.
      await evaluate(page, '(function(){variableMovie.frame=2;return variableMovie.frame+","+variableMovie.position;})()', '2,167')
      const state = await page.locator('video[data-video-id]').evaluate((node) => {
        const video = node as HTMLVideoElement, canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight),
          context = canvas.getContext('2d')!
        context.drawImage(video, 0, 0)
        return { position: video.currentTime, presentedTime: Number(video.dataset.presentedTime),
          paused: video.paused, seeking: video.seeking, ready: video.readyState,
          width: canvas.width, height: canvas.height, pixels: [...context.getImageData(0, 0, canvas.width, canvas.height).data] }
      })
      expect(state.paused).toBe(true)
      expect(state.seeking).toBe(false)
      expect(state.ready).toBeGreaterThanOrEqual(2)
      expect(Math.abs(state.position - 1 / 6)).toBeLessThanOrEqual(0.000001)
      // The generated first interval is [1/12, 1/4). Both an exact PTS and a
      // requested-position callback must remain inside that same real interval.
      expect(state.presentedTime).toBeGreaterThanOrEqual(1 / 12 - 0.000001)
      expect(state.presentedTime).toBeLessThan(0.25)
      expect([state.width, state.height, state.pixels.length]).toEqual([64, 48, 12288])
      // Independent source barcode: frame 1 has only its least-significant
      // stripe bright. Interior grayscale bounds allow H.264 quantization;
      // they identify this source image, not a byte-perfect codec comparison.
      for (let bit = 0; bit < 7; bit++) {
        const at = (8 * 64 + 8 + bit * 8) * 4
        for (let channel = 0; channel < 3; channel++) {
          if (bit === 0) expect(state.pixels[at + channel]).toBeGreaterThan(220)
          else expect(state.pixels[at + channel]).toBeLessThan(40)
        }
        expect(state.pixels[at + 3]).toBe(255)
      }
      await info.attach('vfr-frame-seek', { body: JSON.stringify({ backend, binary, state }), contentType: 'application/json' })
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try {
      await info.attach('vfr-clock-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('video,.video-plane')).toHaveCount(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'VFR clock scenario and cleanup failed', { cause: failures[0] })
  })
}
