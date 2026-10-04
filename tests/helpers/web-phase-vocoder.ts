import { expect, type Page, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { AudioMessage } from '../../src/protocol/audio.ts'
import type { AudioResult, MixerCommand, SoundSnapshot } from '../../src/engine/ports/audio.ts'

export interface PhaseFilter {
  type: 'phase-vocoder'
  id: number
  window: number
  overlap: number
  pitch: number
  time: number
}
export const phaseFilter = (change: Partial<PhaseFilter> = {}): PhaseFilter => ({
  type: 'phase-vocoder',
  id: 1,
  window: 512,
  overlap: 4,
  pitch: 1,
  time: 1,
  ...change,
})
export const sourceRate = 48000
export function phaseTone(seconds: number, frequencies = [750]): number[][] {
  return frequencies.map((frequency) =>
    Array.from(
      { length: Math.round(sourceRate * seconds) },
      (_, frame) => 0.2 * Math.sin((2 * Math.PI * frequency * frame) / sourceRate),
    ),
  )
}
interface PhaseCompletionPause {
  voiceId: number
  requestContextTime: number
  requestContextFrameEstimate: number
  receiptContextTime?: number
  receiptContextFrameEstimate?: number
  result?: AudioResult
  failureContextTime?: number
  error?: string
}
interface PhasePositionObservation {
  serial: number
  before: number
  after: number
  snapshot: SoundSnapshot
}
interface PhaseCompletionPosition {
  voiceId: number
  requestSerial: number
  requestContextTime: number
  observation?: PhasePositionObservation
  failureContextTime?: number
  error?: string
}
export interface CapturedPhaseAudio {
  sampleRate: number
  startFrame: number
  endFrame: number
  channels: number[][]
  completedAt?: number
  barrierAt?: number
  completionPause?: PhaseCompletionPause
  completionPosition?: PhaseCompletionPosition
  /** AudioContext times on the page. returnReadyAt precedes Playwright's
   * serialization/delivery; it is not an observation of completed transfer. */
  bulkTransfer?: {
    materializeStartedAt: number
    materializeFinishedAt: number
    returnReadyAt?: number
  }
  eventRange?: { gapStart: number; start: number; end: number }
  gapEvents?: { contextTime: number; message: AudioMessage }[]
  events: { contextTime: number; message: AudioMessage }[]
}
interface CapturePacket {
  type: 'armed' | 'complete'
  startFrame: number
  endFrame: number
  channels?: Float32Array[]
}
interface PhaseCaptureState {
  context: AudioContext
  mixer: AudioWorkletNode
  capture: AudioWorkletNode
  silent: GainNode
  ownsContext: boolean
  serial: number
  events: CapturedPhaseAudio['events']
  eventCursor: number
  pending?: Promise<CapturedPhaseAudio>
  observer?: (event: MessageEvent<AudioMessage>) => void
  send(command: MixerCommand): Promise<AudioResult>
}
type PhaseWindow = typeof globalThis & {
  __phaseNativeMixer?: AudioWorkletNode
  __phaseObservedVoices?: Map<number, SoundSnapshot>
  __phaseCapture?: PhaseCaptureState
}

// This processor only copies its real input. It cannot synthesize a tone, run
// the production DSP, or supply expected samples to the graph under test.
const captureModule = `
class PhaseCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.channels = null; this.length = 0; this.written = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type !== 'arm' || !Number.isInteger(data.frames) || data.frames < 1 || data.frames > sampleRate * 3)
        throw new Error('Capture frame budget exceeded');
      this.length = data.frames; this.written = 0;
      this.channels = [new Float32Array(data.frames), new Float32Array(data.frames)];
      this.start = currentFrame;
      this.port.postMessage({ type: 'armed', startFrame: this.start, endFrame: this.start });
    };
  }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    if (!this.channels) return true;
    const count = Math.min(outputs[0][0].length, this.length - this.written);
    for (let channel = 0; channel < 2; channel++) {
      const input = inputs[0] && inputs[0][channel];
      if (input) this.channels[channel].set(input.subarray(0, count), this.written);
    }
    this.written += count;
    if (this.written === this.length) {
      const channels = this.channels; this.channels = null;
      this.port.postMessage({ type: 'complete', startFrame: this.start,
        endFrame: currentFrame + count, channels }, channels.map(channel => channel.buffer));
    }
    return true;
  }
}
registerProcessor('phase-test-capture', PhaseCapture);
`

/** Called only by hosted Playwright: read and hash the actual release asset. */
export async function releasePhaseWorklet() {
  const text = await readFile(new URL('../../dist/sw.js', import.meta.url), 'utf8'),
    prefix = 'self.__KRKR_SHELL__=',
    manifest = JSON.parse(text.slice(prefix.length, text.indexOf(';\n'))) as {
      build: string
      assets: { path: string; sha256: string }[]
    }
  expect(text.startsWith(prefix)).toBe(true)
  const entries = manifest.assets.filter((asset) =>
    /(?:^|\/)mixer\.worklet[-.][^/]+\.js$/.test(asset.path),
  )
  expect(entries).toHaveLength(1)
  const asset = entries[0]!,
    bytes = await readFile(new URL(`../../dist/${asset.path}`, import.meta.url))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256)
  return { ...asset, build: manifest.build, url: '/' + asset.path }
}

