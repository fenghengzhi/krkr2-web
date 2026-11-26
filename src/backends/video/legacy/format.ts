import { mp4Tag, mp4TimelineStarts } from '../../../formats/video/mp4-source.ts'

export type LegacyVideoFormat = 'mpeg' | 'mpegvideo' | 'avi'

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
  }
}

/** Existing games occasionally rename media without changing its bytes. */
export function nativeMovieMime(header: Uint8Array): 'video/mp4' | 'video/webm' | undefined {
  if (header.length >= 8 && mp4TimelineStarts.includes(mp4Tag(header, 4))) return 'video/mp4'
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) return 'video/webm'
}
