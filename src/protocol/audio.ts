import type { WireAudioCommand, AudioResult, MixerCommand, AudioEvent, PcmReadRequest } from '../engine/ports/audio.ts'
export interface AudioRequest {
  serial: number
  command: WireAudioCommand
}
export interface MixerRequest {
  serial: number
  command: MixerCommand
}
export type AudioMessage =
  | { type: 'streamRead'; request: PcmReadRequest }
  | { type: 'reply'; serial: number; result?: AudioResult; error?: string }
  | { type: 'event'; event: AudioEvent }
  | { type: 'stats'; frames: number; peak: number; maxPeak: number;
      streamVoices?: number; streamBytes?: number; streamPending?: number; streamReservedBytes?: number }
export interface AudioState {
  state: 'suspended' | 'running' | 'closed' | 'unavailable'
  muted: boolean
  peak: number
  maxPeak: number
  frames: number
  error?: string
  streamVoices?: number
  streamBytes?: number
  streamPending?: number
  streamReservedBytes?: number
}
