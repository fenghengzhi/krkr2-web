import { expect, type Page, type TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { wave } from './audio.ts'

type AudioProbe = typeof globalThis & { __audioProbe: AudioWorkletNode; __audioSerial?: number }
type VideoProbe = typeof globalThis & {
  __videoClockProbe?: { setter: boolean; records: unknown[] }
}

/** Diagnostic only: preserve native methods, record event/seek ordering with bounded storage. */
export async function injectVideoClockProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = globalThis as VideoProbe,
      probe: NonNullable<VideoProbe['__videoClockProbe']> = { setter: false, records: [] },
      descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
    state.__videoClockProbe = probe
    const record = (
      video: HTMLVideoElement,
      event: string,
      extra: Record<string, unknown> = {},
    ) => {
      try {
        probe.records.push({
          event,
          at: performance.now(),
          id: video.dataset.videoId,
          position: descriptor?.get ? descriptor.get.call(video) : video.currentTime,
          duration: video.duration,
          paused: video.paused,
          seeking: video.seeking,
          ended: video.ended,
          ready: video.readyState,
          visibility: document.visibilityState,
          ...extra,
        })
        if (probe.records.length > 256) probe.records.shift()
      } catch {
        /* A diagnostic must not change a native media operation. */
      }
    }
    if (descriptor?.get && descriptor.set && descriptor.configurable) {
      const set = descriptor.set
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        ...descriptor,
        set(this: HTMLMediaElement, value: number) {
          if (this instanceof HTMLVideoElement)
            record(this, 'seek-request', {
              requested: value,
              stack: new Error().stack?.slice(0, 1200),
            })
          set.call(this, value)
        },
      })
      probe.setter = true
    }
    for (const name of [
      'loadedmetadata',
      'loadeddata',
      'play',
      'playing',
      'pause',
      'ended',
      'seeking',
      'seeked',
      'timeupdate',
      'emptied',
      'error',
    ])
      document.addEventListener(
        name,
        (event) => {
          if (event.target instanceof HTMLVideoElement)
            record(event.target, name, { trusted: event.isTrusted })
        },
        true,
      )
    for (const name of ['visibilitychange', 'freeze', 'resume'])
      document.addEventListener(
        name,
        (event) => {
          for (const video of document.querySelectorAll('video'))
            record(video, name, { trusted: event.isTrusted })
        },
        true,
      )
  })
}
export async function attachVideoClockProbe(page: Page, testInfo: TestInfo): Promise<void> {
  const data = await page
    .evaluate(() => (globalThis as VideoProbe).__videoClockProbe)
    .catch(() => undefined)
  const path = testInfo.outputPath('media-clock.json')
  await writeFile(path, JSON.stringify(data ?? { unavailable: true }, null, 2) + '\n')
  await testInfo.attach('media-clock', { path, contentType: 'application/json' })
}
export async function audioPosition(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const state = globalThis as AudioProbe,
          port = state.__audioProbe.port,
          serial = (state.__audioSerial = (state.__audioSerial ?? 0) - 1)
        const finish = (event: MessageEvent) => {
          if (event.data.type !== 'reply' || event.data.serial !== serial) return
          clearTimeout(timer)
          port.removeEventListener('message', finish)
          if (event.data.error) reject(new Error(event.data.error))
          else resolve(event.data.result.snapshot.position)
        }
        const timer = setTimeout(() => {
          port.removeEventListener('message', finish)
          reject(new Error('Mixer probe timed out'))
        }, 3000)
        port.addEventListener('message', finish)
        port.postMessage({ serial, command: { op: 'inspect', id: 1 } })
      }),
  )
}

export async function injectAudioProbe(page: Page) {
  await page.addInitScript(() => {
    const Original = window.AudioWorkletNode
    window.AudioWorkletNode = class extends Original {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options)
        if (name === 'krkr2-mixer') (globalThis as AudioProbe).__audioProbe = this
      }
    }
  })
}

export async function loadMedia(page: Page, backend: string, baseURL = '') {
  await page.goto(`${baseURL}/?backend=${backend}`)
  await page.locator('#files').setInputFiles([
    {
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(String.raw`
var window=new Window();window.visible=true;window.setInnerSize(160,80);
var root=new Layer(window,null),screen=new Layer(window,root);root.setSize(160,80);screen.setSize(160,80);screen.visible=true;
var sound=new WaveSoundBuffer(null);sound.open("tone.wav");sound.looping=true;sound.play();
var movie=new VideoOverlay(window);movie.mode=vomLayer;movie.layer1=screen;movie.open("movie.mp4");movie.loop=true;movie.play();
Debug.message("lifecycle-media-ready");
`),
    },
    {
      name: 'tone.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from(
        wave(
          Array.from({ length: 44100 }, (_, i) => Math.sin((i * 2 * Math.PI * 440) / 44100) * 0.3),
          44100,
        ),
      ),
    },
    {
      name: 'movie.mp4',
      mimeType: 'video/mp4',
      buffer: await readFile(new URL('../fixtures/video/colors-sound.mp4', import.meta.url)),
    },
  ])
  await expect(page.locator('#logs')).toContainText('lifecycle-media-ready')
  if ((await page.locator('#sound-toggle').textContent()) === '开启声音')
    await page.locator('#sound-toggle').click()
  const movie = page.locator('video')
  await expect(async () => {
    const button = page.getByRole('button', { name: '播放视频', exact: true })
    if (await button.isVisible()) await button.click({ timeout: 500 })
    await expect(movie).toHaveJSProperty('paused', false, { timeout: 500 })
    expect(
      await movie.evaluate((element) => (element as HTMLVideoElement).currentTime),
    ).toBeGreaterThan(0)
  }).toPass({ timeout: 12000 })
  await expect
    .poll(() => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value))
    .toBeGreaterThan(0.01)
  return movie
}
