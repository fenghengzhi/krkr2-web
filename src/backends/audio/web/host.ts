import { PausableTimeouts } from '../../shared/pausable-timeouts.ts'
import workletUrl from './mixer.worklet.ts?worker&url'
import type {
  AudioAsset,
  AudioCommand,
  AudioResult,
  MixerCommand,
} from '../../../engine/ports/audio.ts'
import { emptyLoops } from '../../../engine/ports/audio.ts'
import { decodeWav } from '../../../formats/audio/wav.ts'
import { decodeMidi } from '../../../formats/audio/midi.ts'
import { encodedSampleRate } from '../../../formats/audio/encoded-rate.ts'
import { VoiceOperations } from '../voice-operations.ts'
import type {
  AudioMessage,
  AudioRequest,
  AudioState,
  MixerRequest,
} from '../../../protocol/audio.ts'

export class WebAudioHost {
  private readonly timeouts = new PausableTimeouts()
  setRequestTimeoutsPaused(paused: boolean): void {
    this.timeouts.setPaused(paused)
  }
  private context?: AudioContext
  private node?: AudioWorkletNode
  private gain?: GainNode
  private media = new Set<{ peak: number; close(): void }>()
  private workletPeak = 0
  private loading?: Promise<AudioWorkletNode>
  private readonly operations = new VoiceOperations()
  private next = 1
  private closed = false
  private failure?: Error
  private closing?: Promise<void>
  private paused = false
  private pagePaused = false
  private resumeOnPage = false
  private globalVolume = 100000
  private focusMode = 0
  private focusChanged = () => {
    void this.updateFocus().catch((error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    )
  }
  private pending = new Map<
    number,
    { resolve(result: AudioResult): void; reject(error: Error): void }
  >()
  private state: AudioState = { state: 'suspended', muted: false, peak: 0, maxPeak: 0, frames: 0 }
  constructor(
    private readonly port: MessagePort,
    private readonly changed: (state: AudioState) => void,
  ) {
    port.onmessage = (event: MessageEvent<AudioRequest>) => {
      const { serial, command } = event.data
      void this.command(command).then(
        (result) => port.postMessage({ type: 'reply', serial, result } satisfies AudioMessage),
        (error) =>
          port.postMessage({
            type: 'reply',
            serial,
            error: error instanceof Error ? error.message : String(error),
          } satisfies AudioMessage),
      )
    }
    // Called as part of the user's import/play action. resume is deliberately
    // not awaited: autoplay suspension must never block TJS file operations.
    this.activate()
    window.addEventListener('focus', this.focusChanged)
    window.addEventListener('blur', this.focusChanged)
    document.addEventListener('visibilitychange', this.focusChanged)
  }
  private notify(): void {
    this.state.peak = this.pagePaused
      ? 0
      : Math.max(this.workletPeak, ...[...this.media].map((source) => source.peak))
    this.state.maxPeak = Math.max(this.state.maxPeak, this.state.peak)
    this.changed({ ...this.state })
  }
  private output(): GainNode {
    if (!this.context || this.closed) throw new Error('Audio context is unavailable')
    if (!this.gain) {
      this.gain = this.context.createGain()
      this.gain.gain.value = this.state.muted || this.pagePaused ? 0 : 1
      this.gain.connect(this.context.destination)
    }
    return this.gain
  }
  connectMedia(element: HTMLMediaElement): {
    set(volume: number, balance: number): void
    close(): void
  } {
    const context = this.context
    if (!context || this.closed) throw new Error('Audio context is unavailable')
    const source = context.createMediaElementSource(element),
      stereo = context.createGain(),
      split = context.createChannelSplitter(2),
      left = context.createGain(),
      right = context.createGain(),
      merge = context.createChannelMerger(2),
      analyser = context.createAnalyser()
    stereo.channelCount = 2
    stereo.channelCountMode = 'explicit'
    analyser.fftSize = 256
    source.connect(stereo).connect(split)
    split.connect(left, 0)
    split.connect(right, 1)
    left.connect(merge, 0, 0)
    right.connect(merge, 0, 1)
    merge.connect(analyser).connect(this.output())
    const samples = new Float32Array(256)
    const entry = {
      peak: 0,
      close: () => {
        clearInterval(timer)
        for (const node of [source, stereo, split, left, right, merge, analyser]) node.disconnect()
        this.media.delete(entry)
        this.notify()
      },
    }
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      entry.peak =
        context.state === 'running'
          ? samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
          : 0
      this.notify()
    }, 250)
    this.media.add(entry)
    return {
      set: (volume, balance) => {
        const gain = volume / 100000,
          pan = balance / 100000
        left.gain.value = gain * (pan > 0 ? 1 - pan : 1)
        right.gain.value = gain * (pan < 0 ? 1 + pan : 1)
      },
      close: entry.close,
    }
  }
  private async updateFocus(): Promise<AudioResult> {
    const muted =
      (this.focusMode >= 1 && document.hidden) || (this.focusMode >= 2 && !document.hasFocus())
    return this.node && !this.closed
      ? this.send(this.node, { op: 'waveMuted', muted })
      : { events: [] }
  }
  private fail(error: Error): void {
    if (this.closed || this.failure) return
    this.failure = error
    this.state.error = error.message
    this.state.state = 'unavailable'
    this.state.peak = 0
    this.node?.disconnect()
    for (const job of this.pending.values()) job.reject(error)
    this.pending.clear()
    this.port.postMessage({
      type: 'event',
      event: { type: 'error', message: error.message },
    } satisfies AudioMessage)
    this.notify()
  }
  activate(): void {
    if (this.closed || this.failure) return
    try {
      if (!this.context) {
        this.context = new AudioContext({ latencyHint: 'interactive' })
        this.context.onstatechange = () => {
          if (this.closed || this.failure) return
          this.state.state =
            this.context!.state === 'running'
              ? 'running'
              : this.context!.state === 'closed'
                ? 'closed'
                : 'suspended'
          this.notify()
        }
      }
      this.state.state = this.context.state === 'running' ? 'running' : 'suspended'
      this.notify()
      if (this.pagePaused) return
      void this.context.resume().catch((error) => {
        this.state.error = String(error)
        this.notify()
      })
    } catch (error) {
      this.state.state = 'unavailable'
      this.state.error = String(error)
      this.notify()
    }
  }
  toggle(): void {
    if (!this.context || this.context.state !== 'running') {
      this.activate()
      return
    }
    this.state.muted = !this.state.muted
    if (this.gain) this.gain.gain.value = this.state.muted || this.pagePaused ? 0 : 1
    this.notify()
  }
  async setPagePaused(paused: boolean): Promise<void> {
    if (this.closed || this.pagePaused === paused) return
    this.pagePaused = paused
    if (paused) this.resumeOnPage = this.context?.state === 'running'
    if (this.gain) this.gain.gain.value = paused || this.state.muted ? 0 : 1
    this.workletPeak = 0
    this.notify()
    if (this.node)
      await this.send(this.node, { op: 'pauseAll', paused: this.paused || this.pagePaused })
    if (!this.pagePaused && this.resumeOnPage && this.context?.state === 'suspended')
      this.activate()
    if (!this.pagePaused) this.resumeOnPage = false
  }
  private async initialize(): Promise<AudioWorkletNode> {
    if (this.closed) throw new Error('Audio host is closed')
    if (this.failure) throw this.failure
    if (this.loading) return this.loading
    let initializingNode: AudioWorkletNode | undefined
    this.loading = (async () => {
      const context = this.context
      if (!context?.audioWorklet)
        throw new Error('AudioWorklet is unavailable in this browser context')
      await context.audioWorklet.addModule(workletUrl)
      if (this.closed) throw new Error('Audio host closed during initialization')
      if (this.failure) throw this.failure
      const node = new AudioWorkletNode(context, 'krkr2-mixer', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      initializingNode = node
      this.node = node
      node.connect(this.output())
      node.onprocessorerror = () => this.fail(new Error('AudioWorklet processor failed'))
      node.port.onmessage = (event: MessageEvent<AudioMessage>) => {
        const message = event.data
        if (message.type === 'reply') {
          const job = this.pending.get(message.serial)
          if (!job) return
          this.pending.delete(message.serial)
          if (message.error) job.reject(new Error(message.error))
          else job.resolve(message.result ?? { events: [] })
        } else if (message.type === 'event') this.port.postMessage(message)
        else {
          this.state.frames = message.frames
          this.workletPeak = message.peak
          this.state.maxPeak = message.maxPeak
          this.notify()
        }
      }
      await this.send(node, { op: 'pauseAll', paused: this.paused || this.pagePaused })
      await this.send(node, { op: 'globalVolume', volume: this.globalVolume })
      await this.updateFocus()
      return node
    })()
    try {
      return await this.loading
    } catch (error) {
      if (initializingNode && this.node === initializingNode) {
        initializingNode.disconnect()
        initializingNode.port.close()
        this.node = undefined
      }
      this.loading = undefined
      throw error
    }
  }
  private send(node: AudioWorkletNode, command: MixerCommand): Promise<AudioResult> {
    if (this.closed) return Promise.reject(new Error('Audio host is closed'))
    if (this.failure) return Promise.reject(this.failure)
    const serial = this.next++
    return new Promise((resolve, reject) => {
      const cancelTimeout = this.timeouts.start(15000, () =>
        this.fail(new Error(`AudioWorklet ${command.op} timed out`)),
      )
      this.pending.set(serial, {
        resolve: (result) => {
          cancelTimeout()
          resolve(result)
        },
        reject: (error) => {
          cancelTimeout()
          reject(error)
        },
      })
      const message: MixerRequest = { serial, command }
      const transfer: Transferable[] =
        command.op === 'load' && command.asset.kind === 'pcm'
          ? command.asset.data.map((channel) => channel.buffer as ArrayBuffer)
          : []
      try {
        node.port.postMessage(message, transfer)
      } catch (error) {
        this.pending.delete(serial)
        cancelTimeout()
        reject(error)
      }
    })
  }
  private async command(command: AudioCommand): Promise<AudioResult> {
    if (command.op === 'shutdown') {
      await this.close()
      return { events: [] }
    }
    if (this.closed) throw new Error('Audio host is closed')
    if (this.failure) throw this.failure
    if (command.op === 'focusMode') {
      this.focusMode = command.mode
      return this.updateFocus()
    }
    if (command.op === 'pauseAll') {
      this.paused = command.paused
      return this.node
        ? this.send(this.node, { op: 'pauseAll', paused: this.paused || this.pagePaused })
        : { events: [] }
    }
    if (command.op === 'globalVolume') {
      this.globalVolume = command.volume
      if (!this.node) return { events: [] }
    }
    if (command.op === 'close') {
      this.operations.cancel(command.id)
      if (!this.node) return { events: [] }
    }
    if (command.op === 'open' || command.op === 'load' || command.op === 'create')
      return this.createVoice(command)
    return this.send(await this.initialize(), command)
  }
  private async createVoice(
    command: Extract<AudioCommand, { op: 'open' | 'load' | 'create' }>,
  ): Promise<AudioResult> {
    const ticket = this.operations.begin(command.id)
    try {
      const node = await this.initialize()
      this.operations.assertCurrent(command.id, ticket)
      if (command.op !== 'open') return await this.send(node, command)
      let asset: AudioAsset | undefined =
        command.kind === 'midi' ? decodeMidi(command.bytes) : decodeWav(command.bytes)
      if (!asset) {
        const rate = encodedSampleRate(command.bytes)
        if (rate === undefined && (command.loops.links.length || command.loops.labels.length))
          throw new Error(
            'Cannot apply sample-based SLI data to an audio format with unknown source sample rate',
          )
        const decoder = rate === undefined ? this.context! : new OfflineAudioContext(2, 1, rate)
        const buffer = await decoder.decodeAudioData(Uint8Array.from(command.bytes).buffer)
        // close may overtake a decode, including one whose caller already
        // timed out. Check at the decoder before retaining or posting PCM.
        this.operations.assertCurrent(command.id, ticket)
        if (
          buffer.numberOfChannels > 8 ||
          buffer.length * buffer.numberOfChannels * 4 > 128 * 1024 * 1024
        )
          throw new Error('Decoded audio exceeds channel or memory budget')
        asset = {
          kind: 'pcm',
          sampleRate: buffer.sampleRate,
          sampleCount: buffer.length,
          channels: buffer.numberOfChannels,
          bits: 32,
          data: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
            Float32Array.from(buffer.getChannelData(channel)),
          ),
          loops: emptyLoops(),
        }
      }
      if (command.loops.links.length || command.loops.labels.length) asset.loops = command.loops
      return await this.send(node, {
        op: 'load',
        id: command.id,
        asset,
        settings: command.settings,
        kind: command.kind,
      })
    } finally {
      this.operations.finish(command.id, ticket)
    }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.operations.clear()
    for (const source of this.media) source.close()
    this.workletPeak = 0
    this.node?.disconnect()
    this.node?.port.close()
    this.gain?.disconnect()
    window.removeEventListener('focus', this.focusChanged)
    window.removeEventListener('blur', this.focusChanged)
    document.removeEventListener('visibilitychange', this.focusChanged)
    for (const job of this.pending.values()) job.reject(new Error('Audio host is closed'))
    this.pending.clear()
    this.closing = (async () => {
      try {
        if (this.context && this.context.state !== 'closed') await this.context.close()
      } finally {
        this.state.state = 'closed'
        this.state.error = undefined
        this.state.peak = 0
        this.notify()
      }
    })()
    return this.closing
  }
}
