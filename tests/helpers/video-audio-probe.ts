import type { Page } from '@playwright/test'

export interface VideoAudioObservation {
  graphs: { state: string; frequency: number; db: number; peak: number; time: number }[]
  liveUrls: number
  createdUrls: number
  revokedUrls: number
}
interface VideoMediaState {
  identity: number
  videoId: string | null
  windowId: string | null
  source: string
  connected: boolean
  position: number
  duration: number | null
  paused: boolean
  seeking: boolean
  ended: boolean
  playbackRate: number
  readyState: number
  networkState: number
  presentedTime: string | null
  presentedFrames: string | null
  error: { code: number; message: string } | null
}
export interface VideoMediaObservation {
  events: (VideoMediaState & { event: string; at: number })[]
  dropped: number
  videos: VideoMediaState[]
}
type ProbeWindow = Window & {
  videoAudioObservation(): VideoAudioObservation
  videoMediaObservation(): VideoMediaObservation
}

/** Passively read the real production media graph after volume/balance gains.
 * No synthetic AudioBuffer, media event, decoded sample or playback clock. */
export async function installVideoAudioProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const analysers = new Set<AnalyserNode>(), urls = new Set<string>(),
      createAnalyser = AudioContext.prototype.createAnalyser,
      disconnect = AnalyserNode.prototype.disconnect,
      createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL
    let createdUrls = 0, revokedUrls = 0
    const mediaEvents: VideoMediaObservation['events'] = [], mediaIds = new WeakMap<HTMLVideoElement, number>()
    let nextMediaId = 1, droppedMediaEvents = 0
    const mediaState = (video: HTMLVideoElement): VideoMediaState => {
      let identity = mediaIds.get(video)
      if (identity === undefined) { identity = nextMediaId++; mediaIds.set(video, identity) }
      return { identity, videoId: video.getAttribute('data-video-id'), windowId: video.getAttribute('data-window-id'),
        source: video.currentSrc || video.getAttribute('src') || '', connected: video.isConnected,
        position: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
        paused: video.paused, seeking: video.seeking, ended: video.ended, playbackRate: video.playbackRate,
        readyState: video.readyState, networkState: video.networkState,
        presentedTime: video.getAttribute('data-presented-time'),
        presentedFrames: video.getAttribute('data-presented-frames'),
        error: video.error ? { code: video.error.code, message: video.error.message } : null }
    }
    // Passive events distinguish a seek/decode wait from an unrelated Worker
    // RPC failure. Do not intercept currentTime or add presentation callbacks;
    // observeVideoFrames already supplies the independent presented attributes.
    for (const event of ['loadedmetadata', 'loadeddata', 'seeking', 'seeked', 'pause', 'playing', 'error', 'emptied'])
      document.addEventListener(event, (entry) => {
        if (!(entry.target instanceof HTMLVideoElement)) return
        if (mediaEvents.length >= 512) { droppedMediaEvents++; return }
        mediaEvents.push({ event, at: performance.now(), ...mediaState(entry.target) })
      }, true)
    ;(window as unknown as ProbeWindow).videoMediaObservation = () => ({
      events: mediaEvents.map((event) => ({ ...event })), dropped: droppedMediaEvents,
      videos: [...document.querySelectorAll('video')].map(mediaState),
    })
    AudioContext.prototype.createAnalyser = function (this: AudioContext) {
      const analyser = createAnalyser.call(this)
      analysers.add(analyser)
      return analyser
    }
    AnalyserNode.prototype.disconnect = function (this: AnalyserNode, ...args: unknown[]) {
      analysers.delete(this)
      return Reflect.apply(disconnect, this, args)
    } as AnalyserNode['disconnect']
    URL.createObjectURL = (blob) => {
      const url = createUrl.call(URL, blob)
      if (blob instanceof Blob && blob.type.startsWith('video/')) { urls.add(url); createdUrls++ }
      return url
    }
    URL.revokeObjectURL = (url) => {
      if (urls.delete(url)) revokedUrls++
      revokeUrl.call(URL, url)
    }
    ;(window as unknown as ProbeWindow).videoAudioObservation = () => ({
      graphs: [...analysers].map((analyser) => {
        analyser.fftSize = 4096
        analyser.smoothingTimeConstant = 0
        const frequency = new Float32Array(analyser.frequencyBinCount),
          samples = new Float32Array(analyser.fftSize), rate = analyser.context.sampleRate
        analyser.getFloatFrequencyData(frequency)
        analyser.getFloatTimeDomainData(samples)
        let bin = 0, db = -200, peak = 0
        for (let index = Math.ceil(100 * analyser.fftSize / rate);
          index < Math.min(frequency.length, 2500 * analyser.fftSize / rate); index++) {
          if (frequency[index]! > db) { db = frequency[index]!; bin = index }
        }
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
        return { state: analyser.context.state, frequency: bin * rate / analyser.fftSize,
          db, peak, time: analyser.context.currentTime }
      }),
      liveUrls: urls.size, createdUrls, revokedUrls,
    })
  })
}

export const observeVideoAudio = (page: Page): Promise<VideoAudioObservation> =>
  page.evaluate(() => (window as unknown as ProbeWindow).videoAudioObservation())

/** Read once at teardown, including parked candidates that were never committed. */
export const observeVideoMedia = (page: Page): Promise<VideoMediaObservation> =>
  page.evaluate(() => (window as unknown as ProbeWindow).videoMediaObservation())
