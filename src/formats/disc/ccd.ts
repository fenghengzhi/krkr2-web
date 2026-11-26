import { cueLimits, type CueSheet, type CueTrack } from '../audio/cue.ts'
import type { ByteSource } from '../../engine/ports/storage.ts'

const invalid = (message: string): never => { throw new Error('Invalid CloneCD image: ' + message) }
const integerField = (fields: Map<string, string>, key: string): number => {
  const value = fields.get(key)
  if (value === undefined || !/^(?:-?\d+|0x[\da-f]+)$/i.test(value) || !Number.isSafeInteger(Number(value)))
    return invalid('missing or invalid ' + key)
  return Number(value)
}

/** For a single session, track INDEX positions and TOC PLBAs address the
 * companion IMG in 2352-byte sectors. CONTROL identifies data tracks and
 * the recorded sector header distinguishes Mode 1 from Mode 2. */
export async function parseCloneCd(text: string, imageName: string, image: ByteSource): Promise<CueSheet> {
  if (text.length > cueLimits.bytes || text.includes('\0')) return invalid('descriptor exceeds the text limit or contains NUL')
  const lines = text.split(/\r\n?|\n/)
  if (lines.length > cueLimits.lines) return invalid('descriptor exceeds the line limit')
  if (!Number.isSafeInteger(image.size) || image.size <= 0 || image.size % 2352) return invalid('incomplete IMG sectors')
  const sections = new Map<string, Map<string, string>>()
  let fields: Map<string, string> | undefined
  for (const raw of lines) {
    const line = raw.split(';', 1)[0]!.trim()
    if (!line) continue
    const heading = /^\[([^\]]+)\]$/.exec(line)
    if (heading) {
      const name = heading[1]!.trim().toLowerCase().replace(/\s+/g, ' ')
      if (sections.has(name)) return invalid('duplicate section ' + name)
      fields = new Map(); sections.set(name, fields)
      continue
    }
    const at = line.indexOf('=')
    if (!fields || at < 1) return invalid('expected section or property')
    const key = line.slice(0, at).trim().toLowerCase().replace(/\s+/g, ' ')
    if (fields.has(key)) return invalid('duplicate property ' + key)
    fields.set(key, line.slice(at + 1).trim())
  }
  const header = sections.get('clonecd'), disc = sections.get('disc')
  if (!header || !disc || ![2, 3].includes(integerField(header, 'version'))) return invalid('unsupported CCD version')
  if (integerField(disc, 'sessions') !== 1 || (disc.has('datatracksscrambled') && integerField(disc, 'datatracksscrambled') !== 0))
    return invalid('only single-session, unscrambled images are supported')
  const toc = new Map<number, { control: number; start: number }>(), trackFields = new Map<number, Map<string, string>>()
  let leadOut = image.size / 2352
  for (const [section, values] of sections) {
    const track = /^track (\d+)$/.exec(section)
    if (track) {
      const id = Number(track[1])
      if (id < 1 || id > 99 || trackFields.has(id)) return invalid('invalid TRACK number')
      trackFields.set(id, values)
    } else if (/^entry \d+$/.test(section)) {
      if (integerField(values, 'session') !== 1) return invalid('entry outside the first session')
      const point = integerField(values, 'point')
      if (point === 0xa2) leadOut = integerField(values, 'plba')
      if (point < 1 || point > 99 || (values.has('adr') && integerField(values, 'adr') !== 1)) continue
      if (toc.has(point)) return invalid('duplicate TOC track')
      toc.set(point, { control: integerField(values, 'control'), start: integerField(values, 'plba') })
    }
  }
  const tracks: CueTrack[] = [], ids = [...new Set([...toc.keys(), ...trackFields.keys()])].sort((a, b) => a - b)
  if (!ids.length || leadOut <= 0 || leadOut > image.size / 2352) return invalid('empty disc or invalid lead-out')
  let previous = -1
  for (const id of ids) {
    const entry = toc.get(id), values = trackFields.get(id), indices = new Map<number, number>()
    if (values) for (const key of values.keys()) {
      const index = /^index (\d{1,2})$/.exec(key)
      if (index) indices.set(Number(index[1]), integerField(values, key))
    }
    const first = indices.get(1) ?? entry?.start
    if (first === undefined || first < 0 || (entry && entry.start !== first)) return invalid('inconsistent track start')
    indices.set(1, first)
    if (!tracks.length && (indices.get(0) ?? 0) < 0) indices.delete(0) // pregap before physical sector zero
    let last = previous
    for (const [, frame] of [...indices].sort(([a], [b]) => a - b)) {
      if (frame <= previous || frame < last || frame >= leadOut) return invalid('overlapping or out-of-range track index')
      last = frame
    }
    previous = last
    if (entry && (entry.control < 0 || entry.control > 15)) return invalid('invalid TOC control')
    let mode = values?.has('mode') ? integerField(values, 'mode') : undefined
    const data = entry ? !!(entry.control & 4) : mode === 1 || mode === 2
    if (data) {
      // Some writers put the wrong MODE in an otherwise readable descriptor.
      // A real sector identifies its geometry, also for older TOC-only sheets.
      const sector = await image.read(first * 2352, 16)
      if (sector.length !== 16) return invalid('truncated IMG sector header')
      if (sector[0] === 0 && sector[11] === 0 && sector.subarray(1, 11).every((byte) => byte === 255))
        mode = sector[15]
      if (mode !== 1 && mode !== 2) return invalid('unrecognized data track in the IMG')
    } else if (entry) mode = 0
    if (mode !== 0 && mode !== 1 && mode !== 2) return invalid('unsupported track mode')
    const flags = new Set(values?.get('flags')?.toUpperCase().split(/\s+/).filter(Boolean))
    if (entry && mode === 0) {
      if (entry.control & 1) flags.add('PRE')
      if (entry.control & 2) flags.add('DCP')
      if (entry.control & 8) flags.add('4CH')
    }
    tracks.push({ number: id, file: 0, mode: mode === 0 ? 'AUDIO' : `MODE${mode}/2352`,
      indices, flags: [...flags], pregap: 0, postgap: 0 })
  }
  return { files: [{ name: imageName, type: 'BINARY' }], tracks, leadOut }
}
