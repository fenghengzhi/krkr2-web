import { audioTag, audioView } from './pcm-source.ts'

type Read = (offset: number, length: number) => Promise<Uint8Array>

/** The APEv2 length includes its footer and items, but excludes its optional
 * header. Album art and other items do not need to enter the decoder. */
async function beforeApeTag(read: Read, end: number): Promise<number> {
  if (end < 32) return end
  const bytes = await read(end - 32, 32)
  if (audioTag(bytes, 0, 8) !== 'APETAGEX') return end
  const footer = audioView(bytes), version = footer.getUint32(8, true)
  if (version !== 2000) return end
  const length = footer.getUint32(12, true), items = footer.getUint32(16, true), flags = footer.getUint32(20, true)
  if (flags & 0x60000000 || length < 32 || length > end || items > (length - 32) / 9)
    throw new Error('Invalid MP3 APEv2 footer')
  if (!(flags & 0x80000000)) return end - length
  const start = end - length - 32
  if (start < 0) throw new Error('Missing MP3 APEv2 header')
  const header = await read(start, 32), fields = audioView(header)
  if (audioTag(header, 0, 8) !== 'APETAGEX' || fields.getUint32(8, true) !== version ||
      fields.getUint32(12, true) !== length || fields.getUint32(16, true) !== items ||
      fields.getUint32(20, true) !== ((flags | 0x20000000) >>> 0))
    throw new Error('Mismatched MP3 APEv2 header')
  return start
}

export async function mp3AudioEnd(read: Read, size: number): Promise<number> {
  // Check a terminal APE footer before looking for an ID3v1 signature:
  // the last 128 bytes of album metadata can themselves begin with "TAG".
  const end = await beforeApeTag(read, size)
  if (end < 128 || audioTag(await read(end - 128, 3), 0, 3) !== 'TAG') return end
  return end < size ? end - 128 : beforeApeTag(read, end - 128)
}