/** Preserve the real constructor, DSP and transport; keep only the real node reference. */
export async function observeNativePhaseMixer(page: Page) {
  await page.addInitScript(() => {
    const NativeNode = AudioWorkletNode
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options)
        if (name === 'krkr2-mixer') {
          const root = globalThis as PhaseWindow
          root.__phaseNativeMixer = this
          const voices = (root.__phaseObservedVoices = new Map())
          this.port.addEventListener('message', (event: MessageEvent<AudioMessage>) => {
            const message = event.data,
              snapshot =
                message.type === 'reply'
                  ? message.result?.snapshot
                  : message.type === 'event' && message.event.type !== 'error'
                    ? message.event.snapshot
                    : undefined
            if (snapshot) voices.set(snapshot.id, snapshot)
          })
        }
      }
    }
  })
}

/** A real AudioContext and release node, or a capture tap on the real app node. */
export async function openPhaseCapture(page: Page, releaseUrl?: string) {
  await page.evaluate(
    async ({ releaseUrl, captureModule }) => {
      const root = globalThis as PhaseWindow,
        observed = root.__phaseNativeMixer,
        context = releaseUrl ? new AudioContext() : (observed?.context as AudioContext | undefined)
      if (!context) throw new Error('The application did not create its real mixer node')
      if (releaseUrl) await context.audioWorklet.addModule(releaseUrl)
      const mixer = releaseUrl
        ? new AudioWorkletNode(context, 'krkr2-mixer', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          })
        : observed!
      const moduleUrl = URL.createObjectURL(new Blob([captureModule], { type: 'text/javascript' }))
      try {
        await context.audioWorklet.addModule(moduleUrl)
      } finally {
        URL.revokeObjectURL(moduleUrl)
      }
      const capture = new AudioWorkletNode(context, 'phase-test-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
        }),
        silent = context.createGain()
      silent.gain.value = 0
      mixer.connect(capture)
      capture.connect(silent)
      silent.connect(context.destination)
      const state: PhaseCaptureState = {
        context,
        mixer,
        capture,
        silent,
        ownsContext: !!releaseUrl,
        serial: -1000000,
        events: [],
        eventCursor: 0,
        send(command) {
          return new Promise((resolve, reject) => {
            const serial = --state.serial,
              handler = (event: MessageEvent<AudioMessage>) => {
                const packet = event.data
                if (packet.type !== 'reply' || packet.serial !== serial) return
                clearTimeout(timeout)
                mixer.port.removeEventListener('message', handler)
                if (packet.error) reject(new Error(packet.error))
                else resolve(packet.result ?? { events: [] })
              },
              timeout = setTimeout(() => {
                mixer.port.removeEventListener('message', handler)
                reject(new Error('Actual release mixer reply timed out'))
              }, 5000)
            mixer.port.addEventListener('message', handler)
            mixer.port.postMessage({ serial, command })
          })
        },
      }
      state.observer = (event: MessageEvent<AudioMessage>) => {
        if (state.events.length >= 4096) throw new Error('Actual worklet event budget exceeded')
        state.events.push({ contextTime: context.currentTime, message: event.data })
      }
      mixer.port.addEventListener('message', state.observer)
      mixer.port.start()
      root.__phaseCapture = state
      const button = document.createElement('button')
      button.id = 'phase-audio-unlock'
      button.textContent = 'Unlock real phase capture'
      button.onclick = () => {
        void context.resume()
      }
      document.body.append(button)
    },
    { releaseUrl, captureModule },
  )
  await page.locator('#phase-audio-unlock').click()
  await expect
    .poll(() => page.evaluate(() => (globalThis as PhaseWindow).__phaseCapture?.context.state))
    .toBe('running')
}

