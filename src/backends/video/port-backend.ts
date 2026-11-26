import { PausableTimeouts } from '../shared/pausable-timeouts.ts'
import type {
  VideoBackend,
  VideoCommand,
  VideoEvent,
  VideoResult,
  PreparedVideoSource,
  VideoSourceControl,
  VideoBlobPayload,
} from '../../engine/ports/video.ts'
import { videoSourceLimits } from '../../engine/ports/video.ts'
import type { Resource } from '../../engine/ports/storage.ts'
import { ExecutionCancelled } from '../../engine/scheduler/control.ts'
import { prepareVideoBlob } from '../files/video-source.ts'
import { TemporaryMovieFiles } from '../files/temporary-movies.ts'
import type { VideoMessage, VideoRequest } from '../../protocol/video.ts'
import { readVideoTimeline, readVideoTimelineBlob, type VideoTimelineOptions } from '../../formats/video/mp4.ts'
import { mp4MetadataByteLimit } from '../../formats/video/mp4-source.ts'
import { legacyVideoFormat, nativeMovieMime, needsQuickTimeConversion, type LegacyVideoFormat } from './legacy/format.ts'
import { transcodeLegacyMovie } from './legacy/transcode.ts'
import { checkLegacyInputSize } from './legacy/module.ts'

type LegacyConverter = (input: Blob | Uint8Array, format: LegacyVideoFormat, signal: AbortSignal) => Promise<Blob>
type MoviePayload = { blob: Blob; buffered: boolean }

function waitForVideo<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let off = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    off = () => signal.removeEventListener('abort', abort)
  })
  return Promise.race([work, cancelled]).finally(() => off())
}

