import type {
  AudioBackend,
  AudioCommand,
  AudioResult,
  AudioEvent,
} from '../../engine/ports/audio.ts'
import type { EventClock } from '../../engine/scheduler/events.ts'
import { AudioMixer } from '../../engine/media/mixer.ts'
import { decodePortableAudio } from './decode.ts'
import { VoiceOperations } from './voice-operations.ts'
export class HeadlessAudioBackend implements AudioBackend {
  readonly mixer: AudioMixer
  private listeners = new Set<(event: AudioEvent) => void>()
  private at: number
  private cancel?: () => void
  private wakeVersion = 0
  private readonly operations = new VoiceOperations()
  private closed = false
  constructor(
    private readonly clock: EventClock,
    private readonly output?: (left: Float32Array, right: Float32Array) => void,
    rate = 48000,
    private readonly decode: typeof decodePortableAudio = decodePortableAudio,
  ) {
    this.mixer = new AudioMixer(rate)
    this.at = clock.now()
  }
  private advance(): void {
    const now = this.clock.now()
    if (!this.mixer.hasClockWork) {
      this.at = now
      return
    }
    const frames = Math.floor(((now - this.at) * this.mixer.sampleRate) / 1000)
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
    if (this.closed || !this.mixer.hasClockWork) {
      this.cancel?.()
      this.cancel = undefined
      this.wakeVersion++
      this.at = this.clock.now()
      return
    }
    if (!this.cancel) {
      const version = ++this.wakeVersion
      this.cancel = this.clock.schedule(() => {
        if (version !== this.wakeVersion || this.closed) return
        this.cancel = undefined
        this.advance()
        this.arm()
      }, 20)
    }
  }
  async command(command: AudioCommand): Promise<AudioResult> {
    if (this.closed) throw new Error('Headless audio is closed')
    if (command.op === 'shutdown') {
      await this.close()
      return { events: [] }
    }
    if (command.op === 'close') this.operations.cancel(command.id)
    this.advance()
    if (command.op === 'focusMode') {
      this.arm()
      return { events: [] }
    }
    if (command.op === 'open') {
      const ticket = this.operations.begin(command.id)
      this.arm()
      try {
        const asset = await this.decode(command.bytes, command.kind)
        if (this.closed) throw new Error('Headless audio closed during decoding')
        this.operations.assertCurrent(command.id, ticket)
        if (!asset)
          throw new Error('Headless audio supports PCM WAVE, Vorbis and Standard MIDI Files')
        if (command.loops.links.length || command.loops.labels.length) asset.loops = command.loops
        this.advance()
        return this.mixer.command({
          op: 'load',
          id: command.id,
          asset,
          settings: command.settings,
          kind: command.kind,
        })
      } finally {
        this.operations.finish(command.id, ticket)
        this.arm()
      }
    }
    // A direct load/create also supersedes an older decoder for this id.
    if (command.op === 'load' || command.op === 'create') this.operations.cancel(command.id)
    try {
      return this.mixer.command(command)
    } finally {
      this.arm()
    }
  }
  inspect(): ReturnType<AudioMixer['inspect']> & { clockTasks: number; pendingCreates: number } {
    return {
      ...this.mixer.inspect(),
      clockTasks: this.cancel ? 1 : 0,
      pendingCreates: this.operations.count,
    }
  }
  listen(callback: (event: AudioEvent) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  async close(): Promise<void> {
    this.closed = true
    this.operations.clear()
    this.wakeVersion++
    this.cancel?.()
    this.cancel = undefined
    this.mixer.command({ op: 'shutdown' })
    this.listeners.clear()
  }
}
