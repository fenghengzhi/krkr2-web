import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: media clock delivers period and EOF segment loops when presentation callbacks are withheld`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      const gate = { playing: false, dropped: 0 }
      Reflect.set(window, 'playbackFrameGate', gate)
      const play = HTMLMediaElement.prototype.play
      const request = HTMLVideoElement.prototype.requestVideoFrameCallback
      HTMLMediaElement.prototype.play = function () {
        if (this instanceof HTMLVideoElement) gate.playing = true
        return play.call(this)
      }
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        return request.call(this, (now, metadata) => {
          if (gate.playing) gate.dropped++
          else callback(now, metadata)
        })
      }
    })
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles([
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(`
var w=new Window();w.visible=true;w.setInnerSize(80,60);
class Movie extends VideoOverlay {
  function Movie(w){super.VideoOverlay(w);}
  function onPeriod(reason){Debug.message("clock-period="+reason);}
}
var movie=new Movie(w);movie.visible=true;movie.setBounds(0,0,64,48);
movie.open("colors-sound.mp4");movie.frame=6;movie.setSegmentLoop(6,18);
movie.setPeriodEvent(8);movie.play();Debug.message("clock-play-ready");
`),
      },
      {
        name: 'colors-sound.mp4',
        mimeType: 'video/mp4',
        buffer: readFileSync(new URL('../fixtures/video/colors-sound.mp4', import.meta.url)),
      },
    ])
    await expect(page.getByText('clock-play-ready', { exact: true })).toBeVisible()
    await page.locator('canvas').scrollIntoViewIfNeeded()
    const activate = page.getByRole('button', { name: '播放视频', exact: true })
    await expect(async () => {
      if (await activate.isVisible()) await activate.click({ timeout: 500 })
      await expect(page.getByText('clock-period=3', { exact: true }).first()).toBeVisible({
        timeout: 500,
      })
    }).toPass({ timeout: 12000 })
    await expect(page.getByText('clock-period=1', { exact: true })).toBeVisible()
    expect(
      await page.evaluate(() => Reflect.get(window, 'playbackFrameGate').dropped),
    ).toBeGreaterThan(0)
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(page.locator('video')).toHaveCount(0)
    expect(errors).toEqual([])
  })

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: video open waits for its first frame and stop releases the pending callback`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      const gate = { hold: true, held: 0, cancelled: 0, pending: new Set<number>() }
      Reflect.set(window, 'frameGate', gate)
      const request = HTMLVideoElement.prototype.requestVideoFrameCallback
      const cancel = HTMLVideoElement.prototype.cancelVideoFrameCallback
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        const id = request.call(this, (now, metadata) => {
          if (gate.hold) {
            gate.held++
            return
          }
          gate.pending.delete(id)
          callback(now, metadata)
        })
        gate.pending.add(id)
        return id
      }
      HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) {
        if (gate.pending.delete(id)) gate.cancelled++
        cancel.call(this, id)
      }
    })
    await page.goto('/?backend=' + backend)
    const files = [
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(
          'var w=new Window();w.visible=true;var movie=new VideoOverlay(w);movie.visible=true;movie.setBounds(0,0,64,48);movie.open("colors.mp4");Debug.message("frame-open-ready");',
        ),
      },
      {
        name: 'colors.mp4',
        mimeType: 'video/mp4',
        buffer: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)),
      },
    ]
    await page.locator('#files').setInputFiles(files)
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'frameGate').held)).toBe(1)
    expect(
      await page.locator('video').evaluate((v) => (v as HTMLVideoElement).readyState),
    ).toBeGreaterThanOrEqual(2)
    await expect(page.getByText('frame-open-ready', { exact: true })).toHaveCount(0)
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(page.locator('video')).toHaveCount(0)
    expect(
      await page.evaluate(() => {
        const gate = Reflect.get(window, 'frameGate')
        return [gate.pending.size, gate.cancelled]
      }),
    ).toEqual([0, 1])
    await page.evaluate(() => {
      Reflect.get(window, 'frameGate').hold = false
    })
    await page.locator('#files').setInputFiles(files)
    await expect(page.getByText('frame-open-ready', { exact: true })).toBeVisible()
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    expect(errors).toEqual([])
  })
