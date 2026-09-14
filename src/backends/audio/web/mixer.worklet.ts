import { AudioMixer } from '../../../engine/media/mixer.ts'
import type { MixerRequest, AudioMessage } from '../../../protocol/audio.ts'
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void
class KrkrMixerProcessor extends AudioWorkletProcessor {
  private readonly mixer = new AudioMixer(sampleRate)
  private lastStats = 0
  private processedFrames = 0
  private peak = 0
  private maximum = 0
  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<MixerRequest>) => {
      const { serial, command } = event.data
      try {
        const result = this.mixer.command(command)
        this.send({ type: 'reply', serial, result })
      } catch (error) {
        this.send({
          type: 'reply',
          serial,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  private send(message: AudioMessage): void {
    this.port.postMessage(message)
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0] ?? []
    if (!left || !right) return true
    for (const event of this.mixer.render(left, right)) this.send({ type: 'event', event })
    this.peak = Math.max(this.peak, this.mixer.peak)
    this.maximum = Math.max(this.maximum, this.peak)
    // The mixer clock freezes during pause; telemetry still needs to report
    // the silent output quanta instead of leaving the previous peak on screen.
    this.processedFrames += left.length
    if (this.processedFrames - this.lastStats >= sampleRate / 4) {
      this.lastStats = this.processedFrames
      this.send({
        type: 'stats',
        frames: this.mixer.frames,
        peak: this.peak,
        maxPeak: this.maximum,
      })
      this.peak = 0
    }
    return true
  }
}
registerProcessor('krkr2-mixer', KrkrMixerProcessor)