export async function phaseCommand(page: Page, command: MixerCommand): Promise<AudioResult> {
  return page.evaluate(
    (command) => (globalThis as PhaseWindow).__phaseCapture!.send(command),
    command,
  )
}
/** Read a voice that the real player has already reported as playing. */
export async function nativePhasePosition(page: Page) {
  return page.evaluate(async () => {
    const root = globalThis as PhaseWindow,
      state = root.__phaseCapture!,
      active = [...(root.__phaseObservedVoices?.values() ?? [])].filter(
        (voice) => voice.status === 'play',
      )
    if (active.length !== 1) throw new Error('Expected one observed real playing voice')
    const serial = state.serial - 1,
      before = state.context.currentTime,
      result = await state.send({ op: 'inspect', id: active[0]!.id }),
      after = state.context.currentTime
    if (!result.snapshot) throw new Error('Actual mixer omitted its position snapshot')
    return { serial, before, after, snapshot: result.snapshot }
  })
}
export async function loadPhasePcm(
  page: Page,
  channels: number[][],
  filters: PhaseFilter[],
  labels: { position: number; name: string }[] = [],
) {
  await page.evaluate(
    async ({ channels, filters, labels, sourceRate }) => {
      await (globalThis as PhaseWindow).__phaseCapture!.send({
        op: 'load',
        id: 1,
        kind: 'wave',
        filters,
        asset: {
          kind: 'pcm',
          sampleRate: sourceRate,
          sampleCount: channels[0]!.length,
          channels: channels.length,
          bits: 32,
          data: channels.map((channel) => Float32Array.from(channel)),
          loops: { links: [], labels },
        },
        settings: {
          volume: 100000,
          volume2: 100000,
          pan: 0,
          frequency: sourceRate,
          looping: false,
          paused: false,
          position: 0,
        },
      })
    },
    { channels, filters, labels, sourceRate },
  )
}

