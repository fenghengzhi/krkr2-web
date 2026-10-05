import type { ByteSource } from './storage.ts'
export type SoundKind = 'wave' | 'midi' | 'cdda'
export interface AudioInfo {
  sampleRate: number
  sampleCount: number
  channels: number
  bits: number
}
export interface LoopLink {
  from: number
  to: number
  smooth: boolean
  condition: 'no' | 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le'
  variable: number
  reference: number
  whenLooping?: boolean
}
export interface AudioLabel {
  position: number
  name: string
}
export interface LoopInfo {
  links: LoopLink[]
  labels: AudioLabel[]
}
export interface PcmAsset extends AudioInfo {
  kind: 'pcm'
  data: Float32Array[]
  loops: LoopInfo
}
export interface PcmBlock {
  position: number
  data: Float32Array[]
}
/** Serializable decoder identity and bounded initial pages, never a callback. */
export interface StreamingPcmAsset extends AudioInfo {
  kind: 'stream'
  streamId: number
  loops: LoopInfo
  initial: PcmBlock[]
}
export type WaveAsset = PcmAsset | StreamingPcmAsset
export interface PcmReadRequest {
  id: number
  streamId: number
  serial: number
  position: number
  frames: number
}
/** Synchronous realtime access: missing pages only enqueue bounded requests. */
export interface PcmAccess {
  ready(position: number, frames: number): boolean
  sample(channel: number, position: number): number
}
export interface MidiEvent {
  time: number
  status: number
  data: number[]
}
export interface MidiAsset extends AudioInfo {
  kind: 'midi'
  events: MidiEvent[]
  loops: LoopInfo
}
export type AudioAsset = WaveAsset | MidiAsset
/** A connected filter identity is fixed by open; parameters may change afterwards. */
export interface PhaseVocoderFilter {
  type: 'phase-vocoder'
  id: number
  window: number
  overlap: number
  pitch: number
  time: number
}
export interface SoundSettings {
  volume: number
  volume2: number
  pan: number
  frequency: number
  looping: boolean
  paused: boolean
  position: number
}
export interface SoundSnapshot extends AudioInfo, SoundSettings {
  id: number
  epoch: number
  status: 'unload' | 'stop' | 'play'
  fading: boolean
  flags: number[]
}
export interface SoundEvent {
  id: number
  epoch: number
  type: 'ended' | 'fade' | 'label'
  label?: string
  snapshot: SoundSnapshot
}
export type AudioEvent = SoundEvent | { type: 'error'; message: string }
export type MixerCommand =
  | { op: 'streamData'; request: PcmReadRequest; data?: Float32Array[]; error?: string }
  | { op: 'create'; id: number; settings: SoundSettings; kind?: SoundKind }
  | {
      op: 'load'
      id: number
      asset: AudioAsset
      settings: SoundSettings
      kind?: SoundKind
      filters?: readonly PhaseVocoderFilter[]
    }
  | { op: 'filters'; id: number; filters: readonly PhaseVocoderFilter[] }
  | { op: 'play' | 'stop' | 'close' | 'inspect'; id: number }
  | { op: 'set'; id: number; property: keyof SoundSettings; value: number | boolean }
  | { op: 'flag'; id: number; index: number; value: number }
  | { op: 'fade'; id: number; target: number; time: number; delay: number }
  | { op: 'stopFade'; id: number; finish: boolean }
  | { op: 'pauseAll'; paused: boolean }
  | { op: 'globalVolume'; volume: number }
  | { op: 'waveMuted'; muted: boolean }
  | { op: 'midiOut'; data: Uint8Array }
  | { op: 'shutdown' }
export type AudioCommand =
  | MixerCommand
  | {
      op: 'open'
      id: number
      kind: SoundKind
      bytes: Uint8Array
      loops: LoopInfo
      settings: SoundSettings
      filters?: readonly PhaseVocoderFilter[]
    }
  | { op: 'focusMode'; mode: number }
  | {
      /** Local Worker/backend call only; never sent across MessagePort. */
      op: 'openSource'
      id: number
      kind: SoundKind
      source: ByteSource
      bufferedBytes: number
      /** Backend retires the lease after actual decoder/read cleanup. */
      releaseSource?: () => void
      loops: LoopInfo
      settings: SoundSettings
      filters?: readonly PhaseVocoderFilter[]
    }
export type WireAudioCommand = Exclude<AudioCommand, { op: 'openSource' }>
export interface AudioResult {
  snapshot?: SoundSnapshot
  events: AudioEvent[]
}
export interface AudioBackend {
  readonly streaming?: boolean
  /** Stop admission and wake pending source opens before Session queue drain.
   * Final close still joins decoder/device cleanup. */
  cancel?(): Promise<void>
  setRequestTimeoutsPaused?(paused: boolean): void
  command(command: AudioCommand): Promise<AudioResult>
  listen(callback: (event: AudioEvent) => void): () => void
  close(): Promise<void>
}
export const emptyLoops = (): LoopInfo => ({ links: [], labels: [] })
export const defaultSoundSettings = (): SoundSettings => ({
  volume: 100000,
  volume2: 100000,
  pan: 0,
  frequency: 0,
  looping: false,
  paused: false,
  position: 0,
})
