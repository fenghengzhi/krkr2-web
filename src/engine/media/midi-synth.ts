import type { MidiAsset, MidiEvent } from '../ports/audio.ts'
import { MidiPitch } from './midi-pitch.ts'
interface Channel {
  volume: number
  level: number
  used: boolean
  expression: number
  pan: number
  program: number
  bend: number
  pitch: MidiPitch
  sustain: boolean
  modulation: number
}
interface Note {
  channel: number
  key: number
  velocity: number
  born: number
  released?: number
  held: boolean
  phase: number
  family: number
  tuning: number
}
const channel = (bufferVolume = 127, previous?: Channel): Channel => ({
  volume: 100,
  level: Math.trunc(100 * bufferVolume / 127) / 127,
  used: false,
  expression: 1,
  pan: previous?.pan ?? 0,
  program: previous?.program ?? 0,
  bend: 0,
  pitch: new MidiPitch(previous?.pitch),
  sustain: false,
  modulation: 0,
})
const tau = 2 * Math.PI
// Payloads preceding EOX in the reset messages recognized by the original
// Win32 MIDI sequencer. GS mode set carries more data after its address.
const gsReset = [0x41, 0x10, 0x42, 0x12, 0x40, 0, 0x7f, 0, 0x41]
const gsModeSet = [0x41, 0x10, 0x42, 0x12, 0, 0, 0x7f]
const xgOn = [0x43, 0x10, 0x4c, 0, 0, 0x7e, 0]
function resetsModule(payload: number[]): boolean {
  const matches = (bytes: number[]) => bytes.every((value, at) => payload[at] === value)
  return (payload.length === 4 && payload[0] === 0x7e && payload[2] === 9 && (payload[3] === 1 || payload[3] === 3)) ||
    (payload.length === gsReset.length && matches(gsReset)) || matches(gsModeSet) ||
    (payload.length === xgOn.length && matches(xgOn))
}

/** Browser-resident procedural instrument bank. MIDI sequencing and controller
 * behavior are separate from timbre; a sample-bank backend can replace this. */
