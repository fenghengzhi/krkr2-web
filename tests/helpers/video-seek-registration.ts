import type { Page } from '@playwright/test'

export interface VideoSeekRegistrations {
  events: { identity: number; event: 'request' | 'cancel' | 'frame' | 'seek'; at: number;
    pending: number; handle?: number; from?: number; target?: number; staged?: boolean;
    presentationTime?: number; mediaTime?: number; presentedFrames?: number;
    callbackNow?: number; currentTime?: number; seeking?: boolean; readyState?: number }[]
  dropped: number
}
type ObservedWindow = Window & { videoSeekRegistrations(): VideoSeekRegistrations }

/** Pass through the actual DOM methods and callback metadata. This adds no
 * rVFC, seek, paint, timer or playback operation of its own. */
export async function installVideoSeekRegistrations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const states = new WeakMap<HTMLVideoElement, { identity: number; pending: Set<number> }>(),
      events: VideoSeekRegistrations['events'] = [], request = HTMLVideoElement.prototype.requestVideoFrameCallback,
      cancel = HTMLVideoElement.prototype.cancelVideoFrameCallback,
      clock = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!
    let serial = 0, dropped = 0
    ;(window as unknown as ObservedWindow).videoSeekRegistrations = () => ({ events: events.map((event) => ({ ...event })), dropped })
    if (typeof request !== 'function' || typeof cancel !== 'function' || !clock?.set || !clock.get) return
    const state = (video: HTMLVideoElement) => {
      let value = states.get(video)
      if (!value) { value = { identity: ++serial, pending: new Set<number>() }; states.set(video, value) }
      return value
    }, record = (entry: VideoSeekRegistrations['events'][number]) => {
      if (events.length < 2048) events.push(entry); else dropped++
    }
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      const value = state(this)
      let handle = 0
      handle = request.call(this, (now, metadata) => {
        value.pending.delete(handle)
        record({ identity: value.identity, event: 'frame', handle, at: performance.now(), pending: value.pending.size,
          presentationTime: metadata.presentationTime, mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames,
          callbackNow: now, currentTime: clock.get!.call(this) as number, seeking: this.seeking, readyState: this.readyState })
        callback(now, metadata)
      })
      value.pending.add(handle)
      record({ identity: value.identity, event: 'request', handle, at: performance.now(), pending: value.pending.size })
      return handle
    }
    HTMLVideoElement.prototype.cancelVideoFrameCallback = function (handle) {
      const result = cancel.call(this, handle), value = state(this)
      value.pending.delete(handle)
      record({ identity: value.identity, event: 'cancel', handle, at: performance.now(), pending: value.pending.size })
      return result
    }
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      ...clock,
      set(this: HTMLMediaElement, target: number) {
        if (this instanceof HTMLVideoElement) {
          const value = state(this)
          record({ identity: value.identity, event: 'seek', at: performance.now(), pending: value.pending.size,
            from: clock.get!.call(this) as number, target,
            staged: !this.hasAttribute('data-video-id') && !!this.closest('.video-parking') })
        }
        clock.set!.call(this, target)
      },
    })
  })
}
export const observeVideoSeekRegistrations = (page: Page): Promise<VideoSeekRegistrations> =>
  page.evaluate(() => (window as unknown as ObservedWindow).videoSeekRegistrations())
