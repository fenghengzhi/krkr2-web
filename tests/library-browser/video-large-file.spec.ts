import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../helpers/library-browser.ts'
import { largeVideoGame } from '../helpers/large-video-game.ts'
import { observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { installVideoSourceObservation, observeVideoSources } from '../helpers/video-source-observation.ts'

test('a saved XP3 plays its 144 MiB cutscene from verified OPFS blocks after refresh', async ({ page }, info) => {
  test.setTimeout(150000)
  const directory = await mkdtemp(join(tmpdir(), 'krkr-library-cutscene-'))
  try {
    await observeVideoFrames(page)
    await installVideoSourceObservation(page)
    await page.goto('/?backend=asyncify')
    const { paths, size } = await largeVideoGame(directory, true, `
var w=new Window();w.setInnerSize(96,84);w.visible=true;
var root=new Layer(w,null);root.setSize(96,84);
var button=new Layer(w,root);button.setPos(0,62,96,22);button.fillRect(0,0,96,22,0xff408060);button.visible=true;
var film=new VideoOverlay(w);film.mode=vomMixer;film.visible=true;film.setBounds(0,0,80,60);
button.onClick=function(){
 global.film.open("cutscene.mp4");global.film.pause();global.film.enabledVideoStream=1;global.film.position=3000;
 Debug.message("library-cutscene:"+[global.film.enabledVideoStream,global.film.numberOfVideoStream,global.film.position,global.film.status].join("|"));
};
Debug.message("library-cutscene-menu");
`)
    await page.locator('#files').setInputFiles(paths)
    await expect(page.getByText('library-cutscene-menu', { exact: true })).toBeVisible()
    await page.locator('#library-title').fill('Cutscene gallery')
    await page.locator('#save-library').click()
    await expect(page.locator('#library-games h3')).toHaveText('Cutscene gallery', { timeout: 60000 })
    await expect(page.locator('#cancel-library')).toBeHidden()
    await page.reload()
    await rm(directory, { recursive: true, force: true })
    await page.locator('.library-game').getByRole('button', { name: '启动', exact: true }).click()
    await expect(page.getByText('library-cutscene-menu', { exact: true })).toBeVisible()
    await page.locator('canvas[data-window-id]').click({ position: { x: 32, y: 74 } })
    await expect(page.getByText('library-cutscene:1|2|3000|pause', { exact: true })).toBeVisible({ timeout: 30000 })
    const sources = await observeVideoSources(page)
    expect(sources.opens).toHaveLength(1)
    expect(sources.opens[0]).toMatchObject({ kind: 'blob', buffered: false, bytes: size })
    const video = page.locator('video[data-video-id]')
    await expect(video).toHaveAttribute('data-presented-frames', /^[1-9]\d*$/)
    const frame = await video.evaluate((node) => {
      const movie = node as HTMLVideoElement, ctx = new OffscreenCanvas(80, 60).getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(movie, 0, 0)
      return { width: movie.videoWidth, height: movie.videoHeight, clock: movie.currentTime,
        paused: movie.paused, frames: Number(movie.dataset.presentedFrames),
        blue: [...ctx.getImageData(30, 25, 1, 1).data], yellow: [...ctx.getImageData(64, 47, 1, 1).data] }
    })
    expect([frame.width, frame.height, frame.clock, frame.paused]).toEqual([80, 60, 3, true])
    expect(frame.frames).toBeGreaterThan(0)
    expect(frame.blue[2]).toBeGreaterThan(175); expect(frame.blue[0]).toBeLessThan(105)
    expect(frame.yellow[0]).toBeGreaterThan(190); expect(frame.yellow[1]).toBeGreaterThan(190); expect(frame.yellow[2]).toBeLessThan(80)
    await info.attach('library-movie', { contentType: 'image/png', body: await video.screenshot() })
    await expect(page.locator('#logs .error')).toHaveCount(0)
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(video).toHaveCount(0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
