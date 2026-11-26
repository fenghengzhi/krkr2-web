import type { Page } from '@playwright/test'

export const videoFirstFrameRecoverySource = String.raw`
var recoveryWindow=new Window();recoveryWindow.caption="Cutscene recovery";recoveryWindow.setInnerSize(160,80);
var recoveryRoot=new Layer(recoveryWindow,null);recoveryWindow.add(recoveryRoot);recoveryRoot.setSize(160,80);
recoveryRoot.holdAlpha=false;recoveryRoot.fillRect(0,0,160,80,0xff102030);
var recoveryLeft=new Layer(recoveryWindow,recoveryRoot),recoveryRight=new Layer(recoveryWindow,recoveryRoot);
recoveryWindow.add(recoveryLeft);recoveryWindow.add(recoveryRight);
recoveryLeft.setPos(0,0,64,48);recoveryRight.setPos(80,0,64,48);recoveryLeft.visible=recoveryRight.visible=true;
var recoveryMovie=new VideoOverlay(recoveryWindow);recoveryMovie.mode=vomLayer;
recoveryMovie.layer1=recoveryLeft;recoveryMovie.layer2=recoveryRight;
recoveryMovie.open("cutscene.mp4");recoveryMovie.pause();recoveryMovie.frame=10;
var recoveryRound=0,recoveryButton=new Layer(recoveryWindow,recoveryRoot);recoveryWindow.add(recoveryButton);
recoveryButton.setPos(0,56,160,24);recoveryButton.holdAlpha=false;
recoveryButton.fillRect(0,0,160,24,0xff408060);recoveryButton.visible=true;
recoveryButton.onClick=function(){
 global.recoveryMovie.enabledAudioStream=global.recoveryRound==1?0:1;
 global.Debug.message("cutscene-recovered:"+global.recoveryRound+":"+global.recoveryMovie.status+":"+global.recoveryMovie.frame);
 global.recoveryRound++;
};
recoveryWindow.visible=true;recoveryWindow.update();Debug.message("cutscene-recovery-ready");
`

export interface FirstFrameRecoveryGate {
  arm: 'recover' | 'denied' | 'cancel' | undefined
  attempts: Array<{ mode: string; muted: boolean; private: boolean; oldTime: number | null; at: number; gains?: number[] }>
  frames: Array<{ mode: string; time: number; counter: number; at: number }>
  release(): void
  late(): void
  pending(): number
}
export type FirstFrameRecoveryWindow = Window & { firstFrameRecoveryGate: FirstFrameRecoveryGate }

/** Model only the archived missing paused submission. Every delivered callback
 * is still from the real browser and every pixel from its actual MP4 decoder.
 * The denied branch delays a real initial callback; recovery requests a fresh
 * one after the real muted play. No clock or decoded image is synthesized. */
export async function installFirstFrameRecoveryGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Mode = 'recover' | 'denied' | 'cancel'
    type Waiting = { video: HTMLVideoElement; callback: VideoFrameRequestCallback;
      native?: number; frame?: { now: number; metadata: VideoFrameCallbackMetadata }; cancelled: boolean }
    const request = HTMLVideoElement.prototype.requestVideoFrameCallback,
      cancel = HTMLVideoElement.prototype.cancelVideoFrameCallback,
      quality = HTMLVideoElement.prototype.getVideoPlaybackQuality,
      play = HTMLMediaElement.prototype.play,
      videos = new WeakMap<HTMLVideoElement, { mode: Mode; released: boolean }>(),
      waiting = new Map<number, Waiting>(), late: Waiting[] = []
    let next = -1
    const gate: FirstFrameRecoveryGate = { arm: undefined, attempts: [], frames: [],
      release() {
        for (const [id, entry] of waiting) if (entry.frame && !entry.cancelled) {
          const state = videos.get(entry.video)!
          state.released = true; waiting.delete(id)
          entry.callback(entry.frame.now, entry.frame.metadata)
        }
      },
      late() { for (const entry of late) if (entry.frame) entry.callback(entry.frame.now, entry.frame.metadata); late.length = 0 },
      pending: () => waiting.size,
    }
    ;(window as unknown as FirstFrameRecoveryWindow).firstFrameRecoveryGate = gate
    const armNative = (id: number, entry: Waiting) => {
      entry.native = request.call(entry.video, (now, metadata) => {
        entry.native = undefined; entry.frame = { now, metadata }
        const state = videos.get(entry.video)!
        gate.frames.push({ mode: state.mode, time: metadata.mediaTime, counter: metadata.presentedFrames, at: now })
        if (state.released && state.mode !== 'cancel' && !entry.cancelled) {
          waiting.delete(id); entry.callback(now, metadata)
        }
      })
    }
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      let state = videos.get(this)
      if (!state && gate.arm && !this.hasAttribute('data-video-id')) {
        state = { mode: gate.arm, released: false }; gate.arm = undefined; videos.set(this, state)
      }
      if (!state || state.released) return request.call(this, callback)
      const id = next--, entry: Waiting = { video: this, callback, cancelled: false }
      waiting.set(id, entry); armNative(id, entry)
      return id
    }
    HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) {
      const entry = waiting.get(id)
      if (!entry) { if (id >= 0) cancel.call(this, id); return }
      waiting.delete(id); entry.cancelled = true; late.push(entry)
      if (entry.native !== undefined) cancel.call(this, entry.native)
    }
    HTMLVideoElement.prototype.getVideoPlaybackQuality = function () {
      const result = quality.call(this), state = videos.get(this)
      return state && !state.released ? { creationTime: result.creationTime, corruptedVideoFrames: 0,
        droppedVideoFrames: 0, totalVideoFrames: 0 } : result
    }
    HTMLMediaElement.prototype.play = function () {
      const state = this instanceof HTMLVideoElement && videos.get(this)
      if (!state || state.released) return play.call(this)
      const video = this as HTMLVideoElement, old = document.querySelector<HTMLVideoElement>('video[data-video-id]')
      const probe = Reflect.get(window, 'videoAudioChannels') as undefined | (() => { graphs: { gains: number[] }[] }),
        graphs = probe?.().graphs
      gate.attempts.push({ mode: state.mode, muted: video.muted, private: !video.hasAttribute('data-video-id'),
        oldTime: old?.currentTime ?? null, at: performance.now(), gains: graphs?.[graphs.length - 1]?.gains })
      if (state.mode === 'denied') return Promise.reject(new DOMException('Fixture autoplay denied', 'NotAllowedError'))
      state.released = true
      for (const [id, entry] of waiting) if (entry.video === video) {
        if (entry.native !== undefined) cancel.call(video, entry.native)
        entry.frame = undefined
        armNative(id, entry)
      }
      return play.call(video)
    }
  })
}
