import type { Pixels } from './graphics.ts'
export type VideoStatus = 'unload' | 'stop' | 'play' | 'pause' | 'ready'
export type VideoMode = 0 | 1 | 2 | 3
export interface VideoTimeline {
  times: number[]
  duration: number
  audioStreams: number
  videoStreams: number
}
export interface VideoSettings {
  left: number
  top: number
  width: number
  height: number
  visible: boolean
  loop: boolean
  mode: VideoMode
  playRate: number
  audioVolume: number
  audioBalance: number
  enabledAudioStream: number
  segmentLoopStartFrame: number
  segmentLoopEndFrame: number
  periodEventFrame: number
  mixingMovieAlpha: number
  mixingMovieBGColor: number
}
export interface VideoSnapshot extends VideoSettings {
  id: number
  epoch: number
  status: VideoStatus
  position: number
  frame: number
  originalWidth: number
  originalHeight: number
  fps: number
  numberOfFrame: number
  totalTime: number
  numberOfAudioStream: number
  numberOfVideoStream: number
  enabledVideoStream: number
}
export type VideoCommand =
  | {
      op: 'open'
      id: number
      epoch: number
      bytes: Uint8Array
      name: string
      settings: VideoSettings
      timeline?: VideoTimeline
    }
  | {
      op: 'play' | 'stop' | 'pause' | 'rewind' | 'prepare' | 'close' | 'inspect'
      id: number
      epoch: number
    }
  | { op: 'set'; id: number; epoch: number; settings: VideoSettings }
  | { op: 'seek'; id: number; epoch: number; position?: number; frame?: number }
  | { op: 'pauseAll'; paused: boolean }
  | { op: 'shutdown' }
  | { op: 'cancel' }
export type VideoEvent =
  | { type: 'error'; message: string }
  | {
      type: 'frame' | 'ended' | 'period'
      id: number
      epoch: number
      snapshot: VideoSnapshot
      reason?: number
      pixels?: Pixels
    }
export interface VideoResult {
  snapshot?: VideoSnapshot
  events: VideoEvent[]
}
export interface VideoBackend {
  command(command: VideoCommand): Promise<VideoResult>
  listen(callback: (event: VideoEvent) => void | Promise<void>): () => void
  close(): Promise<void>
}
export const defaultVideoSettings = (): VideoSettings => ({
  left: 0,
  top: 0,
  width: 320,
  height: 240,
  visible: false,
  loop: false,
  mode: 0,
  playRate: 1,
  audioVolume: 100000,
  audioBalance: 0,
  enabledAudioStream: 0,
  segmentLoopStartFrame: -1,
  segmentLoopEndFrame: -1,
  periodEventFrame: -1,
  mixingMovieAlpha: 1,
  mixingMovieBGColor: 0,
})
export function emptyVideoSnapshot(id: number, epoch = 0): VideoSnapshot {
  return {
    ...defaultVideoSettings(),
    id,
    epoch,
    status: 'unload',
    position: 0,
    frame: 0,
    originalWidth: 0,
    originalHeight: 0,
    fps: 0,
    numberOfFrame: 0,
    totalTime: 0,
    numberOfAudioStream: 0,
    numberOfVideoStream: 0,
    enabledVideoStream: -1,
  }
}
