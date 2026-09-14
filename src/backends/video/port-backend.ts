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
  private pending = new Map<
    number,
    {
      resolve(value: VideoResult): void
      reject(error: Error): void
      cancelTimeout(): void
    }
  >()
  private listeners = new Set<(event: VideoEvent) => void | Promise<void>>()
  constructor(private readonly port: MessagePort) {
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
    if (this.closed) throw new Error('Video backend is closed')
    if (command.op === 'open')
      command = {
        ...command,
        bytes: Uint8Array.from(command.bytes),
        timeline: await readVideoTimeline(command.bytes),
      }
    if (this.closed) throw new Error('Video backend closed while reading metadata')
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
          command.op === 'open' ? [command.bytes.buffer as ArrayBuffer] : [],
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
    if (this.closed) return
    this.timeouts.setPaused(false)
    try {
      await this.command({ op: 'shutdown' })
    } finally {
      this.closed = true
      this.port.close()
      for (const pending of this.pending.values()) {
        pending.cancelTimeout()
        pending.reject(new Error('Video backend closed'))
      }
      this.pending.clear()
      this.listeners.clear()
    }
  }
}
