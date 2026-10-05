import type { AudioCommand, MixerCommand, PcmReadRequest, StreamingPcmAsset } from '../../engine/ports/audio.ts'
import { MAX_RESOURCE_BYTES } from '../../engine/ports/storage.ts'
import { openPortablePcmSource, type PcmSource } from './pcm-source.ts'

type OpenSource = Extract<AudioCommand, { op: 'openSource' }>
type StreamData = Extract<MixerCommand, { op: 'streamData' }>
export type PcmSourceFactory = typeof openPortablePcmSource
export interface PreparedPcmStream {
  readonly id: number
  readonly streamId: number
  readonly asset?: StreamingPcmAsset
}
interface StreamRecord extends PreparedPcmStream {
  asset?: StreamingPcmAsset
  command: OpenSource
  assertOpening(): void
  phase: 'preparing' | 'active' | 'retired'
  decoder?: PcmSource
  decoderClose?: Promise<void>
  busy: boolean
  running?: Job
  requests: number
  lastSerial: number
  fallbackRead: boolean
  reservedBytes: number
  abort: AbortController
  finishing: boolean
  cleanup: Promise<void>
  activated: Promise<boolean>
  activate(value: boolean): void
  resolveCleanup(): void
  rejectCleanup(error: unknown): void
}
interface Job {
  record: StreamRecord
  run(): Promise<unknown>
  resolve(value: unknown): void
  reject(error: unknown): void
}

const pageFrames = 4096, voices = 256, pendingPerVoice = 4
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const retiredError = (): Error => new Error('Audio stream was closed or superseded')

/** Decoder work is serial per source and limited to two concurrent jobs for the
 * whole backend. Retired jobs keep their permit until their actual work settles;
 * their callers and queued jobs can already be rejected without publishing PCM. */
export class PcmStreamPool {
  private next = 1
  private closed = false
  private closing?: Promise<void>
  private active = new Map<number, StreamRecord>()
  private preparing = new Map<number, StreamRecord>()
  private records = new Set<StreamRecord>()
  private queue: Job[] = []
  private running = 0
  private bufferedBytes = 0
  private cleanupErrors: unknown[] = []
  constructor(private readonly openSource: PcmSourceFactory = openPortablePcmSource) {}

