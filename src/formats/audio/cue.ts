/** CUE is imported media metadata, not a new CDDASoundBuffer.open grammar.
 * Times address the current FILE in 75 CD frames/second. */
export interface CueFile { name: string; type: 'WAVE' | 'MP3' | 'AIFF' | 'BINARY' | 'MOTOROLA' }
export interface CueTrack {
  number: number; file: number; mode: string; indices: Map<number, number>
  pregap: number; postgap: number; flags: string[]
}
export interface CueSheet { files: CueFile[]; tracks: CueTrack[]; leadOut?: number; scrambledData?: true }
export type CuePart = ({ kind: 'file'; file: number; startFrame: number; endFrame?: number } |
  { kind: 'silence'; frames: number }) & { preEmphasis?: true }
export const cueLimits = { bytes: 1024 * 1024, lines: 32768, files: 99, tracks: 99 } as const
const invalid = (reason: string): never => { throw new Error(`Invalid CUE sheet: ${reason}`) }
function time(value: string): number {
  const match = /^(\d{1,5}):(\d{2}):(\d{2})$/.exec(value)
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 74) return invalid('invalid CD frame time')
  return (Number(match[1]) * 60 + Number(match[2])) * 75 + Number(match[3])
}
function tokens(line: string): string[] {
  const result: string[] = []
  for (let at = 0; at < line.length;) {
    while (/\s/.test(line[at] ?? '') && at < line.length) at++
    if (at === line.length) break
    const quoted = line[at] === '"', start = quoted ? ++at : at
    while (at < line.length && (quoted ? line[at] !== '"' : !/\s/.test(line[at]!))) at++
    if (quoted && at === line.length) return invalid('unterminated quoted field')
    result.push(line.slice(start, at))
    if (quoted && ++at < line.length && !/\s/.test(line[at]!)) return invalid('missing field delimiter')
    if (result.length > 32) return invalid('too many command fields')
  }
  return result
}
export function parseCue(text: string): CueSheet {
  if (text.length > cueLimits.bytes) throw new Error('CUE metadata exceeds the 1 MiB budget')
  if (text.includes('\0')) return invalid('embedded NUL')
  const lines = text.split(/\r\n?|\n/), files: CueFile[] = [], tracks: CueTrack[] = []
  if (lines.length > cueLimits.lines) throw new Error('CUE line budget exceeded')
  let track: CueTrack | undefined, seen = new Set<string>()
  for (const original of lines) {
    const line = original.trim()
    if (!line || /^REM(?:\s|$)/i.test(line)) continue
    const fields = tokens(line), command = fields.shift()!.toUpperCase()
    if (command === 'FILE') {
      if (fields.length !== 2 || !fields[0] || fields[0].length > 4096) return invalid('invalid FILE')
      const type = fields[1]!.toUpperCase()
      if (!['WAVE', 'MP3', 'AIFF', 'BINARY', 'MOTOROLA'].includes(type)) throw new Error(`Unsupported CUE FILE type: ${type}`)
      if (files.length >= cueLimits.files) throw new Error('CUE file budget exceeded')
      files.push({ name: fields[0]!, type: type as CueFile['type'] }); track = undefined; continue
    }
    if (command === 'TRACK') {
      const number = Number(fields[0])
      if (!files.length || fields.length !== 2 || !/^\d{1,2}$/.test(fields[0]!) || number < 1 || number > 99 ||
          tracks.length && number <= tracks.at(-1)!.number) return invalid('invalid TRACK number or order')
      if (tracks.length >= cueLimits.tracks) throw new Error('CUE track budget exceeded')
      track = { number, file: files.length - 1, mode: fields[1]!.toUpperCase(), indices: new Map(), pregap: 0, postgap: 0, flags: [] }
      tracks.push(track); seen = new Set(); continue
    }
    if (['TITLE', 'PERFORMER', 'SONGWRITER', 'CATALOG', 'CDTEXTFILE', 'ISRC'].includes(command)) {
      if (fields.length !== 1) return invalid(`invalid ${command}`)
      continue
    }
    if (!track) return invalid(`${command} outside TRACK`)
    if (command === 'INDEX') {
      const number = Number(fields[0]), previous = [...track.indices].at(-1)
      if (fields.length !== 2 || !/^\d{1,2}$/.test(fields[0]!) || number > 99 ||
          previous && number <= previous[0]) return invalid('invalid INDEX number or order')
      const frame = time(fields[1]!)
      if (previous && frame < previous[1]) return invalid('decreasing INDEX time')
      track.indices.set(number, frame)
    } else if (command === 'PREGAP' || command === 'POSTGAP') {
      if (fields.length !== 1 || seen.has(command) || command === 'PREGAP' && track.indices.size) return invalid(`invalid ${command}`)
      track[command === 'PREGAP' ? 'pregap' : 'postgap'] = time(fields[0]!); seen.add(command)
    } else if (command === 'FLAGS') {
      if (!fields.length || seen.has(command)) return invalid('invalid FLAGS')
      track.flags = fields.map((value) => value.toUpperCase()); seen.add(command)
    } else return invalid(`unknown command ${command}`)
  }
  if (!tracks.length) return invalid('no tracks')
  for (let at = 0; at < tracks.length; at++) {
    const current = tracks[at]!, first = current.indices.get(1), previous = tracks[at - 1]
    if (first === undefined) return invalid('missing INDEX 01')
    if (previous?.file === current.file && first <= previous.indices.get(1)!) return invalid('overlapping tracks')
  }
  return { files, tracks }
}

