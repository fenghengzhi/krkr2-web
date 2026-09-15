import { PausableTimeouts } from '../shared/pausable-timeouts.ts'
import type {
  VideoBackend,
  VideoCommand,
  VideoEvent,
  VideoResult,
} from '../../engine/ports/video.ts'
import type { VideoMessage, VideoRequest } from '../../protocol/video.ts'
import { readVideoTimeline } from '../../formats/video/mp4.ts'
export class PortVideoBackend implements VideoBackend {
  private readonly timeouts = new PausableTimeouts()
  setRequestTimeoutsPaused(paused: boolean): void {
    this.timeouts.setPaused(paused)
  }
  private next = 1
  private closed = false
  private closing?: Promise<void>
  private readonly openings = new Map<number, object>()
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
    if (command.op === 'cancel') this.openings.clear()
    if (command.op === 'open') {
      const { id } = command,
        ticket = {},
        bytes = Uint8Array.from(command.bytes)
      this.openings.set(id, ticket)
      try {
        const timeline = await this.readTimeline(bytes)
        if (this.closed) throw new Error('Video backend closed while reading metadata')
        if (this.openings.get(id) !== ticket)
          throw new Error('Video open was closed or superseded while reading metadata')
        return await this.send({ ...command, bytes, timeline })
      } finally {
        if (this.openings.get(id) === ticket) this.openings.delete(id)
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
  private send(command: VideoCommand): Promise<VideoResult> {
    const serial = this.next++
    return new Promise((resolve, reject) => {
      const cancelTimeout = this.timeouts.start(20000, () => {
        this.pending.delete(serial)
        reject(new Error(`Video ${command.op} timed out`))
      })
      this.pending.set(serial, { resolve, reject, cancelTimeout })
      try {
        this.port.postMessage(
          { serial, command } satisfies VideoRequest,
          command.op === 'open'
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
