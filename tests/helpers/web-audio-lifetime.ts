import { WebAudioHost } from '../../src/backends/audio/web/host.ts'
import {
  defaultSoundSettings,
  emptyLoops,
  type AudioCommand,
  type AudioResult,
} from '../../src/engine/ports/audio.ts'
import type {
  AudioMessage,
  AudioRequest,
  AudioState,
  MixerRequest,
} from '../../src/protocol/audio.ts'

export type WebAudioLifetimeCase =
  | 'close-during-decode'
  | 'open-supersedes-decode'
  | 'close-during-initialize'
  | 'shutdown-during-decode'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

type Reply = { status: 'fulfilled'; result: AudioResult } | { status: 'rejected'; error: string }

/** The host and MessageChannel are real; only the browser audio device is controlled.
 * Deferred promises select the race boundary without depending on audio hardware,
 * wall-clock sleeps, or the browser's native decoder scheduling. */
export async function exerciseWebAudioLifetime(name: WebAudioLifetimeCase) {
  const initialization = deferred<void>(),
    initializationStarted = deferred<void>(),
    decoding: ReturnType<typeof deferred<AudioBuffer>>[] = [],
    decodeStarted: ReturnType<typeof deferred<void>>[] = [],
    commands: { op: string; id?: number; sample?: number }[] = [],
    voices = new Map<number, number | undefined>(),
    states: AudioState[] = [],
    replies: Record<string, Reply> = {},
    channel = new MessageChannel(),
    pending = new Map<number, ReturnType<typeof deferred<Reply>>>()
  let next = 1,
    nodeCount = 0,
    disconnects = 0,
    portCloses = 0,
    postsAfterClose = 0,
    contextCloses = 0

  const started = (index: number) => (decodeStarted[index] ??= deferred<void>())
  class FakeContext {
    state: AudioContextState = 'running'
    onstatechange: (() => void) | null = null
    destination = {}
    audioWorklet = {
      addModule: async () => {
        initializationStarted.resolve()
        await initialization.promise
      },
    }
    async resume() {}
    async close() {
      contextCloses++
      this.state = 'closed'
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} }
    }
    decodeAudioData() {
      const job = deferred<AudioBuffer>()
      decoding.push(job)
      started(decoding.length - 1).resolve()
      return job.promise
    }
  }
  class FakeWorkletNode {
    onprocessorerror: (() => void) | null = null
    private closed = false
    port = {
      onmessage: null as ((event: MessageEvent<AudioMessage>) => void) | null,
      postMessage: (message: MixerRequest, transfer: Transferable[] = []) => {
        if (this.closed) {
          postsAfterClose++
          throw new Error('Mock worklet port is closed')
        }
        // Mirror MessagePort transfer ownership, including detached PCM buffers.
        const { serial, command } = structuredClone(message, { transfer })
        const sample =
          command.op === 'load' && command.asset.kind === 'pcm'
            ? command.asset.data[0]![0]
            : undefined
        commands.push({
          op: command.op,
          ...('id' in command ? { id: command.id } : {}),
          ...(sample === undefined ? {} : { sample }),
        })
        if (command.op === 'create') voices.set(command.id, undefined)
        if (command.op === 'load') voices.set(command.id, sample)
        if (command.op === 'close') voices.delete(command.id)
        queueMicrotask(() =>
          this.port.onmessage?.(
            new MessageEvent('message', {
              data: { type: 'reply', serial, result: { events: [] } } satisfies AudioMessage,
            }),
          ),
        )
      },
      close: () => {
        if (!this.closed) portCloses++
        this.closed = true
      },
    }
    constructor() {
      nodeCount++
    }
    connect() {}
    disconnect() {
      disconnects++
    }
  }

  const contextDescriptor = Object.getOwnPropertyDescriptor(window, 'AudioContext'),
    workletDescriptor = Object.getOwnPropertyDescriptor(window, 'AudioWorkletNode')
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeContext })
  Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, value: FakeWorkletNode })
  channel.port1.onmessage = (event: MessageEvent<AudioMessage>) => {
    const message = event.data
    if (message.type !== 'reply') return
    const job = pending.get(message.serial)
    if (!job) throw new Error('Unexpected audio reply serial: ' + message.serial)
    pending.delete(message.serial)
    job.resolve(
      message.error === undefined
        ? { status: 'fulfilled', result: message.result ?? { events: [] } }
        : { status: 'rejected', error: message.error },
    )
  }
  const host = new WebAudioHost(channel.port2, (state) => states.push(state))
  const request = (command: AudioCommand) => {
    const serial = next++,
      job = deferred<Reply>()
    pending.set(serial, job)
    channel.port1.postMessage({ serial, command } satisfies AudioRequest)
    return job.promise
  }
  const create = () =>
    request({ op: 'create', id: 7, settings: defaultSoundSettings(), kind: 'wave' })
  const open = () =>
    request({
      op: 'open',
      id: 7,
      kind: 'wave',
      // An unknown format deliberately reaches AudioContext.decodeAudioData.
      bytes: new Uint8Array([1, 2, 3, 4]),
      loops: emptyLoops(),
      settings: defaultSoundSettings(),
    })
  const decode = (index: number, sample: number) => {
    const data = new Float32Array([sample, sample])
    decoding[index]!.resolve({
      numberOfChannels: 1,
      length: data.length,
      sampleRate: 48000,
      getChannelData: () => data,
    } as unknown as AudioBuffer)
  }
  let voicesAtBoundary: { id: number; sample?: number }[] = []
  try {
    const creating = create()
    await initializationStarted.promise
    if (name === 'close-during-initialize') replies.close = await request({ op: 'close', id: 7 })
    initialization.resolve()
    replies.create = await creating

    if (name !== 'close-during-initialize') {
      const opening = open()
      await started(0).promise
      if (name === 'close-during-decode') {
        replies.close = await request({ op: 'close', id: 7 })
        decode(0, 0.25)
      } else if (name === 'open-supersedes-decode') {
        const replacing = open()
        await started(1).promise
        decode(1, 0.75)
        replies.newOpen = await replacing
        // The old native decode completes after the new PCM already loaded.
        decode(0, 0.25)
      } else {
        await host.close()
        decode(0, 0.25)
      }
      replies.oldOpen = await opening
    }
    voicesAtBoundary = [...voices].map(([id, sample]) => ({
      id,
      ...(sample === undefined ? {} : { sample }),
    }))
  } finally {
    await host.close()
    channel.port1.close()
    channel.port2.close()
    if (contextDescriptor) Object.defineProperty(window, 'AudioContext', contextDescriptor)
    else Reflect.deleteProperty(window, 'AudioContext')
    if (workletDescriptor) Object.defineProperty(window, 'AudioWorkletNode', workletDescriptor)
    else Reflect.deleteProperty(window, 'AudioWorkletNode')
  }
  return {
    name,
    replies,
    commands,
    voicesAtBoundary,
    nodeCount,
    disconnects,
    portCloses,
    postsAfterClose,
    contextCloses,
    decoderCalls: decoding.length,
    pendingReplies: pending.size,
    lastState: states.at(-1),
  }
}