  private assertCurrent(record: StreamRecord): void {
    if (this.closed || record.phase === 'retired') throw retiredError()
    if (record.phase === 'preparing') record.assertOpening()
    else if (this.active.get(record.id) !== record) throw retiredError()
  }
  private schedule<T>(record: StreamRecord, run: () => Promise<T>): Promise<T> {
    try { this.assertCurrent(record) } catch (error) { return Promise.reject(error) }
    if (this.queue.length >= voices * pendingPerVoice)
      return Promise.reject(new Error('Audio stream job budget exceeded'))
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ record, run, resolve: (value) => resolve(value as T), reject })
      this.pump()
    })
  }
  private pump(): void {
    while (!this.closed && this.running < 2) {
      // Preserve FIFO among eligible sources; a busy decoder cannot block a
      // different source behind it, nor run concurrently with itself.
      const index = this.queue.findIndex((job) => !job.record.busy)
      if (index < 0) return
      const job = this.queue.splice(index, 1)[0]!, record = job.record
      try { this.assertCurrent(record) } catch (error) { job.reject(error); continue }
      record.busy = true
      record.running = job
      this.running++
      void Promise.resolve().then(job.run).then((value) => {
        this.assertCurrent(record)
        job.resolve(value)
      }).catch((error: unknown) => job.reject(error)).finally(() => {
        record.busy = false
        record.running = undefined
        this.running--
        this.finishRetirement(record)
        this.pump()
      })
    }
  }
  private closeDecoder(record: StreamRecord): void {
    if (record.decoder && !record.decoderClose) {
      // close() first cancels the decoder's waiters, then waits for actual
      // decoder work before freeing it. Never release the lease ahead of that.
      record.decoderClose = Promise.resolve().then(() => record.decoder!.close())
      void record.decoderClose.catch(() => {})
    }
  }
  private finishRetirement(record: StreamRecord): void {
    if (record.phase !== 'retired' || record.busy || record.finishing) return
    record.finishing = true
    this.closeDecoder(record)
    void (async () => {
      const errors: unknown[] = []
      try { await record.decoderClose } catch (error) { errors.push(error) }
      try { record.command.releaseSource?.() } catch (error) { errors.push(error) }
      record.decoder = undefined
      record.asset = undefined
      this.bufferedBytes -= record.reservedBytes
      record.reservedBytes = 0
      this.records.delete(record)
      if (errors.length) {
        const error = errors.length === 1 ? errors[0] : new AggregateError(errors, 'Audio stream cleanup failed')
        this.cleanupErrors.push(error)
        record.rejectCleanup(error)
      } else record.resolveCleanup()
    })()
  }
  private retireRecord(record: StreamRecord): Promise<void> {
    if (record.phase !== 'retired') {
      record.phase = 'retired'
      record.activate(false)
      record.abort.abort()
      if (this.active.get(record.id) === record) this.active.delete(record.id)
      if (this.preparing.get(record.id) === record) this.preparing.delete(record.id)
      const error = retiredError()
      record.running?.reject(error)
      this.queue = this.queue.filter((job) => {
        if (job.record !== record) return true
        job.reject(error)
        return false
      })
      this.closeDecoder(record)
      this.finishRetirement(record)
      this.pump()
    }
    return record.cleanup
  }
  cancelPreparing(id: number): void {
    const record = this.preparing.get(id)
    if (record) void this.retireRecord(record).catch(() => {})
  }
  async prepare(command: OpenSource, assertOpening: () => void): Promise<PreparedPcmStream> {
    // Even a rejected admission consumes the transferred source lease.
    const voiceIds = new Set([...this.active.keys(), ...this.preparing.keys()])
    if (this.closed || this.records.size >= voices * 2 || (!voiceIds.has(command.id) && voiceIds.size >= voices) ||
        !Number.isSafeInteger(this.next) || !Number.isSafeInteger(command.source.size) ||
        command.source.size < 0 || !Number.isSafeInteger(command.bufferedBytes) || command.bufferedBytes < 0 ||
        command.bufferedBytes > MAX_RESOURCE_BYTES - this.bufferedBytes || command.bufferedBytes > command.source.size) {
      command.releaseSource?.()
      throw new Error(this.closed ? 'Audio stream pool is closed' : 'Audio stream source budget or metadata is invalid')
    }
    this.cancelPreparing(command.id)
    let resolveCleanup!: () => void, rejectCleanup!: (error: unknown) => void
    const cleanup = new Promise<void>((resolve, reject) => { resolveCleanup = resolve; rejectCleanup = reject })
    let activate!: (value: boolean) => void
    const activated = new Promise<boolean>((resolve) => { activate = resolve })
    // Retirement can be initiated by a later command before prepare's caller
    // has obtained its candidate. It is still joined by close().
    void cleanup.catch(() => {})
    const record: StreamRecord = { id: command.id, streamId: this.next++, command, assertOpening,
      phase: 'preparing', busy: false, requests: 0, lastSerial: 0, fallbackRead: false,
      reservedBytes: command.bufferedBytes, abort: new AbortController(),
      finishing: false, cleanup, resolveCleanup, rejectCleanup, activated, activate }
    this.bufferedBytes += record.reservedBytes
    this.records.add(record)
    this.preparing.set(record.id, record)
    try {
      await this.schedule(record, async () => {
        const decoder = command.kind === 'midi' ? undefined
          : await this.openSource(command.source, { checkpoint: () => this.assertCurrent(record), signal: record.abort.signal })
        // Register even a late decoder so retirement closes its actual state.
        record.decoder = decoder
        this.assertCurrent(record)
        if (!decoder) return
        const info = decoder.info
        if (!Number.isInteger(info.sampleRate) || info.sampleRate < 1000 || info.sampleRate > 384000 ||
            !Number.isSafeInteger(info.sampleCount) || info.sampleCount < 1 ||
            !Number.isInteger(info.channels) || info.channels < 1 || info.channels > 8 ||
            !Number.isInteger(info.bits) || info.bits < 1 || info.bits > 64)
          throw new Error('Invalid streaming PCM metadata')
        const loops = command.loops.links.length || command.loops.labels.length ? command.loops : info.loops
        record.asset = { kind: 'stream', streamId: record.streamId, sampleRate: info.sampleRate,
          sampleCount: info.sampleCount, channels: info.channels, bits: info.bits,
          loops: { links: loops.links.map((link) => ({ ...link })), labels: loops.labels.map((label) => ({ ...label })) },
          initial: [] }
      })
      if (record.asset) {
        for (let position = 0; position < Math.min(pageFrames * 2, record.asset.sampleCount); position += pageFrames) {
          const frames = Math.min(pageFrames, record.asset.sampleCount - position)
          const data = await this.schedule(record, async () => this.copyPlanes(record, await record.decoder!.read(position, frames), frames))
          this.assertCurrent(record)
          record.asset.initial.push({ position, data })
        }
      }
      this.assertCurrent(record)
      return record
    } catch (error) {
      try { await this.retireRecord(record) }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Audio source opening and cleanup failed') }
      throw error
    }
  }
  private copyPlanes(record: StreamRecord, data: Float32Array[], frames: number): Float32Array[] {
    this.assertCurrent(record)
    if (data.length !== record.decoder!.info.channels ||
        data.some((channel) => !(channel instanceof Float32Array) || channel.length !== frames))
      throw new Error('Invalid decoded PCM block')
    return data.map((channel) => {
      for (const value of channel) if (!Number.isFinite(value)) throw new Error('Non-finite decoded PCM')
      return new Float32Array(channel)
    })
  }
  private record(candidate: PreparedPcmStream): StreamRecord {
    const record = candidate as StreamRecord
    if (!this.records.has(record)) throw retiredError()
    return record
  }
  async fallbackBytes(candidate: PreparedPcmStream): Promise<Uint8Array> {
    const record = this.record(candidate)
    this.assertCurrent(record)
    if (record.asset || record.fallbackRead) throw new Error('Audio source fallback was already consumed')
    if (record.command.source.size > MAX_RESOURCE_BYTES)
      throw new Error('Unsupported audio source exceeds the 64 MiB complete decode budget')
    const additionalBytes = Math.max(0, record.command.source.size - record.reservedBytes)
    if (additionalBytes > MAX_RESOURCE_BYTES - this.bufferedBytes)
      throw new Error('Audio source session complete decode budget exceeds 64 MiB')
    this.bufferedBytes += additionalBytes
    record.reservedBytes += additionalBytes
    record.fallbackRead = true
    return this.schedule(record, async () => {
      const bytes = await record.command.source.read(0, record.command.source.size)
      this.assertCurrent(record)
      if (!(bytes instanceof Uint8Array) || bytes.length !== record.command.source.size)
        throw new Error('Truncated complete audio source fallback')
      return new Uint8Array(bytes)
    })
  }
  commit(candidate: PreparedPcmStream): void {
    const record = this.record(candidate)
    this.assertCurrent(record)
    if (!record.asset || record.phase !== 'preparing') throw new Error('PCM candidate cannot be committed')
    const previous = this.active.get(record.id)
    record.phase = 'active'
    this.preparing.delete(record.id)
    this.active.set(record.id, record)
    record.activate(true)
    // The realtime consumer owns the initial blocks now. Keep metadata only.
    record.asset = { ...record.asset, initial: [] }
    if (previous) void this.retireRecord(previous).catch(() => {})
  }
  discard(candidate: PreparedPcmStream): Promise<void> {
    return this.retireRecord(candidate as StreamRecord)
  }
  current(id: number): PreparedPcmStream | undefined { return this.active.get(id) }
  retire(id: number): Promise<void> {
    return Promise.all([...this.records].filter((record) => record.id === id)
      .map((record) => this.retireRecord(record))).then(() => {})
  }
  isCurrent(request: PcmReadRequest): boolean {
    const record = this.active.get(request.id)
    return !this.closed && record?.streamId === request.streamId && record.phase === 'active'
  }
  async read(request: PcmReadRequest): Promise<StreamData | undefined> {
    const active = this.active.get(request.id), prepared = this.preparing.get(request.id)
    const record = active?.streamId === request.streamId ? active : prepared?.streamId === request.streamId ? prepared : undefined
    if (this.closed || !record?.asset || record.phase === 'retired') return undefined
    if (!Number.isSafeInteger(request.serial) || request.serial < 1 || request.serial <= record.lastSerial)
      return undefined
    record.lastSerial = request.serial
    if (!Number.isSafeInteger(request.position) || request.position < 0 || request.position % pageFrames ||
        request.position >= record.asset!.sampleCount || !Number.isInteger(request.frames) ||
        request.frames !== Math.min(pageFrames, record.asset!.sampleCount - request.position))
      return { op: 'streamData', request, error: 'Invalid PCM stream page request' }
    if (record.requests >= pendingPerVoice)
      return { op: 'streamData', request, error: 'PCM stream pending request budget exceeded' }
    record.requests++
    try {
      // A realtime request may precede the outer load ACK. Do not lose its sole
      // cache request, and do not decode on behalf of an uncommitted candidate.
      if (record.phase === 'preparing' && !await record.activated) return undefined
      if (!this.isCurrent(request)) return undefined
      const data = await this.schedule(record, async () =>
        this.copyPlanes(record, await record.decoder!.read(request.position, request.frames), request.frames))
      return this.isCurrent(request) ? { op: 'streamData', request, data } : undefined
    } catch (error) {
      return this.isCurrent(request) ? { op: 'streamData', request, error: message(error) } : undefined
    } finally { record.requests-- }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (async () => {
      await Promise.allSettled([...this.records].map((record) => this.retireRecord(record)))
      const errors = this.cleanupErrors.splice(0)
      if (errors.length) throw new AggregateError(errors, 'Audio stream pool cleanup failed')
    })()
    return this.closing
  }
}
