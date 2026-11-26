import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { installHandoffReadbacks, type ProbeWindow } from '../helpers/video-handoff-capture.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia, type VideoAudioObservation } from '../helpers/video-audio-probe.ts'
import { legacyFrameCode, legacyVideoCases, windowsMediaCases, mpeg2XvidCases, legacyVideoColors, legacyVideoGame } from '../helpers/legacy-video-game.ts'

interface ConvertedOpen {
  name: string; bytes: number; mime: string; signature?: string; sha256?: string; error?: string
  timeline: { frames: number; frameDuration: number; duration: number; audioStreams: number; videoStreams: number }
}
type ObservedWindow = Window & {
  legacyConvertedOpens(): Promise<ConvertedOpen[]>
  videoAudioObservation(): VideoAudioObservation
}

for (const group of [
  { label: 'legacy MPEG and AVI', cases: legacyVideoCases, reference: 'legacy-video-reference.json' },
  { label: 'MPEG-2 program streams and Xvid AVI with MP3', cases: mpeg2XvidCases, reference: 'mpeg2-xvid-reference.json' },
  { label: 'Windows Media WMV and ASF', cases: windowsMediaCases, reference: 'windows-media-reference.json' },
]) for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: ${group.label} movies play authored pictures and timed sound through ordinary VideoOverlay controls`, async ({ page }, info) => {
    test.setTimeout(240000)
    const cases = group.cases, legacyVideoGameSource = legacyVideoGame(cases),
      failures: unknown[] = [], errors: string[] = [], readings: unknown[] = [], traces: unknown[] = []
    let sequence = 0, failedCapture: unknown
    page.on('pageerror', (error) => errors.push(error.message))
    await observeVideoFrames(page)
    await installHandoffReadbacks(page)
    await installVideoAudioProbe(page)
    // Observe only the real Video.open on its existing port. The game still
    // supplies the original container bytes, and the backend owns conversion.
    await page.addInitScript(() => {
      const NativeChannel = MessageChannel, opens: ConvertedOpen[] = [], pending: Promise<void>[] = []
      window.MessageChannel = new Proxy(NativeChannel, { construct(target, args, newTarget) {
        const channel = Reflect.construct(target, args, newTarget) as MessageChannel
        for (const port of [channel.port1, channel.port2]) port.addEventListener('message', ({ data }) => {
          const command = data?.command, blob = command?.bytes?.blob
          if (command?.op !== 'open' || typeof command.settings?.enabledVideoStream !== 'number' ||
              !(blob instanceof Blob) || !/^legacy-/.test(command.name)) return
          if (opens.length >= 16) return
          const timeline = command.timeline, row: ConvertedOpen = { name: command.name, bytes: blob.size, mime: blob.type,
            timeline: { frames: timeline?.times?.length, frameDuration: timeline?.frameDuration,
              duration: timeline?.duration, audioStreams: timeline?.audioStreams, videoStreams: timeline?.videoStreams } }
          opens.push(row)
          pending.push((async () => {
            const bytes = await blob.arrayBuffer(), header = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength))
            row.signature = String.fromCharCode(...header.subarray(4, 8))
            row.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((v) => v.toString(16).padStart(2, '0')).join('')
          })().catch((error: unknown) => { row.error = String(error) }))
        })
        return channel
      } })
      ;(window as unknown as ObservedWindow).legacyConvertedOpens = async () => { await Promise.all(pending); return opens.map((row) => ({ ...row })) }
    })
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Legacy movie player$/ }) }).locator('canvas[data-window-id]'),
      directory = resolve('out/verification/video-tracks')
    let manifest: unknown
    const read = async (expression: string) => {
      const prefix = `legacy-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Legacy movie observer is unavailable')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(line).toBeVisible({ timeout: 5000 })
      return ((await line.textContent()) ?? '').slice(prefix.length)
    }
    const click = async (action: number) => {
      await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await canvas.click({ position: { x: ((action % 4) * 50 + 24) * box!.width / 200,
        y: (84 + Math.floor(action / 4) * 28) * box!.height / 128 }, timeout: 5000 })
    }
    const activate = async () => {
      await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音') await page.locator('#sound-toggle').click()
      await expect(async () => {
        const button = page.getByRole('button', { name: '播放视频', exact: true })
        if (await button.isVisible()) await button.click({ timeout: 500 })
        expect(await page.locator('video[data-video-id]').evaluate((video) => !(video as HTMLVideoElement).paused)).toBe(true)
      }).toPass({ timeout: 15000 })
    }
    const capture = async (phase: string, frame: number, expectedSourceFrame: number, prepared = false) => {
      const sample = await canvas.evaluate((node) => {
        const canvas = node as HTMLCanvasElement,
          video = document.querySelector<HTMLVideoElement>(`video[data-video-id][data-window-id="${canvas.dataset.windowId}"]`)
        if (!video || video.readyState < 2 || !video.paused || video.seeking) throw new Error('Legacy movie capture requires a settled paused decoder')
        return (window as unknown as ProbeWindow).handoffReadbacks.capture(video, canvas)
      })
      const digest = (pixels: readonly number[]) => createHash('sha256').update(Uint8Array.from(pixels)).digest('hex'),
        compact = { phase, clockFrame: frame, expectedSourceFrame, prepared, dropped: sample.dropped,
          media: { position: sample.media.position, paused: sample.media.paused, seeking: sample.media.seeking,
            width: sample.media.width, height: sample.media.height, sha256: digest(sample.media.pixels), frame: -1 },
          production: sample.production && { position: sample.production.position, width: sample.production.width,
            height: sample.production.height, sha256: digest(sample.production.pixels), frame: -1, center: [] as number[] },
          layers: [] as { left: number; sha256: string }[] }
      readings.push(compact)
      try {
      expect(sample.dropped).toBe(0); expect(sample.production).toBeDefined()
      expect([sample.media.width, sample.media.height]).toEqual([96, 64])
      expect(sample.media.position).toBe(frame / 25)
      compact.media.frame = legacyFrameCode(sample.media.pixels)
      expect(compact.media.frame).toBe(expectedSourceFrame)
      const actual = sample.production!.pixels, displayedFrame = legacyFrameCode(actual), colorPhase = displayedFrame < 40 ? 0 : displayedFrame < 70 ? 1 : 2,
        at = (32 * 96 + 48) * 4
      compact.production!.frame = displayedFrame; compact.production!.center = actual.slice(at, at + 4)
      if (prepared) expect(displayedFrame).toBeLessThan(40)
      else { expect(displayedFrame).toBe(expectedSourceFrame); expect(actual).toEqual(sample.media.pixels) }
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(actual[at + channel]! - legacyVideoColors[colorPhase]![channel]!)).toBeLessThanOrEqual(32)
      const white = (16 * 96 + 16 + colorPhase * 32) * 4
      for (let channel = 0; channel < 3; channel++) expect(actual[white + channel]).toBeGreaterThan(190)
      expect(actual[at + 3]).toBe(255)
      expect([sample.paint.width, sample.paint.height]).toEqual([200, 128])
      for (const left of [0, 104]) {
        const layer: number[] = []
        for (let y = 0; y < 64; y++) layer.push(...sample.paint.pixels.slice((y * 200 + left) * 4, (y * 200 + left + 96) * 4))
        compact.layers.push({ left, sha256: digest(layer) })
        // Same actual decoded frame, not equality to the lossy source codec.
        expect(layer, phase + ' bound Layer at ' + left).toEqual(actual)
      }
      return displayedFrame
      } catch (error) {
        // Keep one complete failed readback, not every successful redundant
        // CPU/GPU copy from every movie/frame in the regular report.
        failedCapture ??= { phase, sample }
        throw error
      }
    }
    try {
      const rawManifest = readFileSync(resolve(directory, group.reference)), parsed = JSON.parse(rawManifest.toString('utf8')) as {
        complete: boolean; fixtures: { file: string; aliases: string[]; bytes: number; sha256: string; normalizedVideoTimes: number[] }[]
      }
      manifest = parsed; expect(parsed.complete).toBe(true)
      const inputs = cases.map((item) => {
        const buffer = readFileSync(resolve(directory, item.file)), source = parsed.fixtures.find((f) => f.file === item.file || f.aliases.includes(item.file))!
        expect(source).toBeDefined(); expect(buffer.length).toBe(source.bytes)
        expect(createHash('sha256').update(buffer).digest('hex')).toBe(source.sha256)
        return { name: item.file, mimeType: 'application/octet-stream', buffer }
      })
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("legacy-game.tjs",System.dataPath+"legacy-game.cjs",false,true,false);Scripts.execStorage(System.dataPath+"legacy-game.cjs");'
          : 'Scripts.execStorage("legacy-game.tjs");') },
        { name: 'legacy-game.tjs', mimeType: 'text/plain', buffer: Buffer.from(legacyVideoGameSource) }, ...inputs,
      ])
      for (const [index, item] of cases.entries()) {
        if (index) await click(0)
        await expect(page.getByText(`legacy-ready:${index}:${item.file}`, { exact: true })).toBeVisible({ timeout: 90000 })
        await expect(canvas).toBeVisible()
        const meta = (await read('[legacyMovie.originalWidth,legacyMovie.originalHeight,legacyMovie.fps,legacyMovie.numberOfFrame,legacyMovie.totalTime,legacyMovie.numberOfAudioStream,legacyMovie.numberOfVideoStream].join("|")')).split('|').map(Number)
        const duration = await page.locator('video[data-video-id]').evaluate((video) => (video as HTMLVideoElement).duration),
          source = parsed.fixtures.find((f) => f.file === item.file || f.aliases.includes(item.file))!,
          sourceFrameAt = (seconds: number) => {
            let frame = 0
            for (const [at, time] of source.normalizedVideoTimes.entries()) if (time <= seconds + 1e-6) frame = at
            return frame
          }
        expect(source.normalizedVideoTimes).toHaveLength(100)
        expect(meta.slice(0, 3)).toEqual([96, 64, 25]); expect(meta[3]).toBe(Math.floor(duration * 25 + .5))
        expect(meta[4]).toBe(Math.floor(duration * 1000)); expect(meta[4]).toBeGreaterThanOrEqual(3950); expect(meta[4]).toBeLessThanOrEqual(4150)
        expect(meta.slice(5)).toEqual([item.audio ? 1 : 0, 1])
        const opens = await page.evaluate(() => (window as unknown as ObservedWindow).legacyConvertedOpens())
        expect(opens).toHaveLength(index + 1)
        const opened = opens[index]!
        expect(opened.error).toBeUndefined(); expect(opened.signature).toBe('ftyp'); expect(opened.mime).toBe('video/mp4')
        expect(opened.sha256).not.toBe(createHash('sha256').update(inputs[index]!.buffer).digest('hex'))
        expect(opened.timeline.frames).toBe(100); expect(opened.timeline.frameDuration).toBe(40)
        expect(opened.timeline.audioStreams).toBe(item.audio ? 1 : 0)
        readings.push({ file: item.file, meta, opened })
        expect((await observeVideoAudio(page)).liveUrls).toBe(1)
        await capture(item.file + '-opened', 0, sourceFrameAt(0))
        for (const [action, frame] of [[1, 25], [2, 50], [3, 80]] as const) {
          await click(action)
          await expect(page.getByText(`legacy-action:${index}:${action}:pause`, { exact: true })).toBeVisible()
          expect(await read('legacyMovie.frame+"|"+legacyMovie.position')).toBe(`${frame}|${frame * 40}`)
          await capture(item.file + '-seek-' + frame, frame, sourceFrameAt(frame / 25))
        }
        await click(4)
        await expect(page.getByText(`legacy-action:${index}:4:play`, { exact: true })).toBeVisible()
        await expect(async () => {
          const button = page.getByRole('button', { name: '播放视频', exact: true })
          if (await button.isVisible()) await button.click({ timeout: 500 })
          expect(await read('legacyState()')).toBe(`${index}|pause|0|0|1|0`)
        }).toPass({ timeout: 20000 })
        const first = await capture(item.file + '-prepared', 0, sourceFrameAt(0), true), events = (await read('legacyEvents.join("|")')).split('|'),
          returned = events.indexOf('return:play'), frameEvent = events.findIndex((event) => event.startsWith('frame:')),
          period = events.findIndex((event) => event.startsWith('period:2:'))
        expect(returned).toBeGreaterThanOrEqual(0); expect(frameEvent).toBeGreaterThan(returned); expect(period).toBeGreaterThan(frameEvent)
        expect(events.filter((event) => event.startsWith('period:2:'))).toEqual([`period:2:play:${first}:${first}`])
        traces.push({ file: item.file, prepare: events })
        await info.attach(item.file + '-prepared', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
        await click(5); await activate()
        const played = await canvas.evaluate(async (node) => {
          const stage = node as HTMLCanvasElement, video = document.querySelector<HTMLVideoElement>('video[data-video-id]')!,
            sample = new OffscreenCanvas(stage.width, stage.height), context = sample.getContext('2d', { willReadFrequently: true })!,
            records: { time: number; paused: boolean; color: number[]; audio: VideoAudioObservation }[] = [], end = performance.now() + 6000
          while (performance.now() < end && records.length < 160) {
            context.drawImage(stage, 0, 0)
            records.push({ time: video.currentTime, paused: video.paused, color: [...context.getImageData(48, 32, 1, 1).data],
              audio: (window as unknown as ObservedWindow).videoAudioObservation() })
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          return records
        })
        readings.push({ file: item.file, played })
        const intervals = item.audioOffset ? [[1.05, 1.35, 0, 440], [2.15, 2.55, 1, 660], [3.35, 3.65, 2, 880]] as const
          : [[.75, 1.3, 0, 440], [1.9, 2.45, 1, 660], [3.1, 3.65, 2, 880]] as const
        for (const [low, high, color, frequency] of intervals) {
          const phase = played.filter((sample) => sample.time >= low && sample.time <= high && !sample.paused)
          expect(phase.length, item.file + ' clock interval ' + low).toBeGreaterThanOrEqual(2)
          for (const sample of phase) {
            for (let channel = 0; channel < 3; channel++)
              expect(Math.abs(sample.color[channel]! - legacyVideoColors[color][channel]!)).toBeLessThanOrEqual(32)
            expect(sample.audio.graphs).toHaveLength(1)
            const graph = sample.audio.graphs[0]!
            expect(graph.state).toBe('running')
            if (item.audio) { expect(graph.peak).toBeGreaterThan(.04); expect(Math.abs(graph.frequency - frequency)).toBeLessThan(30) }
            else expect(graph.peak).toBeLessThan(.00001)
          }
        }
        if (item.audio) {
          // Delayed PS/ASF audio must still be silent after the unshifted
          // source would be audible: the real +0.3s offset cannot be discarded.
          const low = item.audioOffset ? .55 : .18, high = item.audioOffset ? .7 : .35,
            silent = played.filter((sample) => sample.time >= low && sample.time <= high && !sample.paused)
          expect(silent.length).toBeGreaterThanOrEqual(2)
          for (const sample of silent) expect(sample.audio.graphs[0]!.peak).toBeLessThan(.005)
        }
        await click(7)
        await expect(page.getByText(`legacy-action:${index}:7:stop`, { exact: true })).toBeVisible()
        const stopped = await read('legacyMovie.status+"|"+legacyMovie.frame+"|"+legacyMovie.position')
        expect(stopped.startsWith('stop|')).toBe(true)
        await page.waitForTimeout(200)
        expect(await read('legacyMovie.status+"|"+legacyMovie.frame+"|"+legacyMovie.position')).toBe(stopped)
        expect(await page.locator('video[data-video-id]').evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true)
        expect((await observeVideoAudio(page)).graphs[0]!.peak).toBeLessThan(.00001)
        await expect(page.locator('#logs .error')).toHaveCount(0)
      }
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('legacy-video-evidence', { body: JSON.stringify({ backend, binary, manifest, readings, traces, errors, failedCapture }), contentType: 'application/json' }),
      () => info.attach('legacy-video-authored-game', { body: legacyVideoGameSource, contentType: 'text/plain' }),
      async () => info.attach('legacy-video-runtime', { body: JSON.stringify({ opens: await page.evaluate(() => (window as unknown as ObservedWindow).legacyConvertedOpens()),
        media: await observeVideoMedia(page), audio: await observeVideoAudio(page), logs: await page.locator('#logs').innerText() }), contentType: 'application/json' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      const modal = page.locator('dialog[open]:visible').getByRole('button', { name: '停止游戏', exact: true })
      if (await modal.count()) await modal.last().press('Enter', { timeout: 5000 })
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('video,.video-plane,.game-window')).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => /session\.worker|transcode/.test(worker.url())).length).toBe(0)
      const remaining = await observeVideoAudio(page)
      expect(remaining.graphs).toHaveLength(0); expect(remaining.liveUrls).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Legacy movie decoding, playback or cleanup failed', { cause: failures[0] })
  })
