import type { ByteSource } from './storage.ts'
import type { CddaPcmTrack } from './cdda.ts'
export type SoundKind = 'wave' | 'midi' | 'cdda'
export type WaveConversion = 'i16' | 'i16m'
export type PcmEncoding = 'u8' | 's16' | 's24' | 's32' | 'f32' | 'f64'
export interface AudioInfo {
  sampleRate: number
  sampleCount: number
  /** When the original WAVE header reports a different duration from its physical PCM. */
  reportedSampleCount?: number
  channels: number
  bits: number
  /** Original PCM container, when known. Absent for legacy normalized assets. */
  pcmEncoding?: PcmEncoding
  /** Nonzero WAVEFORMATEXTENSIBLE channel identity; absent keeps legacy order. */
  speakerMask?: number
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
  /** Nominal score time, in seconds. */
  time: number
  /** Earliest physical output after the native SMF module-reset wait. */
  outputTime?: number
  status: number
  data: number[]
}
/** A complete physical output, already parsed from the public raw octet. */
export type MidiOutputMessage =
  | { kind: 'short'; status: number; data: number[] }
  | { kind: 'long'; data: Uint8Array }
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
  /** Frozen native -wsforcecnv output policy; absent keeps existing output. */
  waveConversion?: WaveConversion
  /** Frozen -wsexpandquad output option; absent preserves the source layout. */
  waveExpandQuad?: boolean
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
  /** Retire media while the inherited fade stays alive. A same-drive CDDA
   * replacement keeps its original stopped device status during decoding. */
  | { op: 'unload'; id: number; status?: 'unload' | 'stop' }
  | { op: 'play' | 'stop' | 'close' | 'inspect'; id: number }
  /** Wave freeDirectSound destroys rendering buffers after Stop callbacks,
   * retaining the open decoder, loop manager and inherited fade controls. */
  | { op: 'releaseWaveBuffer'; id: number }
  | { op: 'set'; id: number; property: Exclude<keyof SoundSettings, 'waveConversion' | 'waveExpandQuad'>; value: number | boolean }
  | { op: 'flag'; id: number; index: number; value: number }
  /** Native WaveFlags.reset clears all flags under one loop-manager lock. */
  | { op: 'resetFlags'; id: number }
  | { op: 'fade'; id: number; target: number; time: number; delay: number }
  | { op: 'stopFade'; id: number; finish: boolean }
  | { op: 'pauseAll'; paused: boolean }
  | { op: 'globalVolume'; volume: number }
  /** Environmental Wave attenuation only; absent volume preserves legacy silence. */
  | { op: 'waveMuted'; muted: boolean; volume?: number }
  | { op: 'midiOut'; data: Uint8Array }
  | { op: 'midiMessage'; message: MidiOutputMessage }
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
  /** Effective focus policy; optional native background level is 0..100000. */
  | { op: 'focusMode'; mode: number; muteVolume?: number }
  | {
      /** Local Worker/backend call only; never sent across MessagePort. */
      op: 'openSource'
      id: number
      kind: SoundKind
      source: ByteSource
      /** Local imported-disc selection; worklets receive only relative PCM. */
      cdda?: CddaPcmTrack
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
/** Stock WaveSoundBuffer reads loops only from its explicit SLI file, including
 * an empty/missing one. Other media retain their existing decoder fallback. */
export function selectPlaybackLoops(kind: SoundKind, requested: LoopInfo, decoded: LoopInfo): LoopInfo {
  return kind === 'wave' || requested.links.length || requested.labels.length ? requested : decoded
}
export const defaultSoundSettings = (): SoundSettings => ({
  volume: 100000,
  volume2: 100000,
  pan: 0,
  frequency: 0,
  looping: false,
  paused: false,
  position: 0,
})
