import { PausableTimeouts } from '../shared/pausable-timeouts.ts'
import type {
  AudioBackend,
  AudioCommand,
  AudioResult,
  AudioEvent,
} from '../../engine/ports/audio.ts'
import type { AudioMessage, AudioRequest } from '../../protocol/audio.ts'
import { decodePortableAudio } from './decode.ts'
import { VoiceOperations } from './voice-operations.ts'
export class PortAudioBackend implements AudioBackend {
  private readonly timeouts = new PausableTimeouts()
  setRequestTimeoutsPaused(paused: boolean): void {
    this.timeouts.setPaused(paused)
  }
  private next = 1
  private closed = false
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
  ) {
    port.onmessage = (event: MessageEvent<AudioMessage>) => {
      const message = event.data
      if (message.type === 'event') {
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
  }
  async command(command: AudioCommand): Promise<AudioResult> {
    if (this.closed) return Promise.reject(new Error('Audio backend is closed'))
    if (command.op === 'shutdown') {
      await this.close()
      return { events: [] }
    }
    if (command.op === 'close' || command.op === 'create' || command.op === 'load')
      this.operations.cancel(command.id)
    if (command.op === 'open') {
      const { id } = command,
        ticket = this.operations.begin(id)
      try {
        const asset = await this.decode(command.bytes, command.kind)
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
          }
        }
        return await this.send(command)
      } finally {
        this.operations.finish(id, ticket)
      }
    }
    return this.send(command)
  }
  private send(command: AudioCommand): Promise<AudioResult> {
    const serial = this.next++
    return new Promise((resolve, reject) => {
      const cancelTimeout = this.timeouts.start(20000, () => {
        this.pending.delete(serial)
        reject(new Error(`Audio ${command.op} timed out`))
      })
      this.pending.set(serial, { resolve, reject, cancelTimeout })
      const request: AudioRequest = { serial, command }
      // File bytes remain owned by the resource cache; transfer only a private copy.
      try {
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
  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.operations.clear()
    this.timeouts.setPaused(false)
    this.closing = (async () => {
      try {
        await this.send({ op: 'shutdown' })
      } finally {
        this.port.close()
        for (const job of this.pending.values()) {
          job.cancelTimeout()
          job.reject(new Error('Audio backend closed'))
        }
        this.pending.clear()
        this.listeners.clear()
      }
    })()
    return this.closing
  }
}
