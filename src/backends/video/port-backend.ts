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
import type { VideoMessage, VideoRequest } from '../../protocol/video.ts'
import { readVideoTimeline, readVideoTimelineBlob } from '../../formats/video/mp4.ts'
import { mp4MetadataByteLimit } from '../../formats/video/mp4-source.ts'
export class PortVideoBackend implements VideoBackend {
  setRequestTimeoutsPaused(paused: boolean): void {
    this.timeouts.setPaused(paused)
  }
  private next = 1
  private closed = false
  private closing?: Promise<void>
  private readonly openings = new Map<number, object>()
  private readonly sourceCancels = new Set<() => void>()
  private readonly sources = new Map<object, number>()
  private sourceBytes = 0
  private metadataBytes = 0
  private readonly preparedLeases = new WeakMap<VideoBlobPayload, { control: VideoSourceControl; retain(): () => void }>()
  /** Owned payload accounting, not a measurement of the JavaScript heap. */
  inspectSources(): { preparations: number; bufferedBytes: number; metadataBytes: number } {
    return { preparations: this.sources.size, bufferedBytes: this.sourceBytes, metadataBytes: this.metadataBytes }
  }
  async prepareSource(resource: Resource, control: VideoSourceControl): Promise<PreparedVideoSource> {
    if (this.closed) throw new Error('Video backend is closed')
    const size = resource.size, buffered = !resource.source?.borrowBlob
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid video source size')
    if (size > (buffered ? videoSourceLimits.bufferedBytes : videoSourceLimits.borrowedBytes))
      throw new Error('Video source exceeds source budget')
    if (this.sources.size >= 64 || this.sourceBytes + (buffered ? size : 0) > videoSourceLimits.bufferedBytes)
      throw new Error('Video source preparation budget exceeded')
    const token = {}, charge = buffered ? size : 0
    this.sources.set(token, charge); this.sourceBytes += charge
    let prepared: VideoBlobPayload | undefined, owners = 1, released = false
    const drop = () => {
      if (--owners !== 0 || !this.sources.delete(token)) return
      this.sourceBytes -= charge
      if (prepared) this.preparedLeases.delete(prepared)
    }
    const release = () => { if (!released) { released = true; drop() } }
    let cancelled = false, rejectCancel!: (error: unknown) => void
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancel = reject })
    const cancel = () => { cancelled = true; rejectCancel(new ExecutionCancelled()) }
    this.sourceCancels.add(cancel)
    const unlisten = control.onCancel(cancel)
    const check = () => {
      control.check()
      if (cancelled || this.closed) throw new ExecutionCancelled()
    }
    const actual = (async () => {
      try {
        check()
        const bytes = await prepareVideoBlob(resource, {
          check, onCancel: control.onCancel,
          checkpoint: async () => { check(); await control.checkpoint(); check() },
        })
        check()
        prepared = bytes
        this.preparedLeases.set(bytes, { control, retain: () => {
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
  ) {
    port.onmessage = (event: MessageEvent<VideoMessage>) => {
      const message = event.data
      if (message.type === 'reply') {
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
  async command(command: VideoCommand): Promise<VideoResult> {
    if (command.op === 'shutdown') {
      await this.close()
      return { events: [] }
    }
    if (this.closed) throw new Error('Video backend is closed')
    if (command.op === 'close') this.openings.delete(command.id)
    if (command.op === 'cancel') {
      this.openings.clear()
      for (const cancel of this.sourceCancels) cancel()
    }
    if (command.op === 'open') {
      const { id } = command,
        ticket = {},
        prepared = command.bytes instanceof Uint8Array ? undefined : this.preparedLeases.get(command.bytes),
        sourceControl = prepared?.control
      let bytes: Uint8Array | VideoBlobPayload
      if (command.bytes instanceof Uint8Array) bytes = Uint8Array.from(command.bytes)
      else {
        const { blob, buffered } = command.bytes
        if (!(blob instanceof Blob) || typeof buffered !== 'boolean' ||
            blob.size > (buffered ? videoSourceLimits.bufferedBytes : videoSourceLimits.borrowedBytes))
          throw new Error('Invalid video Blob source')
        bytes = { blob: blob.slice(), buffered }
      }
      const outgoing = { ...command, bytes, settings: { ...command.settings } }, releaseSource = prepared?.retain()
      let metadata: Promise<Awaited<ReturnType<typeof readVideoTimeline>>> | undefined
      this.openings.set(id, ticket)
      try {
        const checkpoint = () => {
          sourceControl?.check()
          if (this.closed) throw new Error('Video backend closed while reading metadata')
          if (this.openings.get(id) !== ticket)
            throw new Error('Video open was closed or superseded while reading metadata')
        }
        let metadataBytes = 0
        const options = {
          checkpoint: async () => { checkpoint(); await sourceControl?.checkpoint(); checkpoint() },
          yieldControl: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
          reserveMetadata: (size: number) => {
            checkpoint()
            if (!Number.isSafeInteger(size) || size < 0 || this.metadataBytes + size > mp4MetadataByteLimit)
              throw new Error('Video metadata exceeds 64 MiB budget')
            metadataBytes += size
            this.metadataBytes += size
          },
        }
        metadata = (async () => {
          try {
            if (bytes instanceof Uint8Array) return await this.readTimeline(bytes)
            return await this.readBlobTimeline(bytes.blob, options)
          } finally {
            this.metadataBytes -= metadataBytes
          }
        })()
        let off = () => {}
        const timeline = await (sourceControl ? Promise.race([metadata, new Promise<never>((_resolve, reject) => {
          off = sourceControl.onCancel(() => reject(new ExecutionCancelled()))
        })]) : metadata).finally(() => off())
        checkpoint()
        return await this.send({ ...outgoing, timeline }, bytes instanceof Uint8Array ? undefined : () => {
          if (this.closed || this.openings.get(id) !== ticket) return
          // Same epoch retirement cannot close a later graph. Do not wait for
          // the lost open reply; the host processes close while open awaits IO.
          void this.send({ op: 'close', id, epoch: outgoing.epoch }).catch(() => {})
        })
      } finally {
        if (this.openings.get(id) === ticket) this.openings.delete(id)
        // Cancelled metadata may still own a provider read and its Blob. Do
        // not advertise those held bytes as free until that operation settles.
        if (metadata) void metadata.then(() => releaseSource?.(), () => releaseSource?.())
        else releaseSource?.()
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
  private send(command: VideoCommand, onTimeout?: () => void): Promise<VideoResult> {
    const serial = this.next++
    return new Promise((resolve, reject) => {
      const cancelTimeout = this.timeouts.start(20000, () => {
        this.pending.delete(serial)
        onTimeout?.()
        reject(new Error(`Video ${command.op} timed out`))
      })
      this.pending.set(serial, { resolve, reject, cancelTimeout })
      try {
        this.port.postMessage(
          { serial, command } satisfies VideoRequest,
          command.op === 'open' && command.bytes instanceof Uint8Array
            ? [command.bytes.buffer as ArrayBuffer]
            : command.op === 'mixing' && command.bitmap
              ? [command.bitmap.pixels.data.buffer as ArrayBuffer]
              : [],
        )
      } catch (error) {
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
    this.openings.clear()
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
      }
    })()
    return this.closing
  }
}
