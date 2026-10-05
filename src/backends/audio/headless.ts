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
import { PcmStreamPool, type PcmSourceFactory, type PreparedPcmStream } from './stream-pool.ts'
export class HeadlessAudioBackend implements AudioBackend {
  readonly streaming = true
  readonly mixer: AudioMixer
  private readonly streams: PcmStreamPool
  private listeners = new Set<(event: AudioEvent) => void>()
  private at: number
  private cancelWake?: () => void
  private wakeVersion = 0
  private readonly operations = new VoiceOperations()
  private closed = false
  private closing?: Promise<void>
  private cancelled = false
  private cancelling?: Promise<void>
  private readonly decodeWaiters = new Set<(error: Error) => void>()
  constructor(
    private readonly clock: EventClock,
    private readonly output?: (left: Float32Array, right: Float32Array) => void,
    rate = 48000,
    private readonly decode: typeof decodePortableAudio = decodePortableAudio,
    sourceFactory?: PcmSourceFactory,
  ) {
    this.streams = new PcmStreamPool(sourceFactory)
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
      this.fillStreams()
      remaining -= count
    }
  }
  private fillStreams(): void {
    for (const request of this.mixer.takeStreamRequests()) {
      void this.streams.read(request).then((command) => {
        if (this.closed || !command || !this.streams.isCurrent(request)) return
        const result = this.mixer.command(command)
        for (const event of result.events) for (const listener of this.listeners) listener(event)
        this.arm()
      }).catch((error: unknown) => {
        if (!this.closed && this.streams.isCurrent(request)) {
          this.mixer.command({ op: 'streamData', request,
            error: error instanceof Error ? error.message : String(error) })
          this.arm()
        }
      })
    }
  }
  private arm(): void {
    if (this.closed || !this.mixer.hasClockWork) {
      this.cancelWake?.()
      this.cancelWake = undefined
      this.wakeVersion++
      this.at = this.clock.now()
      return
    }
    if (!this.cancelWake) {
      const version = ++this.wakeVersion
      this.cancelWake = this.clock.schedule(() => {
        if (version !== this.wakeVersion || this.closed) return
        this.cancelWake = undefined
        this.advance()
        this.arm()
      }, 20)
    }
  }
  async command(command: AudioCommand): Promise<AudioResult> {
    if (this.closed || (this.cancelled && (command.op === 'open' || command.op === 'openSource' || command.op === 'load' || command.op === 'create'))) {
      if (command.op === 'openSource') command.releaseSource?.()
      throw new Error('Headless audio is closed')
    }
    if (command.op === 'shutdown') {
      await this.close()
      return { events: [] }
    }
    if (command.op === 'openSource') return this.openSource(command)
    this.advance()
    if (command.op === 'focusMode') {
      this.arm()
      return { events: [] }
    }
    if (command.op === 'open') {
      const ticket = this.operations.begin(command.id)
      this.streams.cancelPreparing(command.id)
      this.arm()
      try {
        const asset = await this.waitDecode(this.decode(command.bytes, command.kind))
        if (this.closed) throw new Error('Headless audio closed during decoding')
        this.operations.assertCurrent(command.id, ticket)
        if (!asset)
          throw new Error('Headless audio supports PCM WAVE, Vorbis and Standard MIDI Files')
        if (command.loops.links.length || command.loops.labels.length) asset.loops = command.loops
        this.advance()
        const result = this.mixer.command({
          op: 'load',
          id: command.id,
          asset,
          settings: command.settings,
          kind: command.kind,
          filters: command.filters,
        })
        await this.streams.retire(command.id)
        return result
      } finally {
        this.operations.finish(command.id, ticket)
        this.arm()
      }
    }
    // A direct load/create also supersedes an older decoder for this id.
    if (command.op === 'close' || command.op === 'load' || command.op === 'create') {
      this.operations.cancel(command.id)
      this.streams.cancelPreparing(command.id)
      const previous = this.streams.current(command.id)
      let cleanup = command.op === 'close' ? this.streams.retire(command.id) : Promise.resolve()
      try {
        const result = this.mixer.command(command)
        if (command.op === 'load' && previous) cleanup = this.streams.discard(previous)
        await cleanup
        return result
      } catch (error) {
        try { await cleanup }
        catch (cleanupError) {
          if (cleanupError !== error) throw new AggregateError([error, cleanupError], 'Audio command and stream cleanup failed')
        }
        throw error
      } finally { this.fillStreams(); this.arm() }
    }
    try {
      return this.mixer.command(command)
    } finally {
      this.fillStreams()
      this.arm()
    }
  }
  private async openSource(command: Extract<AudioCommand, { op: 'openSource' }>): Promise<AudioResult> {
    const ticket = this.operations.begin(command.id), assertCurrent = () => {
      if (this.closed) throw new Error('Headless audio closed during source opening')
      this.operations.assertCurrent(command.id, ticket)
    }
    this.streams.cancelPreparing(command.id)
    this.advance()
    this.arm()
    let candidate: PreparedPcmStream | undefined, committed = false
    try {
      candidate = await this.streams.prepare(command, assertCurrent)
      const asset = candidate.asset ?? await this.waitDecode(this.decode(await this.streams.fallbackBytes(candidate), command.kind))
      assertCurrent()
      if (!asset) throw new Error('Headless audio supports PCM WAVE, Vorbis and Standard MIDI Files')
      if (command.loops.links.length || command.loops.labels.length) asset.loops = command.loops
      this.advance()
      const result = this.mixer.command({ op: 'load', id: command.id, asset,
        settings: command.settings, kind: command.kind, filters: command.filters })
      if (candidate.asset) { this.streams.commit(candidate); committed = true }
      else { await this.streams.retire(command.id); candidate = undefined }
      return result
    } catch (error) {
      if (candidate && !committed) {
        try { await this.streams.discard(candidate) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Audio source opening and cleanup failed') }
      }
      throw error
    } finally { this.operations.finish(command.id, ticket); this.fillStreams(); this.arm() }
  }
  inspect(): ReturnType<AudioMixer['inspect']> & { clockTasks: number; pendingCreates: number } {
    return {
      ...this.mixer.inspect(),
      clockTasks: this.cancelWake ? 1 : 0,
      pendingCreates: this.operations.count,
    }
  }
  listen(callback: (event: AudioEvent) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  private waitDecode<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = (error: Error) => reject(error)
      this.decodeWaiters.add(cancel)
      work.then((value) => {
        this.decodeWaiters.delete(cancel)
        if (this.cancelled || this.closed) reject(new Error('Headless audio decoding was closed or cancelled'))
        else resolve(value)
      }, (error: unknown) => { this.decodeWaiters.delete(cancel); reject(error) })
      if (this.cancelled || this.closed) { this.decodeWaiters.delete(cancel); cancel(new Error('Headless audio decoding was closed or cancelled')) }
    })
  }
  private retireDecodes(): void {
    this.cancelled = true
    for (const cancel of this.decodeWaiters) cancel(new Error('Headless audio decoding was closed or cancelled'))
    this.decodeWaiters.clear()
  }
  cancel(): Promise<void> {
    if (this.cancelling) return this.cancelling
    if (this.closed) return this.closing ?? Promise.resolve()
    this.operations.clear()
    this.retireDecodes()
    this.wakeVersion++
    const errors: unknown[] = []
    try { this.cancelWake?.() } catch (error) { errors.push(error) }
    this.cancelWake = undefined
    try { this.mixer.command({ op: 'pauseAll', paused: true }) } catch (error) { errors.push(error) }
    this.cancelling = this.streams.close().catch((error: unknown) => { errors.push(error) }).then(() => {
      if (errors.length) throw new AggregateError(errors, 'Headless audio cancellation failed')
    })
    return this.cancelling
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.operations.clear()
    this.retireDecodes()
    this.wakeVersion++
    const errors: unknown[] = []
    try { this.cancelWake?.() } catch (error) { errors.push(error) }
    this.cancelWake = undefined
    this.closing = (async () => {
      try { this.mixer.command({ op: 'shutdown' }) } catch (error) { errors.push(error) }
      this.listeners.clear()
      const results = await Promise.allSettled([this.streams.close(), this.cancelling])
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
      if (errors.length) throw new AggregateError(errors, 'Headless audio cleanup failed')
    })()
    return this.closing
  }
}
