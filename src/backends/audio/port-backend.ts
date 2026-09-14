import type {
  AudioBackend,
  AudioCommand,
  AudioResult,
  AudioEvent,
} from '../../engine/ports/audio.ts'
import type { AudioMessage, AudioRequest } from '../../protocol/audio.ts'
import { decodePortableAudio } from './decode.ts'
export class PortAudioBackend implements AudioBackend {
  private next = 1
  private closed = false
  private pending = new Map<
    number,
    {
      resolve(result: AudioResult): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private listeners = new Set<(event: AudioEvent) => void>()
  constructor(private readonly port: MessagePort) {
    port.onmessage = (event: MessageEvent<AudioMessage>) => {
      const message = event.data
      if (message.type === 'event') {
        for (const listener of this.listeners) listener(message.event)
      } else if (message.type === 'reply') {
        const job = this.pending.get(message.serial)
        if (!job) return
        clearTimeout(job.timer)
        this.pending.delete(message.serial)
        if (message.error) job.reject(new Error(message.error))
        else job.resolve(message.result ?? { events: [] })
      }
    }
  }
  async command(command: AudioCommand): Promise<AudioResult> {
    if (this.closed) return Promise.reject(new Error('Audio backend is closed'))
    if (command.op === 'open') {
      const asset = await decodePortableAudio(command.bytes, command.kind)
      if (this.closed) throw new Error('Audio backend closed during decoding')
      if (asset) {
        if (command.loops.links.length || command.loops.labels.length) asset.loops = command.loops
        command = {
          op: 'load',
          id: command.id,
          asset,
          settings: command.settings,
          kind: command.kind,
        }
      }
    }
    const serial = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial)
        reject(new Error(`Audio ${command.op} timed out`))
      }, 20000)
      this.pending.set(serial, { resolve, reject, timer })
      const request: AudioRequest = { serial, command }
      // File bytes remain owned by the resource cache; transfer only a private copy.
      if (command.op === 'load' && command.asset.kind === 'pcm') {
        this.port.postMessage(
          request,
          command.asset.data.map((channel) => channel.buffer as ArrayBuffer),
        )
      } else if (command.op === 'open') {
        const bytes = Uint8Array.from(command.bytes)
        request.command = { ...command, bytes }
        this.port.postMessage(request, [bytes.buffer])
      } else this.port.postMessage(request)
    })
  }
  listen(callback: (event: AudioEvent) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.command({ op: 'shutdown' })
    } finally {
      this.closed = true
      this.port.close()
      for (const job of this.pending.values()) {
        clearTimeout(job.timer)
        job.reject(new Error('Audio backend closed'))
      }
      this.pending.clear()
      this.listeners.clear()
    }
  }
}
