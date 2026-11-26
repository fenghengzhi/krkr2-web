import type { Mp4TrackDescriptions } from '../../../formats/video/mp4.ts'
import { mp4Tag, mp4TimelineStarts } from '../../../formats/video/mp4-source.ts'

const legacyVideoFormats = ['mpeg', 'mpegvideo', 'avi', 'asf', 'mov'] as const
export type LegacyVideoFormat = typeof legacyVideoFormats[number]
export const isLegacyVideoFormat = (value: unknown): value is LegacyVideoFormat =>
  typeof value === 'string' && (legacyVideoFormats as readonly string[]).includes(value)

/** These are the movie providers selected by the stock Win32 extension
 * dispatch. Keep MP4, WebM and unrelated resources on the native path. */
export function legacyVideoFormat(name: string): LegacyVideoFormat | undefined {
  const extension = /\.([^./\\>]+)$/.exec(name.split(/[?#]/, 1)[0]!)?.[1]?.toLowerCase()
  switch (extension) {
    case 'mpg':
    case 'mpeg': return 'mpeg'
    case 'mpv':
    case 'm1v': return 'mpegvideo'
    case 'avi': return 'avi'
    // Fixed dsmovie IsWindowsMediaFile routes all three to CWMReader and
    // WMV/WMA Decoder DMOs. The WASM build includes WMV1/2/3, VC-1 and
    // WMA standard/professional audio. A movie must contain a video stream.
    case 'wmv':
    case 'asf':
    case 'wma': return 'asf'
  }
}

/** Existing games occasionally rename media without changing its bytes. */
export function nativeMovieMime(header: Uint8Array): 'video/mp4' | 'video/webm' | undefined {
  if (header.length >= 8 && mp4TimelineStarts.includes(mp4Tag(header, 4))) return 'video/mp4'
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) return 'video/webm'
}

// Choose by the recorded sample descriptions, including tracks the native
// player might silently omit. Common AVC/AAC movies keep their original bytes.
const oldQuickTimeVideo = new Set(['mp4v', 'rle ', 'cvid', 'jpeg', 'mjpa'])
const convertibleVideo = new Set([...oldQuickTimeVideo, 'avc1', 'avc3'])
const convertibleAudio = new Set(['mp4a', '.mp3', 'mp3 ', 'sowt', 'twos', 'in24', 'in32', 'fl32', 'fl64', 'raw ', 'ac-3'])
export function needsQuickTimeConversion(tracks: readonly Mp4TrackDescriptions[]): boolean {
  if (tracks.length > 16) return false // The converter accepts at most 16 container streams.
  let legacy = false
  for (const track of tracks) {
    if (track.handler !== 'vide' && track.handler !== 'soun') continue
    const supported = track.handler === 'vide' ? convertibleVideo : convertibleAudio
    if (!track.entries.length || track.entries.some((entry) => !supported.has(entry))) return false
    if (track.handler === 'vide' && track.entries.some((entry) => oldQuickTimeVideo.has(entry))) legacy = true
  }
  return legacy
}
