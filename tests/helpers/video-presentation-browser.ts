import { test as base, expect } from '@playwright/test'

type ProbeWindow = Window & { videoPresentation?: unknown[] }
export const test = base.extend<{ presentation: void }>({
  presentation: [
    async ({ page }, use, testInfo) => {
      if (process.env.KRKR_VIDEO_DIAGNOSTIC !== '1') return use()
      await page.addInitScript(() => {
        const records: unknown[] = []
        ;(window as ProbeWindow).videoPresentation = records
        const source = new OffscreenCanvas(1, 1),
          context = source.getContext('2d')!
        const record = (video: HTMLVideoElement, event: string, extra: unknown = {}) => {
          let pixels: number[] | string = []
          try {
            if (video.readyState >= 2) {
              context.drawImage(video, 0, 0, 1, 1)
              pixels = [...context.getImageData(0, 0, 1, 1).data]
            }
          } catch (error) {
            pixels = String(error)
          }
          records.push({
            event,
            at: performance.now(),
            position: video.currentTime,
            seeking: video.seeking,
            ready: video.readyState,
            paused: video.paused,
            pixels,
            extra,
          })
          if (records.length > 512) records.shift()
        }
        const descriptor = Object.getOwnPropertyDescriptor(
          HTMLMediaElement.prototype,
          'currentTime',
        )!
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
          ...descriptor,
          set(this: HTMLMediaElement, value: number) {
            if (this instanceof HTMLVideoElement) record(this, 'seek-request', { value })
            descriptor.set!.call(this, value)
          },
        })
        for (const name of [
          'loadedmetadata',
          'loadeddata',
          'seeking',
          'seeked',
          'play',
          'playing',
          'pause',
          'error',
        ])
          document.addEventListener(
            name,
            (event) => {
              if (!(event.target instanceof HTMLVideoElement)) return
              const video = event.target
              record(video, name)
              if (name === 'loadedmetadata') {
                const frame: VideoFrameRequestCallback = (_now, metadata) => {
                  record(video, 'presented', metadata)
                  if (video.isConnected) video.requestVideoFrameCallback(frame)
                }
                video.requestVideoFrameCallback(frame)
              }
            },
            true,
          )
      })
      await use()
      const data = await page
        .evaluate(() => ({
          records: (window as ProbeWindow).videoPresentation,
          videos: [...document.querySelectorAll('video')].map((video) => ({
            position: video.currentTime,
            seeking: video.seeking,
            ready: video.readyState,
            paused: video.paused,
          })),
        }))
        .catch((error: unknown) => ({ error: String(error) }))
      await testInfo.attach('video-presentation', {
        body: JSON.stringify(data, null, 2),
        contentType: 'application/json',
      })
    },
    { auto: true },
  ],
})
export { expect }
