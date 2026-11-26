import type { VideoCommand, VideoEvent, VideoResult } from '../engine/ports/video.ts'
export interface VideoRequest {
  serial: number
  command: VideoCommand
  /** The open serial owns a temporary file until the host releases its last view. */
  holdSource?: true
}
export type VideoMessage =
  | { type: 'sourceReleased'; serial: number }
  | { type: 'reply'; serial: number; result?: VideoResult; error?: string }
  | { type: 'event'; event: VideoEvent; serial: number }
  | { type: 'ack'; serial: number }
