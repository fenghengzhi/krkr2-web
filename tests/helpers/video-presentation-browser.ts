import { test as base, expect, type Page } from '@playwright/test'

/** Observe the frame submitted for presentation, separately from seek completion. */
export async function observeVideoFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener(
      'loadedmetadata',
      (event) => {
        if (!(event.target instanceof HTMLVideoElement)) return
        const video = event.target
        const frame: VideoFrameRequestCallback = (_now, metadata) => {
          video.dataset.presentedTime = String(metadata.mediaTime)
          video.dataset.presentedFrames = String(metadata.presentedFrames)
          if (video.isConnected) video.requestVideoFrameCallback(frame)
        }
        video.requestVideoFrameCallback(frame)
      },
      true,
    )
  })
}

type ProbeWindow = Window & { videoPresentation?: unknown[] }
export const test = base.extend<{ presentation: void }>({
  presentation: [
    async ({ page }, use, testInfo) => {
      if (process.env.KRKR_VIDEO_DIAGNOSTIC !== '1') return use()
      await page.addInitScript((firstFrameBarrier: boolean) => {
        const records: unknown[] = []
        const presented = new WeakSet<HTMLVideoElement>()
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
            if (firstFrameBarrier && this instanceof HTMLVideoElement && !presented.has(this)) {
              const video = this
              record(video, 'seek-deferred', { value })
              video.requestVideoFrameCallback(() => {
                record(video, 'seek-released', { value })
                descriptor.set!.call(video, value)
              })
              return
            }
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
                  presented.add(video)
                  record(video, 'presented', metadata)
                  if (video.isConnected) video.requestVideoFrameCallback(frame)
                }
                video.requestVideoFrameCallback(frame)
              }
            },
            true,
          )
      }, process.env.KRKR_VIDEO_FIRST_FRAME_BARRIER === '1')
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
