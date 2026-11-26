import { mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'
import { largeVideoGame } from '../helpers/large-video-game.ts'
import { largeVideoDisc } from '../helpers/large-video-disc.ts'
import { installVideoSourceObservation, observeVideoSources } from '../helpers/video-source-observation.ts'
import { temporaryMovieDirectory } from '../../src/backends/files/temporary-movies.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'

const game = String.raw`
var w=new Window();w.setInnerSize(96,84);w.visible=true;
var root=new Layer(w,null);root.setSize(96,84);root.fillRect(0,0,96,84,0xff000000);
var screen=new Layer(w,root);screen.visible=true;
var button=new Layer(w,root);button.setPos(0,64,96,20);button.fillRect(0,0,96,20,0xff408060);button.visible=true;
var film=new VideoOverlay(w);film.mode=vomLayer;film.layer1=screen;
film.open("cutscene.mp4");film.visible=true;film.pause();film.position=1000;
var phase=0;
function report(){Debug.message("cutscene:"+[phase,film.numberOfVideoStream,film.numberOfAudioStream,film.enabledVideoStream,film.enabledAudioStream,film.originalWidth,film.originalHeight,film.position,film.status].join("|"));}
button.onClick=function(){
 if(global.phase==0){global.film.enabledVideoStream=1;global.film.enabledAudioStream=1;global.film.position=3000;global.phase=1;global.report();}
 else if(global.phase==1){global.film.play();global.phase=2;Debug.message("cutscene-playing");}
 else if(global.phase==2){global.film.close();global.phase=3;Debug.message("cutscene-closed");}
};
report();
`

for (const mode of ['loose', 'xp3', 'disc', 'raw-cue', 'deflated-zip']) for (const backend of ['asyncify', 'jspi'])
  test(`${backend}/${mode}: play a two-track movie whose packets and index are past 144 MiB`, async ({ page }, info) => {
    test.setTimeout(120000)
    await installVideoAudioProbe(page)
    await installVideoSourceObservation(page)
    await observeVideoFrames(page)
    await page.goto('/?backend=' + backend)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const directory = await mkdtemp(join(tmpdir(), 'krkr-game-cutscene-')), observations: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const canvas = page.locator('canvas[data-window-id]').first()
    try {
      const disc = mode === 'disc' || mode === 'raw-cue'
      const staged = mode === 'raw-cue' || mode === 'deflated-zip'
      const asset = disc
        ? await largeVideoDisc(directory, game.replace('film.open("cutscene.mp4")', 'film.open("D:/MOVIE.MP4")'), mode === 'raw-cue')
        : await largeVideoGame(directory, mode === 'xp3', game)
      if (disc) await page.locator('#cdda-discs').fill(mode === 'raw-cue' ? 'D=Game.cue' : 'D=Game.iso')
      const temporarySizes = () => page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const folder = await root.getDirectoryHandle(name) as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }
        const sizes = []
        for await (const key of folder.keys()) sizes.push((await (await folder.getFileHandle(key)).getFile()).size)
        return sizes
      }, temporaryMovieDirectory)
      observations.push({ size: asset.size, firstPacketRegion: asset.mediaStart })
      if (mode === 'deflated-zip') {
        execFileSync('python3', ['-m', 'zipfile', '-c', 'Release.zip', 'startup.tjs', 'cutscene.mp4'], { cwd: directory })
        await page.locator('#project-mode').selectOption('auto')
        await page.locator('#files').setInputFiles(join(directory, 'Release.zip'))
      } else await page.locator('#files').setInputFiles(asset.paths)
      await expect.poll(async () => (await observeVideoSources(page)).opens.length, { timeout: staged ? 70000 : 30000 }).toBe(1)
      const sources = await observeVideoSources(page)
      observations.push(sources)
      expect(sources.dropped).toBe(0)
      expect(sources.opens).toHaveLength(1)
      expect(sources.opens[0]).toMatchObject({ kind: 'blob', buffered: false, bytes: asset.size })
      if (staged) {
        const sizes = await temporarySizes()
        observations.push({ temporaryFilesAtOpen: sizes })
        expect(sizes).toEqual([asset.size])
      }
      await expect(page.getByText('cutscene:0|2|2|0|0|64|48|1000|pause', { exact: true })).toBeVisible({ timeout: 30000 })
      const picture = async (alternate: boolean) => {
        const video = page.locator('video[data-video-id]')
        // The game log and its canvas update arrive on separate worker messages.
        await expect(async () => {
          const actual = await video.evaluate((node, other) => {
            const video = node as HTMLVideoElement, canvas = document.querySelector<HTMLCanvasElement>('canvas[data-window-id]')!
            const samples = (target: HTMLVideoElement | HTMLCanvasElement) => {
              const context = new OffscreenCanvas(96, 84).getContext('2d', { willReadFrequently: true })!
              context.drawImage(target, 0, 0)
              return [[30, 25], other ? [64, 47] : [10, 10]].map(([x, y]) => [...context.getImageData(x!, y!, 1, 1).data])
            }
            return { decoded: samples(video), screen: samples(canvas), width: video.videoWidth, height: video.videoHeight,
              position: video.currentTime, paused: video.paused, submitted: Number(video.dataset.presentedFrames) }
          }, alternate)
          observations.push(actual)
          expect([actual.width, actual.height]).toEqual(alternate ? [80, 60] : [64, 48])
          expect(actual.paused).toBe(true); expect(actual.submitted).toBeGreaterThan(0)
          expect(actual.position).toBeCloseTo(alternate ? 3 : 1, 6)
          // Both the actual decoder and the rendered game must show the authored
          // coloured background and the marker belonging to the chosen track.
          for (const pixels of [actual.decoded, actual.screen]) {
            const [bg, mark] = pixels
            expect(bg![alternate ? 2 : 0]).toBeGreaterThan(175)
            expect(bg![alternate ? 0 : 2]).toBeLessThan(105)
            expect(mark![0]).toBeGreaterThan(190); expect(mark![1]).toBeGreaterThan(190)
            if (alternate) expect(mark![2]).toBeLessThan(80)
            else expect(mark![2]).toBeGreaterThan(190)
            expect(mark![3]).toBe(255)
          }
        }).toPass({ timeout: 5000 })
        await info.attach(alternate ? 'second-track' : 'first-track', { body: await canvas.screenshot(), contentType: 'image/png' })
      }
      await picture(false)
      const pressButton = async () => {
        const point = await pointerPixel(canvas, 30, 74)
        await page.mouse.click(point.x, point.y)
      }
      await pressButton()
      await expect(page.getByText('cutscene:1|2|2|1|1|80|60|3000|pause', { exact: true })).toBeVisible({ timeout: 30000 })
      await picture(true)
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音') await page.locator('#sound-toggle').click()
      await pressButton()
      await expect(page.getByText('cutscene-playing', { exact: true })).toBeVisible()
      await expect(async () => {
        const activation = page.getByRole('button', { name: '播放视频', exact: true })
        if (await activation.isVisible()) await activation.click({ timeout: 500 })
        const audio = await observeVideoAudio(page)
        expect(audio.graphs).toHaveLength(1)
        expect(audio.graphs[0]!.peak).toBeGreaterThan(0.01)
        expect(Math.abs(audio.graphs[0]!.frequency - 880)).toBeLessThan(25)
        expect((await observeVideoMedia(page)).videos[0]!.position).toBeGreaterThan(3)
      }).toPass({ timeout: 10000 })
      observations.push(await observeVideoAudio(page))
      await expect(page.locator('#logs .error')).toHaveCount(0)
      if (staged) {
        await pressButton()
        await expect(page.getByText('cutscene-closed', { exact: true })).toBeVisible()
        await expect.poll(temporarySizes).toEqual([])
      }
      await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('video')).toHaveCount(0)
      const stopped = await observeVideoAudio(page)
      expect(stopped.graphs).toHaveLength(0); expect(stopped.liveUrls).toBe(0)
      expect(stopped.revokedUrls).toBe(stopped.createdUrls)
      expect(errors).toEqual([])
    } finally {
      try {
        await info.attach('large-cutscene', { body: JSON.stringify({ mode, backend, observations, errors,
          media: await observeVideoMedia(page), logs: await page.locator('#logs').innerText() }), contentType: 'application/json' })
      } finally { await rm(directory, { recursive: true, force: true }) }
    }
  })
