import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'
import { installVideoSourceObservation, observeVideoSources } from '../helpers/video-source-observation.ts'
import { legacyFrameCode } from '../helpers/legacy-video-game.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { writeSegmentedMovieXp3 } from '../helpers/large-video-game.ts'

const source = String.raw`
var win=new Window();win.caption="AVI cutscene";win.setInnerSize(216,176);
var root=new Layer(win,null);root.setSize(216,176);root.holdAlpha=false;root.fillRect(0,0,216,176,0xff202020);
var film=new VideoOverlay(win);film.mode=vomOverlay;film.setBounds(0,0,216,144);
var seek=new Layer(win,root);seek.setPos(0,144,108,32);seek.holdAlpha=false;seek.fillRect(0,0,108,32,0xff505060);seek.visible=true;
var play=new Layer(win,root);play.setPos(108,144,108,32);play.holdAlpha=false;play.fillRect(0,0,108,32,0xff205040);play.visible=true;
seek.drawText(4,4,"Final scene",0xffffff);play.drawText(4,4,"Play",0xffffff);
seek.onClick=function(){global.film.pause();global.film.frame=96;Debug.message("dib-final:"+global.film.frame+"|"+global.film.position);};
play.onClick=function(){global.film.frame=50;global.film.loop=true;global.film.play();Debug.message("dib-play:"+global.film.status);};
win.visible=true;film.open("legacy-large-dib.avi");film.visible=true;film.pause();
Debug.message("dib-open:"+[film.originalWidth,film.originalHeight,film.fps,film.numberOfAudioStream].join("|"));
`

for (const backend of ['asyncify', 'jspi']) for (const distribution of ['files', 'xp3'])
test(`${backend}/${distribution}: a full-size uncompressed AVI opens from disk, seeks into its final scene and plays its soundtrack`, async ({ page }, info) => {
  test.setTimeout(300000)
  await installVideoAudioProbe(page); await installVideoSourceObservation(page); await observeVideoFrames(page)
  await page.goto('/?backend=' + backend)
  test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
  const directory = await mkdtemp(join(tmpdir(), 'krkr-dib-')), fixtures = resolve('out/verification/video-tracks'),
    filename = 'legacy-large-dib.avi', movie = join(directory, filename), failures: unknown[] = [], errors: string[] = [],
    evidence: Record<string, unknown> = { backend, distribution }, canvas = page.locator('#stage canvas[data-window-id]')
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    const manifest = JSON.parse(await readFile(join(fixtures, 'large-dib-reference.json'), 'utf8')) as {
      complete: boolean; fixtures: { bytes: number; sha256: string; videoCodec: string; audioCodec: string; normalizedVideoTimes: number[];
        timeline: { frames: { pkt_pos: string }[] }; checks: { frame: number; code: number }[] }[]
    }
    expect(manifest.complete).toBe(true)
    const row = manifest.fixtures[0]!
    expect([row.videoCodec, row.audioCodec]).toEqual(['rawvideo', 'pcm_s16le'])
    expect(Number(row.timeline.frames[96]!.pkt_pos)).toBeGreaterThan(128 * 1024 ** 2)
    expect(row.checks[96]).toMatchObject({ frame: 96, code: 96 })
    expect(row.normalizedVideoTimes[96]).toBeCloseTo(3.84, 6)
    await pipeline(createReadStream(join(fixtures, filename + '.gz')), createGunzip(), createWriteStream(movie))
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(movie)) hash.update(chunk)
    expect(hash.digest('hex')).toBe(row.sha256); expect((await stat(movie)).size).toBe(row.bytes)
    Object.assign(evidence, { inputBytes: row.bytes, sourceSha256: row.sha256, finalScenePacket: row.timeline.frames[96]!.pkt_pos })
    if (distribution === 'xp3') {
      const archive = join(directory, 'data.xp3'), split = Number(row.timeline.frames[96]!.pkt_pos) + 1024
      await writeSegmentedMovieXp3(archive, movie, filename, row.bytes, split, source)
      await page.locator('#files').setInputFiles(archive)
    } else {
      const entry = join(directory, 'startup.tjs'); await writeFile(entry, source)
      await page.locator('#files').setInputFiles([entry, movie])
    }
    await expect(page.getByText('dib-open:864|576|25|1', { exact: true })).toBeVisible({ timeout: 165000 })
    const opens = await observeVideoSources(page); evidence.opens = opens
    expect(opens.opens).toHaveLength(1)
    expect(opens.opens[0]).toMatchObject({ kind: 'blob', buffered: true })
    expect(opens.opens[0]!.bytes).toBeGreaterThan(8); expect(opens.opens[0]!.bytes).toBeLessThan(128 * 1024 ** 2)
    const video = page.locator('video[data-video-id]')
    await expect(video).toBeVisible()
    if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
    const finish = await pointerPixel(canvas, 48, 159); await page.mouse.click(finish.x, finish.y)
    await expect(page.getByText('dib-final:96|3840', { exact: true })).toBeVisible()
    await expect.poll(async () => {
      const frame = await video.evaluate((node) => {
        const ctx = new OffscreenCanvas(96, 64).getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(node as HTMLVideoElement, 0, 0, 96, 64)
        return [...ctx.getImageData(0, 0, 96, 64).data]
      })
      return legacyFrameCode(frame)
    }).toBe(96)
    await info.attach('avi-final-scene', { body: await video.screenshot(), contentType: 'image/png' })
    const resume = await pointerPixel(canvas, 160, 159); await page.mouse.click(resume.x, resume.y)
    await expect(page.getByText('dib-play:play', { exact: true })).toBeVisible()
    await expect(async () => {
      const activate = page.getByRole('button', { name: '播放视频', exact: true })
      if (await activate.isVisible()) await activate.click({ timeout: 500 })
      const clock = await video.evaluate((node) => (node as HTMLVideoElement).currentTime), audio = await observeVideoAudio(page)
      expect(clock).toBeGreaterThan(1.8); expect(clock).toBeLessThan(2.7)
      expect(audio.graphs).toHaveLength(1); expect(audio.graphs[0]!.peak).toBeGreaterThan(.04)
      expect(Math.abs(audio.graphs[0]!.frequency - 660)).toBeLessThan(30)
      Object.assign(evidence, { clock, audio })
    }).toPass({ timeout: 15000 })
    await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
  } catch (error) { failures.push(error) }
  try { Object.assign(evidence, { errors, media: await observeVideoMedia(page), logs: await page.locator('#logs').innerText() })
    await info.attach('large-dib', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  } catch (error) { failures.push(error) }
  try {
    if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
    await expect(page.locator('video')).toHaveCount(0)
    expect((await observeVideoAudio(page)).liveUrls).toBe(0)
  } catch (error) { failures.push(error) }
  try { await rm(directory, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Large AVI playback or cleanup failed', { cause: failures[0] })
})
