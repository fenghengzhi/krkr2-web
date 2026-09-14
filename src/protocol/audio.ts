import type { AudioCommand, AudioResult, MixerCommand, AudioEvent } from '../engine/ports/audio.ts'
export interface AudioRequest {
  serial: number
  command: AudioCommand
}
export interface MixerRequest {
  serial: number
  command: MixerCommand
}
export type AudioMessage =
  | { type: 'reply'; serial: number; result?: AudioResult; error?: string }
  | { type: 'event'; event: AudioEvent }
  | { type: 'stats'; frames: number; peak: number; maxPeak: number }
export interface AudioState {
  state: 'suspended' | 'running' | 'closed' | 'unavailable'
  muted: boolean
  peak: number
  maxPeak: number
  frames: number
  error?: string
}
