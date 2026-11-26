import type { Pixels } from './graphics.ts'
import type { VideoColorValues } from '../media/video-color.ts'
import type { ImmutableBlob, Resource } from './storage.ts'
export const videoSourceLimits = {
  bufferedBytes: 128 * 1024 ** 2,
  borrowedBytes: 2 * 1024 ** 3,
}
/** buffered distinguishes owned materialization from an immutable file view. */
export interface VideoBlobPayload {
  blob: ImmutableBlob
  buffered: boolean
}
export interface VideoSourceControl {
  check(): void
  checkpoint(): Promise<void>
  onCancel(callback: () => void): () => void
}
/** Worker-local preparation lease; never sent over the video wire. */
export interface PreparedVideoSource {
  bytes: VideoBlobPayload
  release(): void
}
export type VideoStatus = 'unload' | 'stop' | 'play' | 'pause' | 'ready'
export type VideoMode = 0 | 1 | 2 | 3
/** One encoded video track in original container order. */
export interface VideoTrackTimeline {
  id: number
  width: number
  height: number
  times: number[]
  duration: number
  frameDuration: number
}
export interface VideoTimeline {
  times: number[]
  duration: number
  /** Nominal progressive AVC duration when unambiguous; otherwise mean sample
   * duration, in milliseconds. Independent of edited presentation timestamps. */
  frameDuration: number
  audioStreams: number
  videoStreams: number
  /** Optional only for legacy embedding-provided single-track timelines. */
  videoTracks?: VideoTrackTimeline[]
  /** Top-level timing fields always describe this active track. */
  selectedVideoStream?: number
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
  enabledVideoStream: number
  segmentLoopStartFrame: number
  segmentLoopEndFrame: number
  periodEventFrame: number
  mixingMovieAlpha: number
  mixingMovieBGColor: number
  /** Present when the active mixer provides picture adjustment controls. */
  color?: VideoColorValues
}
export interface VideoSnapshot extends VideoSettings {
  /** Private object state, retained across graph close/open. Legacy backends
   * may omit it; it is never a public VideoOverlay property. */
  periodEventPast?: boolean
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
}
/** A call-time RGB snapshot, independent of its source Layer and its mask. */
export interface VideoMixingBitmap {
  pixels: Pixels
  /** Frozen VMR-style normalized output coordinates, including the half-pixel offset. */
  destination: { left: number; top: number; right: number; bottom: number }
  opacity: number
}
export type VideoCommand =
  | {
      op: 'open'
      /** Native Window identity; omitted only by legacy standalone hosts. */
      windowId?: number
      id: number
      epoch: number
      bytes: Uint8Array | VideoBlobPayload
      name: string
      settings: VideoSettings
      periodEventPast?: boolean
      /** Object-owned Prepare latch; the graph only tags actual frame events. */
      prepareToken?: number
      timeline?: VideoTimeline
    }
  | {
      op: 'play' | 'stop' | 'pause' | 'close' | 'inspect'
      id: number
      epoch: number
    }
  | { op: 'rewind'; id: number; epoch: number; silent?: boolean }
  | { op: 'prepare'; id: number; epoch: number; token: number }
  | { op: 'set'; id: number; epoch: number; settings: VideoSettings }
  /** An explicit setter matters even when the numeric cue is unchanged. */
  | { op: 'period'; id: number; epoch: number; frame: number }
  | { op: 'mixing'; id: number; epoch: number; bitmap: VideoMixingBitmap | null }
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
      /** Frame-event argument, separate from the public media-clock snapshot. */
      callbackFrame?: number
      /** Captured at rVFC registration, never inferred from readyState/clock. */
      prepareToken?: number
      reason?: number
      pixels?: Pixels
    }
export interface VideoResult {
  snapshot?: VideoSnapshot
  events: VideoEvent[]
}
export interface VideoBackend {
  prepareSource?(resource: Resource, control: VideoSourceControl): Promise<PreparedVideoSource>
  setRequestTimeoutsPaused?(paused: boolean): void
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
  enabledVideoStream: 0,
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
