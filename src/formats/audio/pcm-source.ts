import type { AudioInfo, LoopInfo } from '../../engine/ports/audio.ts'
import type { ByteSource } from '../../engine/ports/storage.ts'

export interface PcmSource {
  readonly info: AudioInfo & { loops: LoopInfo }
  read(position: number, frames: number): Promise<Float32Array[]>
  close(): Promise<void>
}
/** Structural AbortSignal subset; the format layer has no DOM/Node dependency. */
export interface PcmCancellationSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}
export interface PcmSourceOptions {
  checkpoint?(): void | Promise<void>
  /** Cancels opening/read waiters. A returned reader still needs close() to
   * join and release actual decoder work; the borrowed source is never closed. */
  signal?: PcmCancellationSignal
  /** Host scheduling capability, injected by the portable backend. */
  yieldControl?(): void | Promise<void>
}
export const pcmSourceLimits = Object.freeze({
  readFrames: 65536,
  pendingReads: 8,
  pendingOutputBytes: 16 * 1024 * 1024,
  readBytes: 65536,
  oggPacketBytes: 128 * 1024,
  oggPages: 1024 * 1024,
  oggLinks: 256,
  waveChunks: 65536,
  waveLoops: 4096,
})

/** All source I/O is borrowed. Closing this scope cancels its waiters without
 * closing the shared ByteSource or waiting forever for an outstanding read. */
export class PcmSourceContext {
  private closed = false
  private waiters = new Set<(error: Error) => void>()
  private steps = 0
  private lastYield = Date.now()
  private unlisten?: () => void
  constructor(readonly source: ByteSource, private readonly options: PcmSourceOptions) {
    if (!Number.isSafeInteger(source.size) || source.size < 0) throw new Error('Invalid audio source size')
    if (options.signal) {
      const signal = options.signal, abort = () => this.close()
      signal.addEventListener('abort', abort, { once: true })
      this.unlisten = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) this.close()
    }
  }
  assertOpen(): void { if (this.closed) throw new Error('PCM source is closed') }
  private wait<T>(pending: Promise<T>): Promise<T> {
    this.assertOpen()
    return new Promise<T>((resolve, reject) => {
      const cancel = (error: Error) => reject(error)
      this.waiters.add(cancel)
      pending.then((value) => {
        this.waiters.delete(cancel)
        if (this.closed) reject(new Error('PCM source is closed'))
        else resolve(value)
      }, (error) => { this.waiters.delete(cancel); reject(error) })
    })
  }
  async checkpoint(): Promise<void> {
    this.assertOpen()
    // Resolved ByteSource/decoder promises only yield microtasks. A long
    // metadata scan or exact Vorbis replay must also admit Worker control
    // messages; neither the sample timeline nor the original packet changes.
    if (++this.steps >= 64 || Date.now() - this.lastYield >= 8) {
      this.steps = 0
      await this.wait(Promise.resolve().then(() => {
        this.assertOpen()
        return this.options.yieldControl?.()
      }))
      this.lastYield = Date.now()
    }
    this.assertOpen()
    if (this.options.checkpoint) await this.wait(Promise.resolve().then(() => {
      this.assertOpen()
      return this.options.checkpoint!()
    }))
    this.assertOpen()
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
        length > pcmSourceLimits.readBytes || offset > this.source.size || length > this.source.size - offset)
      throw new Error('Audio source range is outside the bounded input')
    await this.checkpoint()
    if (!length) return new Uint8Array()
    const bytes = await this.wait(Promise.resolve().then(() => {
      this.assertOpen()
      return this.source.read(offset, length)
    }))
    await this.checkpoint()
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('Truncated audio source read')
    return new Uint8Array(bytes)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.unlisten?.()
    this.unlisten = undefined
    const error = new Error('PCM source is closed')
    for (const cancel of this.waiters) cancel(error)
    this.waiters.clear()
  }
}

/** Read outputs are reserved before queuing, compact and independently owned.
 * A single decoder operation runs at a time even when callers request seeks
 * concurrently. Transport buffers retained after delivery have their own budget. */
export abstract class OwnedPcmSource implements PcmSource {
  private tail: Promise<void> = Promise.resolve()
  private closing?: Promise<void>
  private pendingReads = 0
  private pendingBytes = 0
  private readonly channels: number
  private readonly sampleCount: number
  constructor(readonly info: AudioInfo & { loops: LoopInfo }, protected readonly context: PcmSourceContext) {
    // Public metadata must not be able to enlarge a later allocation budget.
    this.channels = info.channels
    this.sampleCount = info.sampleCount
    Object.freeze(info)
  }
  async read(position: number, frames: number): Promise<Float32Array[]> {
    this.context.assertOpen()
    if (!Number.isSafeInteger(position) || position < 0 || position > this.sampleCount ||
        !Number.isSafeInteger(frames) || frames < 0 || frames > pcmSourceLimits.readFrames)
      throw new Error('PCM read is outside the sample range or frame budget')
    const count = Math.min(frames, this.sampleCount - position), bytes = count * this.channels * 4
    if (this.pendingReads >= pcmSourceLimits.pendingReads || bytes > pcmSourceLimits.pendingOutputBytes - this.pendingBytes)
      throw new Error('PCM pending read budget exceeded')
    this.pendingReads++
    this.pendingBytes += bytes
    const work = this.tail.then(async () => {
      await this.context.checkpoint()
      const result = count ? await this.readFrames(position, count)
        : Array.from({ length: this.channels }, () => new Float32Array())
      this.context.assertOpen()
      return result
    })
    this.tail = work.then(() => {}, () => {})
    try { return await work }
    finally { this.pendingReads--; this.pendingBytes -= bytes }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.context.close()
    this.closing = this.tail.then(() => this.dispose())
    return this.closing
  }
  protected abstract readFrames(position: number, frames: number): Promise<Float32Array[]>
  protected async dispose(): Promise<void> {}
}

export const audioTag = (bytes: Uint8Array, offset: number, length = 4): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))
export const audioView = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
