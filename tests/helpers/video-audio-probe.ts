import type { Page } from '@playwright/test'

export interface VideoAudioObservation {
  graphs: { state: string; frequency: number; db: number; peak: number; time: number }[]
  liveUrls: number
  createdUrls: number
  revokedUrls: number
}
type ProbeWindow = Window & { videoAudioObservation(): VideoAudioObservation }

/** Passively read the real production media graph after volume/balance gains.
 * No synthetic AudioBuffer, media event, decoded sample or playback clock. */
export async function installVideoAudioProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const analysers = new Set<AnalyserNode>(), urls = new Set<string>(),
      createAnalyser = AudioContext.prototype.createAnalyser,
      disconnect = AnalyserNode.prototype.disconnect,
      createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL
    let createdUrls = 0, revokedUrls = 0
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
