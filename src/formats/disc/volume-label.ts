import type { ByteSource } from '../../engine/ports/storage.ts'
import type { CueSheet } from '../audio/cue.ts'
import { TrackReader, type DiscVolumeTrack, type SectorLayout } from './track.ts'
import { openBridgedUdf, openUdfVolume } from './udf.ts'
export { isDataSector, type DiscVolumeTrack } from './track.ts'

const layouts = new Map<string, SectorLayout>([
  ['MODE1/2048', { bytes: 2048, payload: 0 }],
  ['MODE1/2352', { bytes: 2352, payload: 16 }],
  ['MODE2/2336', { bytes: 2336, payload: 8 }],
  ['MODE2/2352', { bytes: 2352, payload: 24 }],
])

/** INDEX times are file-local sector counts. Only an actual data track has
 * volume descriptors; a CUE album TITLE is independent of the volume. */
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

/** ECMA-119 volume descriptors start at logical sector 16. Windows CDFS
 * keeps the first primary descriptor and prefers the first following Joliet
 * descriptor with a recognized escape sequence. Read their headers only.
 * A mounted UDF namespace supplies its logical volume label, including on bridges. */
export async function readDiscVolumeLabel(source: ByteSource, track: DiscVolumeTrack): Promise<string | undefined> {
  const reader = new TrackReader(source, track)
  const bridgeLabel = async (at: number, terminated: boolean, fallback: string | undefined) =>
    (await openBridgedUdf(reader, at, terminated))?.label ?? fallback
  let primary: string | undefined, foundPrimary = false
  for (let i = 16; i < 80 && (i + 1) * 2048 <= reader.size; i++) {
    const header = await reader.recognitionHeader(i, 91)
    if (!header) break
    const id = String.fromCharCode(...header.subarray(1, 6))
    if (!foundPrimary && id === 'BEA01' && header[0] === 0 && header[6] === 1)
      return (await openUdfVolume(reader, i))?.label
    if (id !== 'CD001' || header[6] !== 1) break
    if (header[0] === 255) return foundPrimary ? bridgeLabel(i, true, primary) : undefined
    const field = header.subarray(40, 72)
    if (header[0] === 1 && !foundPrimary) {
      foundPrimary = true
      if (field.every((byte) => byte < 128)) primary = String.fromCharCode(...field).replace(/[\0 ]+$/, '')
    } else if (header[0] === 2 && foundPrimary && header[88] === 37 && header[89] === 47 &&
        (header[90] === 64 || header[90] === 67 || header[90] === 69)) {
      let label = ''
      for (let p = 0; p < field.length; p += 2) label += String.fromCharCode((field[p]! << 8) | field[p + 1]!)
      return bridgeLabel(i, false, label.replace(/[\0 ]+$/, ''))
    }
  }
  return primary
}