/** MCI FROM track:0 TO nextTrack:0 uses successive INDEX 01 boundaries.
 * File-backed INDEX 00 data and generated gaps between them are retained. */
export function cueTrackParts(sheet: CueSheet, number: number): CuePart[] | undefined {
  const at = sheet.tracks.findIndex((track) => track.number === number), track = sheet.tracks[at]
  if (!track || track.mode !== 'AUDIO') return undefined
  const flags = (owner: CueTrack): { preEmphasis?: true } => {
    if (owner.flags.some((flag) => !['PRE', 'DCP', 'SCMS'].includes(flag)))
      throw new Error('CUE track requires unsupported channel processing or control flags')
    return owner.flags.includes('PRE') ? { preEmphasis: true } : {}
  }
  const next = sheet.tracks[at + 1], parts: CuePart[] = [], currentFlags = flags(track),
    nextStart = next?.indices.get(1), nextPregap = next?.indices.get(0) ?? nextStart
  const endFrame = next?.file === track.file ? nextPregap : !next ? sheet.leadOut : undefined
  parts.push({ kind: 'file', file: track.file, startFrame: track.indices.get(1)!, ...(endFrame === undefined ? {} : { endFrame }), ...currentFlags })
  if (track.postgap) parts.push({ kind: 'silence', frames: track.postgap, ...currentFlags })
  if (next) {
    if (next.pregap) parts.push({ kind: 'silence', frames: next.pregap,
      ...(next.mode === 'AUDIO' && next.flags.includes('PRE') ? { preEmphasis: true } : {}) })
    const start = next.file === track.file ? nextPregap! : 0
    if (nextStart! > start) {
      if (next.mode !== 'AUDIO') throw new Error('CUE data-track pregap cannot be decoded as audio')
      parts.push({ kind: 'file', file: next.file, startFrame: start, endFrame: nextStart!, ...flags(next) })
    }
  }
  for (const part of parts) if (part.kind === 'file' && ['BINARY', 'MOTOROLA'].includes(sheet.files[part.file]!.type)) {
    if (sheet.tracks.some((value) => value.file === part.file && !['AUDIO', 'MODE1/2352', 'MODE2/2352', 'CDI/2352'].includes(value.mode)))
      throw new Error('CUE mixed or non-2352-byte raw sectors are not supported')
  }
  return parts
}
