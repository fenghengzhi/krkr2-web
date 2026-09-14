import type { VideoCommand, VideoEvent, VideoResult } from '../engine/ports/video.ts'
export interface VideoRequest {
  serial: number
  command: VideoCommand
}
export type VideoMessage =
  | { type: 'reply'; serial: number; result?: VideoResult; error?: string }
  | { type: 'event'; event: VideoEvent; serial: number }
  | { type: 'ack'; serial: number }
