import { emptyLoops, type MidiAsset } from '../../engine/ports/audio.ts'
interface Timed {
  tick: number
  order: number
  status: number
  data: number[]
  tempo?: number
}
export function decodeMidi(input: Uint8Array): MidiAsset {
  let bytes = input
  const ascii = (data: Uint8Array, at: number, n: number) =>
    String.fromCharCode(...data.subarray(at, at + n))
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'RMID') {
    const riff = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let found = false
    for (let at = 12; at + 8 <= bytes.length;) {
      const length = riff.getUint32(at + 4, true),
        end = at + 8 + length
      if (end > bytes.length) throw new Error('Truncated RMID chunk')
      if (ascii(bytes, at, 4) === 'data') {
        bytes = bytes.subarray(at + 8, end)
        found = true
        break
      }
      at = end + (length & 1)
    }
    if (!found) throw new Error('RMID has no MIDI data')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 14 || ascii(bytes, 0, 4) !== 'MThd')
    throw new Error('Invalid Standard MIDI File header')
  const header = view.getUint32(4),
    format = view.getUint16(8),
    tracks = view.getUint16(10),
    division = view.getUint16(12)
  if (
    header < 6 ||
    header + 8 > bytes.length ||
    format > 1 ||
    !tracks ||
    tracks > 256 ||
    (format === 0 && tracks !== 1) ||
    !division
  )
    throw new Error('Unsupported MIDI format or track count')
  const events: Timed[] = []
  let position = 8 + header,
    order = 0,
    endTick = 0
  for (let track = 0; track < tracks; track++) {
    if (position + 8 > bytes.length || ascii(bytes, position, 4) !== 'MTrk')
      throw new Error('MIDI track chunk is missing')
    const end = position + 8 + view.getUint32(position + 4)
    position += 8
    if (end > bytes.length) throw new Error('Truncated MIDI track')
    const byte = () => {
      if (position >= end) throw new Error('Truncated MIDI event')
      return bytes[position++]!
    }
    const variable = () => {
      let value = 0
      for (let i = 0; i < 4; i++) {
        const b = byte()
        value = value * 128 + (b & 127)
        if (!(b & 128)) return value
      }
      throw new Error('MIDI variable integer is too long')
    }
    let tick = 0,
      running = 0,
      ended = false
    while (position < end && !ended) {
      tick += variable()
      if (!Number.isSafeInteger(tick)) throw new Error('MIDI tick range exceeded')
      let status = byte()
      if (status < 128) {
        if (!running) throw new Error('MIDI running status has no predecessor')
        position--
        status = running
      }
      if (status < 0xf0) {
        running = status
        const size = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2,
          data = Array.from({ length: size }, byte)
        if (data.some((value) => value > 127)) throw new Error('MIDI channel data has a status bit')
        events.push({ tick, order: order++, status, data })
      } else if (status === 0xff) {
        const type = byte(),
          length = variable()
        if (position + length > end) throw new Error('Truncated MIDI meta event')
        if (type === 0x51) {
          if (length !== 3) throw new Error('Invalid MIDI tempo')
          const tempo = bytes[position]! * 65536 + bytes[position + 1]! * 256 + bytes[position + 2]!
          if (!tempo) throw new Error('MIDI tempo cannot be zero')
          events.push({ tick, order: order++, status, data: [], tempo })
        } else if (type === 0x2f) {
          if (length) throw new Error('Invalid MIDI end-of-track')
          ended = true
        }
        position += length
      } else if (status === 0xf0 || status === 0xf7) {
        const length = variable()
        if (position + length > end) throw new Error('Truncated MIDI system-exclusive event')
        events.push({
          tick,
          order: order++,
          status,
          data: Array.from(bytes.subarray(position, position + length)),
        })
        position += length
        running = 0
      } else throw new Error(`Unsupported MIDI system event: ${status}`)
      if (events.length > 250000) throw new Error('MIDI event budget exceeded')
    }
    endTick = Math.max(endTick, tick)
    position = end
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  let time = 0,
    tick = 0,
    tempo = 500000
  const smpte = division & 0x8000,
    frames = smpte ? 256 - (division >> 8) : 0,
    ticksPerFrame = division & 255
  if (smpte && (![24, 25, 29, 30].includes(frames) || !ticksPerFrame))
    throw new Error('Invalid MIDI SMPTE division')
  const seconds = (delta: number) =>
    smpte
      ? delta / ((frames === 29 ? 29.97 : frames) * ticksPerFrame)
      : (delta * tempo) / division / 1000000
  const result: MidiAsset = {
    kind: 'midi',
    sampleRate: 44100,
    sampleCount: 0,
    channels: 2,
    bits: 32,
    events: [],
    loops: emptyLoops(),
  }
  for (const event of events) {
    time += seconds(event.tick - tick)
    tick = event.tick
    if (event.tempo) tempo = event.tempo
    else result.events.push({ time, status: event.status, data: event.data })
  }
  time += seconds(endTick - tick)
  if (!Number.isFinite(time) || time > 86400)
    throw new Error('MIDI duration exceeds 24-hour budget')
  result.sampleCount = Math.max(1, Math.ceil(time * result.sampleRate))
  return result
}
