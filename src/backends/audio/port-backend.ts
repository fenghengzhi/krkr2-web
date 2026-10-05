import { PausableTimeouts } from '../shared/pausable-timeouts.ts'
import type {
  AudioBackend,
  AudioCommand,
  AudioResult,
  AudioEvent,
  PcmReadRequest,
  WireAudioCommand,
} from '../../engine/ports/audio.ts'
import type { AudioMessage, AudioRequest } from '../../protocol/audio.ts'
import { decodePortableAudio } from './decode.ts'
import { VoiceOperations } from './voice-operations.ts'
import { PcmStreamPool, type PcmSourceFactory, type PreparedPcmStream } from './stream-pool.ts'
export class PortAudioBackend implements AudioBackend {
  readonly streaming = true
  private readonly streams: PcmStreamPool
  private readonly timeouts = new PausableTimeouts()
  setRequestTimeoutsPaused(paused: boolean): void {
    this.timeouts.setPaused(paused)
  }
  private next = 1
  private closed = false
  private cancelled = false
  private cancelling?: Promise<void>
  private readonly decodeWaiters = new Set<(error: Error) => void>()
  private readonly publishing = new Map<number, { done: Promise<void>; closeEpoch: number }>()
  private closing?: Promise<void>
  private readonly operations = new VoiceOperations()
  private pending = new Map<
    number,
    {
      resolve(result: AudioResult): void
      reject(error: Error): void
      cancelTimeout(): void
    }
  >()
  private listeners = new Set<(event: AudioEvent) => void>()
  constructor(
    private readonly port: MessagePort,
    private readonly decode: typeof decodePortableAudio = decodePortableAudio,
    sourceFactory?: PcmSourceFactory,
  ) {
    this.streams = new PcmStreamPool(sourceFactory)
    port.onmessage = (event: MessageEvent<AudioMessage>) => {
      const message = event.data
      if (message.type === 'streamRead') {
        if (!this.closed) void this.fillStream(message.request)
      } else if (message.type === 'event' && !this.closed) {
        for (const listener of this.listeners) listener(message.event)
      } else if (message.type === 'reply') {
        const job = this.pending.get(message.serial)
        if (!job) return
        job.cancelTimeout()
        this.pending.delete(message.serial)
        if (message.error) job.reject(new Error(message.error))
        else job.resolve(message.result ?? { events: [] })
      }
    }
    port.onmessageerror = () => {
      const error = new Error('Audio transport message could not be decoded')
      this.rejectPending(error)
      if (!this.closing) {
        this.closed = true
        this.operations.clear()
        this.retireDecodes()
        this.closing = this.finishClose(undefined, [error])
        void this.closing.catch(() => {})
      }
    }
  }
  async command(command: AudioCommand): Promise<AudioResult> {
    if (this.closed || (this.cancelled && (command.op === 'open' || command.op === 'openSource' || command.op === 'load' || command.op === 'create'))) {
      if (command.op === 'openSource') command.releaseSource?.()
      throw new Error('Audio backend is closed')
    }
    if (command.op === 'open' || command.op === 'openSource' || command.op === 'load' || command.op === 'create') {
      // Once a load was dispatched, the consumer may already own its asset.
      // Wait for its ACK/commit before a new preparation can supersede it.
      // With no publication in flight, admission stays synchronous so older
      // unfinished preparations retain the existing supersession behavior.
      while (this.publishing.has(command.id)) {
        const publication = this.publishing.get(command.id)!, epoch = publication.closeEpoch
        await publication.done
        if (epoch !== publication.closeEpoch) {
          if (command.op === 'openSource') command.releaseSource?.()
          throw new Error('Audio operation was closed while awaiting publication')
        }
      }
    }
    if (this.closed || (this.cancelled && (command.op === 'open' || command.op === 'openSource' || command.op === 'load' || command.op === 'create'))) {
      if (command.op === 'openSource') command.releaseSource?.()
      throw new Error('Audio backend is closed')
    }
    if (command.op === 'shutdown') {
      await this.close()
      return { events: [] }
    }
    if (command.op === 'openSource') return this.openSource(command)
    if (command.op === 'close' || command.op === 'create' || command.op === 'load') {
      if (command.op === 'close') {
        const publication = this.publishing.get(command.id)
        if (publication) publication.closeEpoch++
      }
      this.operations.cancel(command.id)
      this.streams.cancelPreparing(command.id)
      if (command.op === 'close') {
        const results = await Promise.allSettled([this.send(command), this.streams.retire(command.id)])
        const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length) throw new AggregateError(failures, 'Audio command or stream cleanup failed')
        return (results[0] as PromiseFulfilledResult<AudioResult>).value
      }
      const previous = this.streams.current(command.id), finishPublication = this.beginPublication(command.id)
      try {
        const result = await this.send(command)
        // create(existing id) is a no-op in the mixer. A rejected load retains
        // its previous asset, so its decoder must remain alive as well.
        if (command.op === 'load' && previous) await this.streams.discard(previous)
        return result
      } finally { finishPublication() }
    }
    if (command.op === 'open') {
      const { id } = command,
        ticket = this.operations.begin(id)
      this.streams.cancelPreparing(id)
      let finishPublication: (() => void) | undefined
      try {
        const asset = await this.waitDecode(this.decode(command.bytes, command.kind))
        if (this.closed) throw new Error('Audio backend closed during decoding')
        this.operations.assertCurrent(id, ticket)
        if (asset) {
          if (command.loops.links.length || command.loops.labels.length) asset.loops = command.loops
          command = {
            op: 'load',
            id,
            asset,
            settings: command.settings,
            kind: command.kind,
            filters: command.filters,
          }
        }
        finishPublication = this.beginPublication(id)
        const result = await this.send(command)
        this.operations.assertCurrent(id, ticket)
        await this.streams.retire(id)
        return result
      } finally {
        this.operations.finish(id, ticket)
        finishPublication?.()
      }
    }
    return this.send(command)
  }
  private beginPublication(id: number): () => void {
    if (this.publishing.has(id)) throw new Error('Audio voice publication is already in progress')
    let release!: () => void
    const barrier = { done: new Promise<void>((resolve) => { release = resolve }), closeEpoch: 0 }
    this.publishing.set(id, barrier)
    return () => {
      if (this.publishing.get(id) === barrier) this.publishing.delete(id)
      release()
    }
  }
  private async openSource(command: Extract<AudioCommand, { op: 'openSource' }>): Promise<AudioResult> {
    const ticket = this.operations.begin(command.id), assertCurrent = () => {
      if (this.closed) throw new Error('Audio backend closed during source opening')
      this.operations.assertCurrent(command.id, ticket)
    }
    this.streams.cancelPreparing(command.id)
    let candidate: PreparedPcmStream | undefined, committed = false
    let finishPublication: (() => void) | undefined
    try {
      candidate = await this.streams.prepare(command, assertCurrent)
      let outgoing: WireAudioCommand
      if (candidate.asset) outgoing = { op: 'load', id: command.id, asset: candidate.asset,
        settings: command.settings, kind: command.kind, filters: command.filters }
      else {
        const bytes = await this.streams.fallbackBytes(candidate), asset = await this.waitDecode(this.decode(bytes, command.kind))
        assertCurrent()
        if (asset) {
          if (command.loops.links.length || command.loops.labels.length) asset.loops = command.loops
          outgoing = { op: 'load', id: command.id, asset, settings: command.settings,
            kind: command.kind, filters: command.filters }
        } else outgoing = { op: 'open', id: command.id, bytes, kind: command.kind, loops: command.loops,
          settings: command.settings, filters: command.filters }
      }
      assertCurrent()
      finishPublication = this.beginPublication(command.id)
      const result = await this.send(outgoing)
      assertCurrent()
      if (candidate.asset) { this.streams.commit(candidate); committed = true }
      else { await this.streams.retire(command.id); candidate = undefined }
      return result
    } catch (error) {
      if (candidate && !committed) {
        try { await this.streams.discard(candidate) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Audio opening and cleanup failed') }
      }
      throw error
    } finally { this.operations.finish(command.id, ticket); finishPublication?.() }
  }
  private async fillStream(request: PcmReadRequest): Promise<void> {
    try {
      const command = await this.streams.read(request)
      if (!command || this.closed || !this.streams.isCurrent(request)) return
      await this.send(command)
    } catch (error) {
      if (!this.closed && this.streams.isCurrent(request))
        for (const listener of this.listeners)
          listener({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }
  private send(command: WireAudioCommand): Promise<AudioResult> {
    const serial = this.next++
    return new Promise((resolve, reject) => {
      const cancelTimeout = this.timeouts.start(20000, () => {
        this.pending.delete(serial)
        reject(new Error(`Audio ${command.op} timed out`))
      })
      this.pending.set(serial, { resolve, reject, cancelTimeout })
      const request: AudioRequest = { serial, command }
      // Resource/decoder/cache buffers keep their owners. Every transferred
      // channel is a compact private copy, including predecoded stream pages.
      try {
        if (command.op === 'load' && command.asset.kind === 'pcm') {
          const data = command.asset.data.map((channel) => new Float32Array(channel))
          request.command = { ...command, asset: { ...command.asset, data } }
          this.port.postMessage(request, data.map((channel) => channel.buffer))
        } else if (command.op === 'load' && command.asset.kind === 'stream') {
          const initial = command.asset.initial.map((block) => ({ position: block.position,
            data: block.data.map((channel) => new Float32Array(channel)) }))
          request.command = { ...command, asset: { ...command.asset, initial } }
          this.port.postMessage(request, initial.flatMap((block) => block.data.map((channel) => channel.buffer)))
        } else if (command.op === 'streamData' && command.data) {
          const data = command.data.map((channel) => new Float32Array(channel))
          request.command = { ...command, data }
          this.port.postMessage(request, data.map((channel) => channel.buffer))
        } else if (command.op === 'open') {
          const bytes = Uint8Array.from(command.bytes)
          request.command = { ...command, bytes }
          this.port.postMessage(request, [bytes.buffer])
        } else this.port.postMessage(request)
      } catch (error) {
        this.pending.delete(serial)
        cancelTimeout()
        reject(error)
      }
    })
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
        if (this.cancelled || this.closed) reject(new Error('Audio decoding was closed or cancelled'))
        else resolve(value)
      }, (error: unknown) => { this.decodeWaiters.delete(cancel); reject(error) })
      if (this.cancelled || this.closed) { this.decodeWaiters.delete(cancel); cancel(new Error('Audio decoding was closed or cancelled')) }
    })
  }
  private retireDecodes(): void {
    this.cancelled = true
    for (const cancel of this.decodeWaiters) cancel(new Error('Audio decoding was closed or cancelled'))
    this.decodeWaiters.clear()
  }
  cancel(): Promise<void> {
    if (this.cancelling) return this.cancelling
    if (this.closed) return this.closing ?? Promise.resolve()
    this.operations.clear()
    this.retireDecodes()
    this.timeouts.setPaused(false)
    // Wake suspended command callers before Session waits for its event queue.
    // The control port stays available for pause and subsequent normal close.
    this.rejectPending(new Error('Audio operation was closed or cancelled'))
    const pause = this.send({ op: 'pauseAll', paused: true }), cleanup = this.streams.close()
    this.cancelling = Promise.allSettled([pause, cleanup]).then((results) => {
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Audio cancellation failed')
    })
    return this.cancelling
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.operations.clear()
    this.retireDecodes()
    this.timeouts.setPaused(false)
    this.closing = this.finishClose(this.send({ op: 'shutdown' }))
    return this.closing
  }
  private rejectPending(error: Error): void {
    for (const job of this.pending.values()) { job.cancelTimeout(); job.reject(error) }
    this.pending.clear()
  }
  private async finishClose(shutdown?: Promise<AudioResult>, errors: unknown[] = []): Promise<void> {
    const results = await Promise.allSettled([shutdown, this.streams.close(), this.cancelling])
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    try { this.port.close() } catch (error) { errors.push(error) }
    this.port.onmessage = null
    this.port.onmessageerror = null
    this.rejectPending(new Error('Audio backend closed'))
    this.listeners.clear()
    if (errors.length) throw new AggregateError(errors, 'Audio backend cleanup failed')
  }
}
