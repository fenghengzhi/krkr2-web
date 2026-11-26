import { emptyLoops, type MidiAsset } from '../../engine/ports/audio.ts'
import { TjsError } from '../../engine/system/tjs-error.ts'
import { TvpError } from '../../engine/system/tvp-error.ts'
interface Timed {
  tick: number
  order: number
  status: number
  data: number[]
  tempo?: number
}
// MIDIImpl::tTVPSMFTrack::ProcessEvent recognizes these prefixes only in a
// complete F0 event. It sends the reset, waits 50 ms before its CC7 resend,
// then continues the same-tick events. F7 continuation/escape is a separate
// original branch and must not accidentally acquire this sequencer delay.
const resetPrefixes = [
  [0x41, 0x10, 0x42, 0x12, 0x40, 0, 0x7f, 0, 0x41, 0xf7],
  [0x41, 0x10, 0x42, 0x12, 0, 0, 0x7f],
  [0x7e, 0x7f, 9, 1, 0xf7],
  [0x43, 0x10, 0x4c, 0, 0, 0x7e, 0, 0xf7],
] as const
const resetsNativeSmfModule = (event: Timed) => event.status === 0xf0 &&
  resetPrefixes.some((prefix) => prefix.length <= event.data.length && prefix.every((value, index) => event.data[index] === value))
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
  // Native MIDISoundBuffer.Open tests the four-byte ID before reading the
  // remaining ten header bytes. ReadBuffer and format errors have different
  // script-assignable holders.
  if (bytes.length < 4) throw new TjsError('TJSReadError', 'Truncated MIDI header')
  if (ascii(bytes, 0, 4) !== 'MThd')
    throw new TvpError('TVPInvalidSMF', ['MThd not found'], 'Invalid Standard MIDI File header')
  if (bytes.length < 14) throw new TjsError('TJSReadError', 'Truncated MIDI header')
  const header = view.getUint32(4),
    format = view.getUint16(8),
    tracks = view.getUint16(10),
    division = view.getUint16(12)
  if (format > 1) throw new TvpError('TVPInvalidSMF', ['Format must be 0 or 1'], 'Unsupported MIDI format')
  if (
    header < 6 ||
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
    if (position + 8 > bytes.length) throw new TjsError('TJSReadError', 'Truncated MIDI track header')
    if (ascii(bytes, position, 4) !== 'MTrk')
      throw new TvpError('TVPInvalidSMF', ['MTrk not found'], 'MIDI track chunk is missing')
    const end = position + 8 + view.getUint32(position + 4)
    position += 8
    if (end > bytes.length) throw new TjsError('TJSReadError', 'Truncated MIDI track')
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
        const size = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2,
          data = Array.from({ length: size }, byte)
        if (data.some((value) => value > 127)) throw new Error('MIDI channel data has a status bit')
        events.push({ tick, order: order++, status, data })
      } else if (status === 0xff) {
        const type = byte(),
          length = variable()
        if (position + length > end) throw new Error('Truncated MIDI meta event')
        if (type === 0x51) {
          // KRKR2 folds the complete meta payload into an unsigned DWORD and
          // SetTempo maps zero back to the default half-second quarter note.
          let tempo = 0
          for (let i = Math.max(0, length - 4); i < length; i++) tempo = tempo * 256 + bytes[position + i]!
          events.push({ tick, order: order++, status, data: [], tempo: tempo || 500000 })
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
      } else {
        // Native ProcessEvent consumes the system-common operands even when
        // the synthesizer has no audible response to that short message.
        const length = status === 0xf2 ? 2 : status === 0xf1 || status === 0xf3 ? 1 : 0
        events.push({ tick, order: order++, status, data: Array.from({ length }, byte) })
      }
      running = status
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
  let waitBase = 0, waits = 0
  for (const event of events) {
    time += seconds(event.tick - tick)
    tick = event.tick
    if (event.tempo) tempo = event.tempo
    else {
      const barrier = waitBase + waits / 20, outputTime = Math.max(time, barrier)
      result.events.push({ time, ...(outputTime === time ? {} : { outputTime }), status: event.status, data: event.data })
      if (resetsNativeSmfModule(event)) {
        if (time > barrier) { waitBase = time; waits = 1 }
        else waits++
      }
    }
  }
  time += seconds(endTick - tick)
  const outputEnd = Math.max(time, waitBase + waits / 20)
  if (!Number.isFinite(outputEnd) || outputEnd > 86400)
    throw new Error('MIDI duration exceeds 24-hour budget')
  result.sampleCount = Math.max(1, Math.ceil(outputEnd * result.sampleRate))
  return result
}