export class MidiSynth {
  private channels = Array.from({ length: 16 }, () => channel())
  private notes: Note[] = []
  private cursor = 0
  private time = 0
  private noise = 0x12345678
  private exclusive?: number[]
  private bufferVolume = 127
  left = 0
  right = 0
  constructor(private readonly asset?: MidiAsset) {}
  get activeNotes(): number {
    return this.notes.length
  }
  setBufferVolume(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 127)
      throw new Error('Invalid MIDI buffer volume')
    if (this.bufferVolume === value) return
    this.bufferVolume = value
    for (const c of this.channels)
      if (c.used) c.level = Math.trunc(c.volume * value / 127) / 127
  }
  reset(): void {
    this.resetSequence(false)
  }
  private resetSequence(keepParameters: boolean): void {
    this.channels = this.channels.map((previous) => channel(this.bufferVolume, keepParameters ? previous : undefined))
    this.notes = []
    this.exclusive = undefined
    this.cursor = 0
    this.time = 0
  }
  seek(time: number): void {
    this.position(time, false)
  }
  /** MIDIImpl StopPlay/StartPlay rewinds tracks, silences notes and resets
   * controllers, but sends no ProgramChange. An instrument selected later in
   * the same song therefore remains selected on its next loop or replay;
   * the old GS device also retains pan and its registered tuning parameters. */
  rewind(time: number): void {
    this.position(time, true)
  }
  private position(time: number, keepParameters: boolean): void {
    this.resetSequence(keepParameters)
    if (time === 0) return
    // Integrate each channel's bend intervals; fine/coarse tuning belongs to
    // each note's note-on snapshot. Work is linear in score events
    // plus 16 channels and the bounded live-note set, not all past notes.
    // As before, historical modulation-wheel vibrato is not reconstructed.
    const phases = new Float64Array(16), times = new Float64Array(16),
      settle = (id: number, at: number) => {
        const state = this.channels[id]!
        phases[id] = phases[id]! + (at - times[id]!) * 440 * 2 ** (state.pitch.bendOffset(state.bend) / 12)
        times[id] = at
      }
    if (this.asset)
      while (
        this.cursor < this.asset.events.length &&
        (this.asset.events[this.cursor]!.outputTime ?? this.asset.events[this.cursor]!.time) < time
      ) {
        const event = this.asset.events[this.cursor++]!
        this.time = event.outputTime ?? event.time
        if (event.status === 0xf0 || event.status === 0xf7)
          for (let id = 0; id < 16; id++) settle(id, this.time)
        else if (event.status < 0xf0) settle(event.status & 15, this.time)
        this.applyMessage(event, true, phases)
      }
    this.time = time
    for (let id = 0; id < 16; id++) settle(id, time)
    for (const note of this.notes) {
      const phase = note.phase + phases[note.channel]! * 2 ** ((note.key - 69 + note.tuning) / 12)
      note.phase = ((phase % 1) + 1) % 1
    }
  }
  message(event: Pick<MidiEvent, 'status' | 'data'>): void {
    this.applyMessage(event, true)
  }
  /** Raw output goes straight to the module; it must neither scale its CC7
   * again nor overwrite the owning SMF track's remembered channel volume. */
  rawMessage(event: Pick<MidiEvent, 'status' | 'data'>): void {
    this.applyMessage(event, false)
  }
  private applyMessage(event: Pick<MidiEvent, 'status' | 'data'>, fromFile: boolean, phaseOrigins?: Float64Array): void {
    const { status, data } = event,
      id = status & 15,
      kind = status & 0xf0,
      a = data[0] ?? 0,
      b = data[1] ?? 0,
      c = this.channels[id]!
    if (status === 0xf0 || status === 0xf7) {
      if (status === 0xf0) this.exclusive = []
      for (const value of data) {
        if (value === 0xf0) this.exclusive = []
        else if (value === 0xf7) {
          if (this.exclusive && resetsModule(this.exclusive)) {
            this.channels = this.channels.map((previous) => {
              const next = channel(fromFile ? this.bufferVolume : 127)
              if (!fromFile) next.volume = previous.volume
              next.used = fromFile || previous.used
              return next
            })
            this.notes = []
          }
          this.exclusive = undefined
        } else if (value < 0x80 && this.exclusive && this.exclusive.length < 10) {
          // Keep one byte beyond the longest exact match. Arbitrary bulk
          // dumps can span F7 events without growing retained synth state.
          this.exclusive.push(value)
        } else if (value >= 0x80 && value < 0xf8) this.exclusive = undefined
      }
      return
    }
    if (status < 0xf8) this.exclusive = undefined
    if (kind === 0x90 && fromFile) {
      // MIDIImpl sends this before the first note-on, including velocity zero.
      // A raw controller sent before a track's delayed first note cannot
      // replace the owner's initial remembered CC7 at this boundary.
      if (!c.used) c.level = Math.trunc(c.volume * this.bufferVolume / 127) / 127
      c.used = true
    }
    if (kind === 0x90 && b) {
      if (this.notes.length >= 128) this.notes.shift()
      const tuning = c.pitch.tuning()
      this.notes.push({
        channel: id,
        key: a,
        velocity: b / 127,
        born: this.time,
        held: true,
        phase: phaseOrigins ? -phaseOrigins[id]! * 2 ** ((a - 69 + tuning) / 12) : 0,
        family: c.program >> 3,
        tuning,
      })
    } else if (kind === 0x80 || kind === 0x90) {
      const note = this.notes.find((note) => note.channel === id && note.key === a && note.held)
      if (note) {
        note.held = false
        if (!c.sustain) note.released = this.time
      }
    } else if (kind === 0xc0) c.program = a
    else if (kind === 0xe0) c.bend = (a + (b << 7) - 8192) / 8192
    else if (kind === 0xb0) {
      if (a === 7) {
        if (fromFile) { c.volume = b; c.used = true }
        c.level = (fromFile ? Math.trunc(b * this.bufferVolume / 127) : b) / 127
      } else if (a === 11) c.expression = b / 127
      else if (a === 10) c.pan = (b - 64) / 64
      else if (a === 1) c.modulation = b / 127
      else if (a === 64) {
        c.sustain = b >= 64
        if (!c.sustain)
          for (const note of this.notes)
            if (note.channel === id && !note.held && note.released === undefined)
              note.released = this.time
      } else if (a === 6 || a === 38 || (a >= 98 && a <= 101)) c.pitch.control(a, b)
      else if (a === 120) this.notes = this.notes.filter((note) => note.channel !== id)
      else if (a === 123) {
        for (const note of this.notes)
          if (note.channel === id) {
            note.held = false
            if (!c.sustain) note.released = this.time
          }
      } else if (a === 121) {
        // Older Windows GS preserves CC7/pan for CC121=0; nonzero also
        // resets them. KRKR2's SMF ProcessEvent separately sends CC7=100
        // scaled by BufferVolume after either value, unlike raw midiOut.
        // https://microsoft.github.io/MIDI/kb/in-box-general-midi-synth/#compatible-mode
        const reset = channel(fromFile ? this.bufferVolume : 127, c)
        reset.pan = b === 0 ? c.pan : 0
        if (!fromFile) {
          reset.volume = c.volume // remembered SMF volume is not a device CC
          if (b === 0) reset.level = c.level
        }
        reset.used = fromFile || c.used
        this.channels[id] = reset
        for (const note of this.notes)
          if (note.channel === id && !note.held) note.released = this.time
      }
    }
  }
  /** Consume due messages without generating a sample. MIDIImpl processes
   * every event at the final tick before noticing EOT and rewinding/stopping. */
  advanceEvents(time: number): void {
    this.time = time
    if (this.asset)
      while (this.cursor < this.asset.events.length &&
          (this.asset.events[this.cursor]!.outputTime ?? this.asset.events[this.cursor]!.time) <= time)
        this.message(this.asset.events[this.cursor++]!)
  }
  render(time: number, step: number): void {
    if (time + 1e-8 < this.time) this.seek(time)
    this.advanceEvents(time)
    this.left = this.right = 0
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const note = this.notes[i]!,
        c = this.channels[note.channel]!,
        age = time - note.born,
        family = note.family
      const release =
        note.released === undefined
          ? 1
          : Math.exp(-(time - note.released) / (family === 5 || family === 11 ? 0.25 : 0.09))
      if (release < 0.001 || (age > 30 && !note.held)) {
        this.notes.splice(i, 1)
        continue
      }
      const attack = family === 5 || family === 11 ? 0.08 : 0.005
      let envelope = Math.min(1, age / attack) * release
      if ([0, 1, 3, 4, 12, 13, 14].includes(family))
        envelope *= Math.exp(-age / (family === 1 ? 0.65 : family === 4 ? 1.8 : 2.5))
      let wave: number
      if (note.channel === 9) {
        this.noise ^= this.noise << 13
        this.noise ^= this.noise >>> 17
        this.noise ^= this.noise << 5
        const noise = this.noise / 2147483648
        wave =
          note.key === 35 || note.key === 36
            ? Math.sin(tau * (45 * age + 8 * (1 - Math.exp(-age * 30))))
            : note.key === 38 || note.key === 40
              ? noise * 0.7 + Math.sin(tau * 180 * age) * 0.3
              : noise
        envelope = Math.exp(-age * (note.key < 40 ? 14 : 35))
        if (envelope < 0.001) {
          this.notes.splice(i, 1)
          continue
        }
      } else {
        const frequency =
          440 *
          2 **
            ((note.key -
              69 +
              note.tuning + c.pitch.bendOffset(c.bend) +
              Math.sin(time * tau * 5) * c.modulation * 0.3) /
              12)
        note.phase = (note.phase + frequency * step) % 1
        const phase = note.phase * tau,
          base = Math.sin(phase)
        if (family === 0 || family === 3 || family === 4)
          wave = base + 0.3 * Math.sin(phase * 2) * Math.exp(-age * 3) + 0.15 * Math.sin(phase * 3)
        else if (family === 1 || family === 14)
          wave = base + 0.5 * Math.sin(phase * 2.76) * Math.exp(-age * 4)
        else if (family === 2 || family === 8 || family === 10)
          wave = base + 0.33 * Math.sin(phase * 3) + 0.2 * Math.sin(phase * 5)
        else if (family === 5 || family === 6 || family === 7 || family === 11)
          wave =
            base +
            0.3 * Math.sin(phase * 2) +
            0.15 * Math.sin(phase * 3) +
            0.08 * Math.sin(phase * 4)
        else if (family === 12 || family === 15)
          wave = Math.sin(phase + Math.sin(phase * 2) * 2 * Math.exp(-age))
        else wave = base + 0.1 * Math.sin(phase * 3)
      }
      // Original SMF playback rewrites CC7 as integer channelVolume *
      // BufferVolume / 127, including first notes and controller/module resets.
      // The independent raw midiOut synth keeps BufferVolume=127.
      const value = wave * envelope * note.velocity * c.level * c.expression * 0.15
      this.left += value * (c.pan > 0 ? 1 - c.pan : 1)
      this.right += value * (c.pan < 0 ? 1 + c.pan : 1)
    }
  }
}