export class PortVideoBackend implements VideoBackend {
  setRequestTimeoutsPaused(paused: boolean): void {
    this.timeouts.setPaused(paused)
  }
  private next = 1
  private closed = false
  private closing?: Promise<void>
  private readonly openings = new Map<number, AbortController>()
  private conversionSlot: Promise<void> = Promise.resolve()
  private convertedBytes = 0
  private readonly sourceCancels = new Set<() => void>()
  private readonly sources = new Map<object, number>()
  private sourceBytes = 0
  private metadataBytes = 0
  private stagedBytes = 0
  private readonly movieFiles = new TemporaryMovieFiles()
  private readonly hostFiles = new Map<number, () => void>()
  private readonly preparedLeases = new WeakMap<VideoBlobPayload, { control: VideoSourceControl; staged: boolean; retain(): () => void }>()
  /** Owned payload accounting, not a measurement of the JavaScript heap. */
  inspectSources(): { preparations: number; bufferedBytes: number; metadataBytes: number } {
    return { preparations: this.sources.size, bufferedBytes: this.sourceBytes, metadataBytes: this.metadataBytes }
  }
  async prepareSource(resource: Resource, control: VideoSourceControl): Promise<PreparedVideoSource> {
    if (this.closed) throw new Error('Video backend is closed')
    const size = resource.size, source = resource.source
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid video source size')
    const staged = !!source && !source.borrowBlob && size > videoSourceLimits.bufferedBytes
    const buffered = !staged && !source?.borrowBlob
    if (size > (buffered ? videoSourceLimits.bufferedBytes : videoSourceLimits.borrowedBytes))
      throw new Error('Video source exceeds source budget')
    if (source && source.size !== size) throw new Error('Video resource source size mismatch')
    if (this.sources.size >= 64 || this.sourceBytes + (buffered ? size : 0) > videoSourceLimits.bufferedBytes ||
        (staged && size > videoSourceLimits.borrowedBytes - this.stagedBytes))
      throw new Error('Video source preparation budget exceeded')
    const token = {}, charge = buffered ? size : 0
    this.sources.set(token, charge); this.sourceBytes += charge
    if (staged) this.stagedBytes += size
    let file: Awaited<ReturnType<TemporaryMovieFiles['stage']>> | undefined
    let prepared: VideoBlobPayload | undefined, owners = 1, released = false
    const drop = () => {
      if (--owners !== 0 || !this.sources.delete(token)) return
      this.sourceBytes -= charge
      if (file) void file.release().then(() => { this.stagedBytes -= size })
      else if (staged) this.stagedBytes -= size
      if (prepared) this.preparedLeases.delete(prepared)
    }
    const release = () => { if (!released) { released = true; drop() } }
    let cancelled = false, rejectCancel!: (error: unknown) => void
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancel = reject })
    const stageCancel = staged ? new AbortController() : undefined
    const cancel = () => {
      cancelled = true
      const error = new ExecutionCancelled()
      stageCancel?.abort(error)
      rejectCancel(error)
    }
    this.sourceCancels.add(cancel)
    const unlisten = control.onCancel(cancel)
    const check = () => {
      control.check()
      if (cancelled || this.closed) throw new ExecutionCancelled()
    }
    const actual = (async () => {
      try {
        check()
        const preparation = {
          check, onCancel: control.onCancel,
          checkpoint: async () => { check(); await control.checkpoint(); check() },
        }
        if (stageCancel && source) file = await this.movieFiles.stage(source, preparation, stageCancel.signal)
        const bytes = file ? { blob: file.blob, buffered: false } : await prepareVideoBlob(resource, preparation)
        check()
        prepared = bytes
        this.preparedLeases.set(bytes, { control, staged, retain: () => {
          owners++
          let retired = false
          return () => { if (!retired) { retired = true; drop() } }
        } })
        return { bytes, release }
      } catch (error) { release(); throw error }
      finally { unlisten(); this.sourceCancels.delete(cancel) }
    })()
    // The actual operation remains observed after cancellation. Its charge is
    // released only when that provider settles, not when the waiter retires.
    return Promise.race([actual, cancellation])
  }
  private pending = new Map<
    number,
    {
      resolve(value: VideoResult): void
      reject(error: Error): void
      cancelTimeout(): void
    }
  >()
  private listeners = new Set<(event: VideoEvent) => void | Promise<void>>()
  constructor(
    private readonly port: MessagePort,
    private readonly readTimeline: typeof readVideoTimeline = readVideoTimeline,
    private readonly readBlobTimeline: typeof readVideoTimelineBlob = readVideoTimelineBlob,
    private readonly timeouts = new PausableTimeouts(),
    private readonly transcode: LegacyConverter = transcodeLegacyMovie,
  ) {
    port.onmessage = (event: MessageEvent<VideoMessage>) => {
      const message = event.data
      if (message.type === 'sourceReleased') {
        this.releaseHostFile(message.serial)
      } else if (message.type === 'reply') {
        const pending = this.pending.get(message.serial)
        if (!pending) return
        pending.cancelTimeout()
        this.pending.delete(message.serial)
        if (message.error) pending.reject(new Error(message.error))
        else pending.resolve(message.result ?? { events: [] })
      } else if (message.type === 'event') {
        if (this.closed) return
        void Promise.all([...this.listeners].map((listener) => listener(message.event)))
          .catch(() => {})
          .finally(() => {
            if (!this.closed)
              this.port.postMessage({ type: 'ack', serial: message.serial } satisfies VideoMessage)
          })
      }
    }
  }
  private releaseHostFile(serial: number): void {
    const release = this.hostFiles.get(serial)
    this.hostFiles.delete(serial)
    release?.()
  }
  private retireOpening(id: number): void {
    const opening = this.openings.get(id)
    this.openings.delete(id)
    opening?.abort(new Error('Video open was closed or superseded'))
  }
  private async prepareLegacy(bytes: MoviePayload | Uint8Array, format: LegacyVideoFormat, signal: AbortSignal) {
    const input = bytes instanceof Uint8Array ? bytes : bytes.blob
    let mime: ReturnType<typeof nativeMovieMime>
    if (format !== 'mov') {
      const header = input instanceof Uint8Array ? input.subarray(0, 12) : new Uint8Array(await input.slice(0, 12).arrayBuffer())
      mime = nativeMovieMime(header)
    }
    signal.throwIfAborted()
    if (mime) {
      const media: MoviePayload = bytes instanceof Uint8Array
        ? { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), buffered: true }
        : { blob: bytes.blob.slice(0, bytes.blob.size, mime), buffered: bytes.buffered }
      return { media, charge: 0 }
    }
    const size = input instanceof Uint8Array ? input.byteLength : input.size
    checkLegacyInputSize(size, !(bytes instanceof Uint8Array) && !bytes.buffered)
    // Reserve the next worker slot in order. A cancelled waiter releases
    // its source now, even when the preceding movie takes minutes to convert.
    const previous = this.conversionSlot
    let releaseSlot!: () => void
    const slot = new Promise<void>((resolve) => { releaseSlot = resolve })
    this.conversionSlot = previous.then(() => slot)
    try {
      await waitForVideo(previous, signal)
      signal.throwIfAborted()
      const result = await this.transcode(input, format, signal)
      signal.throwIfAborted()
      if (!(result instanceof Blob) || !result.size) throw new Error('Legacy movie conversion returned no MP4')
      if (result.size > videoSourceLimits.bufferedBytes - this.convertedBytes)
        throw new Error('Converted movie data exceeds 128 MiB budget')
      const media = { blob: result.slice(0, result.size, 'video/mp4'), buffered: true }
      this.convertedBytes += result.size
      return { media, charge: result.size }
    } finally { releaseSlot() }
  }
  async command(command: VideoCommand): Promise<VideoResult> {
    if (command.op === 'shutdown') {
      await this.close()
      return { events: [] }
    }
    if (this.closed) throw new Error('Video backend is closed')
    if (command.op === 'close') this.retireOpening(command.id)
    if (command.op === 'cancel') {
      for (const id of this.openings.keys()) this.retireOpening(id)
      for (const cancel of this.sourceCancels) cancel()
    }
    if (command.op === 'open') {
      const { id } = command,
        ticket = new AbortController(),
        prepared = command.bytes instanceof Uint8Array ? undefined : this.preparedLeases.get(command.bytes),
        sourceControl = prepared?.control,
        legacy = legacyVideoFormat(command.name)
      // Prepared buffered blobs already paid for their bytes. Direct callers
      // also need a bounded queue of private inputs while another movie runs.
      const copiedInput = prepared ? 0 : command.bytes instanceof Uint8Array ? command.bytes.byteLength
        : command.bytes.buffered ? command.bytes.blob.size : 0
      let directCharge = legacy ? copiedInput : 0
      if (directCharge > videoSourceLimits.bufferedBytes - this.sourceBytes)
        throw new Error('Legacy movie input exceeds 128 MiB budget')
      let bytes: Uint8Array | MoviePayload
      if (command.bytes instanceof Uint8Array) {
        if (command.bytes.byteLength > videoSourceLimits.bufferedBytes) throw new Error('Buffered video source exceeds 128 MiB budget')
        bytes = Uint8Array.from(command.bytes)
      } else {
        const { blob, buffered } = command.bytes
        if (!(blob instanceof Blob) || typeof buffered !== 'boolean' ||
            blob.size > (buffered ? videoSourceLimits.bufferedBytes : videoSourceLimits.borrowedBytes))
          throw new Error('Invalid video Blob source')
        bytes = { blob: blob.slice(), buffered }
      }
      const outgoing = { ...command, bytes, settings: { ...command.settings } }, releaseSource = prepared?.retain()
      this.sourceBytes += directCharge
      let metadata: Promise<Awaited<ReturnType<typeof readVideoTimeline>>> | undefined
      let convertedCharge = 0
      this.retireOpening(id)
      this.openings.set(id, ticket)
      let offSource: (() => void) | undefined
      try {
        offSource = sourceControl?.onCancel(() => ticket.abort(new ExecutionCancelled()))
        const checkpoint = () => {
          sourceControl?.check()
          ticket.signal.throwIfAborted()
          if (this.closed) throw new Error('Video backend closed while reading metadata')
          if (this.openings.get(id) !== ticket)
            throw new Error('Video open was closed or superseded while reading metadata')
        }
        const inspect = async (media: MoviePayload | Uint8Array, acceptTracks?: VideoTimelineOptions['acceptTracks']) => {
          let metadataBytes = 0
          const options: VideoTimelineOptions = {
            acceptTracks,
            checkpoint: async () => { checkpoint(); await sourceControl?.checkpoint(); checkpoint() },
            yieldControl: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
            reserveMetadata: (size) => {
              checkpoint()
              if (!Number.isSafeInteger(size) || size < 0 || this.metadataBytes + size > mp4MetadataByteLimit)
                throw new Error('Video metadata exceeds 64 MiB budget')
              metadataBytes += size
              this.metadataBytes += size
            },
          }
          try {
            return media instanceof Uint8Array ? await this.readTimeline(media, options) : await this.readBlobTimeline(media.blob, options)
          } finally { this.metadataBytes -= metadataBytes }
        }
        let quickTimeFailure: Error | undefined
        const withOriginalError = (error: unknown) => new AggregateError(
          [quickTimeFailure, error], `QuickTime conversion and original playback failed: ${quickTimeFailure?.message}; ${String(error)}`,
          { cause: error },
        )
        metadata = (async () => {
          if (legacy) {
            const { media, charge } = await this.prepareLegacy(bytes, legacy, ticket.signal)
            outgoing.bytes = media
            convertedCharge = charge
            checkpoint()
          }
          let quickTime = false
          let timeline = await inspect(outgoing.bytes, convertedCharge ? undefined : (tracks) => {
            quickTime = needsQuickTimeConversion(tracks)
            return !quickTime
          })
          if (quickTime) {
            checkpoint()
            const original = outgoing.bytes
            try {
              if (!legacy) {
                if (copiedInput > videoSourceLimits.bufferedBytes - this.sourceBytes)
                  throw new Error('Legacy movie input exceeds 128 MiB budget')
                directCharge = copiedInput
                this.sourceBytes += directCharge
              }
              const { media, charge } = await this.prepareLegacy(original, 'mov', ticket.signal)
              convertedCharge = charge
              checkpoint()
              timeline = await inspect(media)
              if (!timeline) throw new Error('Converted movie has no MP4 video timeline')
              outgoing.bytes = media
            } catch (error) {
              // Some browsers can play these original files directly. Keep
              // that route when conversion is unavailable or exceeds its cap.
              checkpoint()
              this.convertedBytes -= convertedCharge
              convertedCharge = 0
              quickTimeFailure = error instanceof Error ? error : new Error(String(error))
              try { timeline = await inspect(original) } catch (originalError) {
                checkpoint()
                throw withOriginalError(originalError)
              }
            }
          }
          if (convertedCharge && !timeline) throw new Error('Converted movie has no MP4 video timeline')
          return timeline
        })()
        const timeline = await waitForVideo(metadata, ticket.signal)
        checkpoint()
        try {
          return await this.send({ ...outgoing, timeline }, outgoing.bytes instanceof Uint8Array ? undefined : () => {
            if (this.closed || this.openings.get(id) !== ticket) return
            // Same epoch retirement cannot close a later graph. Do not wait for
            // the lost open reply; the host processes close while open awaits IO.
            void this.send({ op: 'close', id, epoch: outgoing.epoch }).catch(() => {})
          }, prepared?.staged && !convertedCharge ? prepared.retain() : undefined)
        } catch (error) {
          checkpoint()
          if (quickTimeFailure) throw withOriginalError(error)
          throw error
        }
      } finally {
        offSource?.()
        if (this.openings.get(id) === ticket) this.openings.delete(id)
        // Cancelled metadata may still own a provider read and its Blob. Do
        // not advertise those held bytes as free until that operation settles.
        const release = () => {
          this.sourceBytes -= directCharge
          this.convertedBytes -= convertedCharge
          releaseSource?.()
        }
        if (metadata) void metadata.then(release, release)
        else release()
      }
    }
    if (command.op === 'mixing' && command.bitmap) {
      const bitmap = command.bitmap
      // A caller may still own this snapshot. Transfer a private copy, never a Layer buffer.
      return this.send({
        ...command,
        bitmap: {
          ...bitmap,
          destination: { ...bitmap.destination },
          pixels: { ...bitmap.pixels, data: Uint8Array.from(bitmap.pixels.data) },
        },
      })
    }
    return this.send(command)
  }
  private send(command: VideoCommand, onTimeout?: () => void, releaseFile?: () => void): Promise<VideoResult> {
    const serial = this.next++
    if (releaseFile) this.hostFiles.set(serial, releaseFile)
    return new Promise((resolve, reject) => {
      const cancelTimeout = this.timeouts.start(20000, () => {
        this.pending.delete(serial)
        onTimeout?.()
        reject(new Error(`Video ${command.op} timed out`))
      })
      this.pending.set(serial, { resolve, reject, cancelTimeout })
      try {
        this.port.postMessage(
          { serial, command, ...(releaseFile ? { holdSource: true as const } : {}) } satisfies VideoRequest,
          command.op === 'open' && command.bytes instanceof Uint8Array
            ? [command.bytes.buffer as ArrayBuffer]
            : command.op === 'mixing' && command.bitmap
              ? [command.bitmap.pixels.data.buffer as ArrayBuffer]
              : [],
        )
      } catch (error) {
        this.releaseHostFile(serial)
        cancelTimeout()
        this.pending.delete(serial)
        reject(error)
      }
    })
  }
  listen(listener: (event: VideoEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    for (const cancel of this.sourceCancels) cancel()
    for (const id of this.openings.keys()) this.retireOpening(id)
    this.timeouts.setPaused(false)
    this.closing = (async () => {
      try {
        await this.send({ op: 'shutdown' })
      } finally {
        this.port.close()
        for (const pending of this.pending.values()) {
          pending.cancelTimeout()
          pending.reject(new Error('Video backend closed'))
        }
        this.pending.clear()
        this.listeners.clear()
        for (const serial of this.hostFiles.keys()) this.releaseHostFile(serial)
        await this.movieFiles.close()
      }
    })()
    return this.closing
  }
}