export async function beginPhaseCapture(
  page: Page,
  seconds: number,
  options: { pauseVoiceOnComplete?: number; positionVoiceOnComplete?: number } = {},
) {
  await page.evaluate(
    async ({ seconds, options }) => {
      const state = (globalThis as PhaseWindow).__phaseCapture!,
        pauseVoice = options.pauseVoiceOnComplete,
        positionVoice = options.positionVoiceOnComplete
      if (state.pending) throw new Error('Capture already pending')
      if (
        pauseVoice !== undefined &&
        (!state.ownsContext || !Number.isSafeInteger(pauseVoice) || pauseVoice < 1)
      )
        throw new Error('Completion pause requires a voice in a direct capture context')
      if (
        positionVoice !== undefined &&
        (!Number.isSafeInteger(positionVoice) || positionVoice < 1 || pauseVoice !== undefined)
      )
        throw new Error('Completion position requires one voice and cannot also pause it')
      // Keep one bounded observer journal. Events after the previous capture's
      // reply barrier belong to its following gap, never silently to this stage.
      const gapStart = state.eventCursor,
        eventStart = state.events.length,
        gapEvents = state.events.slice(gapStart, eventStart)
      let armed!: () => void, failArm!: (error: Error) => void
      const ready = new Promise<void>((resolve, reject) => {
        armed = resolve
        failArm = reject
      })
      state.pending = new Promise<CapturedPhaseAudio>((resolve, reject) => {
        const handler = (event: MessageEvent<CapturePacket>) => {
            const packet = event.data
            if (packet.type === 'armed') {
              armed()
              return
            }
            if (packet.type !== 'complete') return
            clearTimeout(timeout)
            state.capture.port.removeEventListener('message', handler)
            const completedAt = state.context.currentTime
            const finish = async (): Promise<CapturedPhaseAudio> => {
              let completionPause: PhaseCompletionPause | undefined,
                completionPosition: PhaseCompletionPosition | undefined
              if (pauseVoice !== undefined) {
                const requestContextTime = state.context.currentTime
                completionPause = {
                  voiceId: pauseVoice,
                  requestContextTime,
                  // Derived from the main-thread AudioContext clock, not an
                  // assertion about the worklet's exact command execution frame.
                  requestContextFrameEstimate: Math.round(
                    requestContextTime * state.context.sampleRate,
                  ),
                }
                try {
                  completionPause.result = await state.send({
                    op: 'set',
                    id: pauseVoice,
                    property: 'paused',
                    value: true,
                  })
                  completionPause.receiptContextTime = state.context.currentTime
                  completionPause.receiptContextFrameEstimate = Math.round(
                    completionPause.receiptContextTime * state.context.sampleRate,
                  )
                } catch (error) {
                  // Preserve captured PCM and the actual failed/timed-out
                  // operation for the caller's assertions and failure artifact.
                  completionPause.failureContextTime = state.context.currentTime
                  completionPause.error = error instanceof Error ? error.message : String(error)
                }
              } else if (positionVoice !== undefined) {
                // Record the actual production mixer's endpoint before copying
                // PCM into JS arrays or returning those arrays to Playwright.
                // The inspect reply is also an exact same-port event barrier.
                const serial = state.serial - 1,
                  before = state.context.currentTime
                completionPosition = {
                  voiceId: positionVoice,
                  requestSerial: serial,
                  requestContextTime: before,
                }
                try {
                  const result = await state.send({ op: 'inspect', id: positionVoice }),
                    after = state.context.currentTime
                  if (!result.snapshot)
                    throw new Error('Actual mixer omitted its terminal position snapshot')
                  completionPosition.observation = {
                    serial,
                    before,
                    after,
                    snapshot: result.snapshot,
                  }
                } catch (error) {
                  completionPosition.failureContextTime = state.context.currentTime
                  completionPosition.error = error instanceof Error ? error.message : String(error)
                }
              } else {
                // Capture and mixer use different MessagePorts. This actual
                // same-port reply follows already-emitted events. Empty MIDI
                // data executes no parser iteration and changes no voice state.
                await state.send({ op: 'midiOut', data: new Uint8Array(0) })
              }
              // An explicit pause/inspect reply is itself a same-port barrier.
              // Native playback may continue during PCM transfer, but its
              // terminal position observation has already been retained here.
              const barrierAt =
                  completionPause?.error || completionPosition?.error
                    ? undefined
                    : state.context.currentTime,
                eventEnd = state.events.length,
                events = state.events.slice(eventStart, eventEnd)
              state.eventCursor = eventEnd
              const materializeStartedAt = state.context.currentTime,
                channels = packet.channels!.map((channel) => Array.from(channel)),
                materializeFinishedAt = state.context.currentTime
              return {
                sampleRate: state.context.sampleRate,
                startFrame: packet.startFrame,
                endFrame: packet.endFrame,
                channels,
                completedAt,
                barrierAt,
                completionPause,
                completionPosition,
                bulkTransfer: { materializeStartedAt, materializeFinishedAt },
                eventRange: { gapStart, start: eventStart, end: eventEnd },
                gapEvents,
                events,
              }
            }
            void finish().then(resolve, reject)
          },
          timeout = setTimeout(() => {
            state.capture.port.removeEventListener('message', handler)
            const error = new Error('Actual AudioWorklet capture timed out')
            failArm(error)
            reject(error)
          }, 8000)
        state.capture.port.addEventListener('message', handler)
        state.capture.port.start()
        state.capture.port.postMessage({
          type: 'arm',
          frames: Math.ceil(seconds * state.context.sampleRate),
        })
      })
      // A render failure can precede endPhaseCapture; retain rejection for that
      // consumer without creating an unhandled rejection on the page.
      void state.pending.catch(() => {})
      await ready
    },
    { seconds, options },
  )
}
export async function endPhaseCapture(page: Page): Promise<CapturedPhaseAudio> {
  return page.evaluate(async () => {
    const state = (globalThis as PhaseWindow).__phaseCapture!
    try {
      const capture = await state.pending!
      if (capture.bulkTransfer) capture.bulkTransfer.returnReadyAt = state.context.currentTime
      return capture
    } finally {
      state.pending = undefined
    }
  })
}
export async function closePhaseCapture(page: Page) {
  await page.evaluate(async () => {
    const root = globalThis as PhaseWindow,
      state = root.__phaseCapture
    if (!state) return
    if (state.observer) state.mixer.port.removeEventListener('message', state.observer)
    state.mixer.disconnect(state.capture)
    state.capture.disconnect()
    state.silent.disconnect()
    if (state.ownsContext) {
      await state.send({ op: 'shutdown' })
      await state.context.close()
    }
    document.getElementById('phase-audio-unlock')?.remove()
    delete root.__phaseCapture
  })
}

