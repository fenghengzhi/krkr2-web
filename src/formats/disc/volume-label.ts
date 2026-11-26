import type { ByteSource } from '../../engine/ports/storage.ts'
import type { CueSheet } from '../audio/cue.ts'

interface SectorLayout { bytes: number; payload: number }
const layouts = new Map<string, SectorLayout>([
  ['MODE1/2048', { bytes: 2048, payload: 0 }],
  ['MODE1/2352', { bytes: 2352, payload: 16 }],
  ['MODE2/2336', { bytes: 2336, payload: 8 }],
  ['MODE2/2352', { bytes: 2352, payload: 24 }],
])

export interface DiscVolumeTrack {
  file: string
  first: number
  end?: number
  layout: SectorLayout
}

/** INDEX times are file-local sector counts. Only an actual data track has
 * ISO volume descriptors; a CUE album TITLE is independent of the volume. */
export function discVolumeTrack(sheet: CueSheet): DiscVolumeTrack | 'audio' | undefined {
  const index = sheet.tracks.findIndex((track) => track.mode !== 'AUDIO')
  if (index === -1) return 'audio'
  const track = sheet.tracks[index]!, layout = layouts.get(track.mode), file = sheet.files[track.file]!
  if (!layout || file.type !== 'BINARY') return
  for (const previous of sheet.tracks.slice(0, index)) {
    if (previous.file === track.file && layout.bytes !== 2352) return
  }
  const next = sheet.tracks[index + 1]
  return { file: file.name, layout, first: track.indices.get(1)!,
    end: next?.file === track.file ? next.indices.get(0) ?? next.indices.get(1) : undefined }
}

export function isDataSector(bytes: Uint8Array, { bytes: stride, payload }: SectorLayout): boolean {
  if (stride === 2352) {
    if (bytes[0] !== 0 || bytes[11] !== 0 || bytes[15] !== (payload === 16 ? 1 : 2)) return false
    for (let i = 1; i <= 10; i++) if (bytes[i] !== 255) return false
  }
  if (payload === 8 || payload === 24) {
    const sub = payload - 8
    if (bytes[sub + 2]! & 32) return false // XA Form 2 does not carry ISO logical blocks.
    for (let i = 0; i < 4; i++) if (bytes[sub + i] !== bytes[sub + 4 + i]) return false
  }
  return true
}

/** ECMA-119 volume descriptors start at logical sector 16. Windows CDFS
 * keeps the first primary descriptor and prefers the first following Joliet
 * descriptor with a recognized escape sequence. Read their headers only. */
export async function readDiscVolumeLabel(source: ByteSource, track: DiscVolumeTrack): Promise<string | undefined> {
  const { bytes: stride, payload } = track.layout,
    end = Math.min(Math.floor(source.size / stride), track.end ?? Infinity)
  let primary: string | undefined, foundPrimary = false
  for (let i = 16; i < 16 + 64 && track.first + i < end; i++) {
    const length = payload + 91, bytes = await source.read((track.first + i) * stride, length)
    if (bytes.length !== length || !isDataSector(bytes, track.layout)) break
    const header = bytes.subarray(payload)
    if (String.fromCharCode(...header.subarray(1, 6)) !== 'CD001' || header[6] !== 1 || header[0] === 255) break
    const field = header.subarray(40, 72)
    if (header[0] === 1 && !foundPrimary) {
      foundPrimary = true
      if (field.every((byte) => byte < 128)) primary = String.fromCharCode(...field).replace(/[\0 ]+$/, '')
    } else if (header[0] === 2 && foundPrimary && header[88] === 37 && header[89] === 47 &&
        (header[90] === 64 || header[90] === 67 || header[90] === 69)) {
      let label = ''
      for (let p = 0; p < field.length; p += 2) label += String.fromCharCode((field[p]! << 8) | field[p + 1]!)
      return label.replace(/[\0 ]+$/, '')
    }
  }
  return primary
}
