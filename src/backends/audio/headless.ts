import type {
  AudioBackend,
  AudioCommand,
  AudioResult,
  AudioEvent,
} from '../../engine/ports/audio.ts'
import type { EventClock } from '../../engine/scheduler/events.ts'
import { AudioMixer } from '../../engine/media/mixer.ts'
import { decodePortableAudio } from './decode.ts'
export class HeadlessAudioBackend implements AudioBackend {
  readonly mixer: AudioMixer
  private listeners = new Set<(event: AudioEvent) => void>()
  private at: number
  private cancel?: () => void
  private closed = false
  constructor(
    private readonly clock: EventClock,
    private readonly output?: (left: Float32Array, right: Float32Array) => void,
    rate = 48000,
  ) {
    this.mixer = new AudioMixer(rate)
    this.at = clock.now()
  }
  private advance(): void {
    const now = this.clock.now(),
      frames = Math.floor(((now - this.at) * this.mixer.sampleRate) / 1000)
    this.at += (frames * 1000) / this.mixer.sampleRate
    for (let remaining = frames; remaining > 0;) {
      const count = Math.min(512, remaining),
        left = new Float32Array(count),
        right = new Float32Array(count)
      const events = this.mixer.render(left, right)
      this.output?.(left, right)
      for (const event of events) for (const listener of this.listeners) listener(event)
      remaining -= count
    }
  }
  private arm(): void {
    if (!this.closed && !this.cancel)
      this.cancel = this.clock.schedule(() => {
        this.cancel = undefined
        this.advance()
        this.arm()
      }, 20)
  }
  async command(command: AudioCommand): Promise<AudioResult> {
    if (this.closed) throw new Error('Headless audio is closed')
    this.advance()
    this.arm()
    if (command.op === 'focusMode') return { events: [] }
    if (command.op === 'open') {
      const asset = await decodePortableAudio(command.bytes, command.kind)
      if (this.closed) throw new Error('Headless audio closed during decoding')
      if (!asset)
        throw new Error('Headless audio supports PCM WAVE, Vorbis and Standard MIDI Files')
      if (command.loops.links.length || command.loops.labels.length) asset.loops = command.loops
      return this.mixer.command({
        op: 'load',
        id: command.id,
        asset,
        settings: command.settings,
        kind: command.kind,
      })
    }
    return this.mixer.command(command)
  }
  listen(callback: (event: AudioEvent) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  async close(): Promise<void> {
    this.cancel?.()
    this.cancel = undefined
    this.mixer.command({ op: 'shutdown' })
    this.listeners.clear()
    this.closed = true
  }
}