/** Independent direct DFT, deliberately no imports from the engine's FFT/DSP. */
export function phaseSpectrum(samples: number[], rate: number, from: number, length: number) {
  const count = Math.max(0, Math.min(8192, length, samples.length - from)),
    windowed = Array.from(
      { length: count },
      (_, index) =>
        samples[from + index]! *
        (0.5 - 0.5 * Math.cos((2 * Math.PI * index) / Math.max(1, count - 1))),
    )
  const magnitude = (frequency: number) => {
    let real = 0,
      imaginary = 0
    for (let index = 0; index < count; index++) {
      const phase = (2 * Math.PI * frequency * index) / rate
      real += windowed[index]! * Math.cos(phase)
      imaginary -= windowed[index]! * Math.sin(phase)
    }
    return Math.hypot(real, imaginary) / Math.max(1, count)
  }
  let peakHz = 0,
    amplitude = 0
  for (let frequency = 200; frequency <= 2600; frequency += 8) {
    const value = magnitude(frequency)
    if (value > amplitude) {
      amplitude = value
      peakHz = frequency
    }
  }
  const coarse = peakHz
  for (let frequency = coarse - 8; frequency <= coarse + 8; frequency++) {
    const value = magnitude(frequency)
    if (value > amplitude) {
      amplitude = value
      peakHz = frequency
    }
  }
  return {
    peakHz,
    amplitude,
    count,
    probes: Object.fromEntries(
      [375, 750, 1125, 1500, 2250].map((frequency) => [frequency, magnitude(frequency)]),
    ),
  }
}
export function phaseMetrics(capture: CapturedPhaseAudio) {
  return capture.channels.map((channel) => {
    let first = -1,
      last = -1,
      peak = 0,
      sum = 0,
      nonfinite = 0
    channel.forEach((sample, frame) => {
      if (!Number.isFinite(sample)) {
        nonfinite++
        return
      }
      peak = Math.max(peak, Math.abs(sample))
      sum += sample * sample
      if (Math.abs(sample) > 0.00001) {
        if (first < 0) first = frame
        last = frame
      }
    })
    const from = Math.max(0, first) + Math.floor(capture.sampleRate * 0.1),
      length = Math.max(0, last - from - Math.floor(capture.sampleRate * 0.04))
    return {
      first,
      last,
      peak,
      rms: Math.sqrt(sum / channel.length),
      nonfinite,
      audibleSeconds: first < 0 ? 0 : (last - first + 1) / capture.sampleRate,
      spectrum: phaseSpectrum(channel, capture.sampleRate, from, length),
    }
  })
}
function floatWave(capture: CapturedPhaseAudio): Buffer {
  const channels = capture.channels.length,
    frames = capture.channels[0]!.length,
    bytes = Buffer.alloc(44 + frames * channels * 4)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(3, 20)
  bytes.writeUInt16LE(channels, 22)
  bytes.writeUInt32LE(capture.sampleRate, 24)
  bytes.writeUInt32LE(capture.sampleRate * channels * 4, 28)
  bytes.writeUInt16LE(channels * 4, 32)
  bytes.writeUInt16LE(32, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(bytes.length - 44, 40)
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < channels; channel++)
      bytes.writeFloatLE(capture.channels[channel]![frame]!, 44 + (frame * channels + channel) * 4)
  return bytes
}
export async function attachPhaseInput(info: TestInfo, name: string, channels: number[][]) {
  const bytes = floatWave({
    sampleRate: sourceRate,
    startFrame: 0,
    endFrame: channels[0]!.length,
    channels,
    events: [],
  })
  await info.attach(`${name}-input.wav`, { body: bytes, contentType: 'audio/wav' })
  await info.attach(`${name}-input.json`, {
    body: JSON.stringify({
      sampleRate: sourceRate,
      channels: channels.length,
      frames: channels[0]!.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
    contentType: 'application/json',
  })
}
export async function attachPhaseCapture(
  info: TestInfo,
  name: string,
  capture: CapturedPhaseAudio,
  extra: unknown = {},
) {
  const wav = floatWave(capture),
    metrics = phaseMetrics(capture)
  await info.attach(`${name}.wav`, { body: wav, contentType: 'audio/wav' })
  await info.attach(`${name}.json`, {
    body: JSON.stringify(
      {
        sampleRate: capture.sampleRate,
        startFrame: capture.startFrame,
        endFrame: capture.endFrame,
        frameCount: capture.channels[0]!.length,
        completedAt: capture.completedAt,
        barrierAt: capture.barrierAt,
        completionPause: capture.completionPause,
        completionPosition: capture.completionPosition,
        bulkTransfer: capture.bulkTransfer,
        eventRange: capture.eventRange,
        gapEvents: capture.gapEvents,
        sha256: createHash('sha256').update(wav).digest('hex'),
        metrics,
        events: capture.events,
        extra,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
  return metrics
}
