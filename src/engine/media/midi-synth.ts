import type { MidiAsset, MidiEvent } from '../ports/audio.ts'
interface Channel {
  volume: number
  expression: number
  pan: number
  program: number
  bend: number
  bendRange: number
  sustain: boolean
  rpn: number
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
}
const channel = (): Channel => ({
  volume: 100 / 127,
  expression: 1,
  pan: 0,
  program: 0,
  bend: 0,
  bendRange: 2,
  sustain: false,
  rpn: 16383,
  modulation: 0,
})
const tau = 2 * Math.PI

/** Browser-resident procedural instrument bank. MIDI sequencing and controller
 * behavior are separate from timbre; a sample-bank backend can replace this. */
export class MidiSynth {
  private channels = Array.from({ length: 16 }, channel)
  private notes: Note[] = []
  private cursor = 0
  private time = 0
  private noise = 0x12345678
  left = 0
  right = 0
  constructor(private readonly asset?: MidiAsset) {}
  reset(): void {
    this.channels = Array.from({ length: 16 }, channel)
    this.notes = []
    this.cursor = 0
    this.time = 0
  }
  seek(time: number): void {
    this.reset()
    if (this.asset)
      while (
        this.cursor < this.asset.events.length &&
        this.asset.events[this.cursor]!.time < time
      ) {
        const event = this.asset.events[this.cursor++]!
        this.time = event.time
        this.message(event)
      }
    this.time = time
    for (const note of this.notes)
      note.phase = ((time - note.born) * 440 * 2 ** ((note.key - 69) / 12)) % 1
  }
  message(event: Pick<MidiEvent, 'status' | 'data'>): void {
    const { status, data } = event,
      id = status & 15,
      kind = status & 0xf0,
      a = data[0] ?? 0,
      b = data[1] ?? 0,
      c = this.channels[id]!
    if (status === 0xf0) {
      if (data[0] === 0x7e && data[2] === 9 && (data[3] === 1 || data[3] === 3)) {
        this.channels = Array.from({ length: 16 }, channel)
        this.notes = []
      }
      return
    }
    if (kind === 0x90 && b) {
      if (this.notes.length >= 128) this.notes.shift()
      this.notes.push({
        channel: id,
        key: a,
        velocity: b / 127,
        born: this.time,
        held: true,
        phase: 0,
        family: c.program >> 3,
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
      if (a === 7) c.volume = b / 127
      else if (a === 11) c.expression = b / 127
      else if (a === 10) c.pan = (b - 64) / 64
      else if (a === 1) c.modulation = b / 127
      else if (a === 64) {
        c.sustain = b >= 64
        if (!c.sustain)
          for (const note of this.notes)
            if (note.channel === id && !note.held && note.released === undefined)
              note.released = this.time
      } else if (a === 100) c.rpn = (c.rpn & 0x3f80) | b
      else if (a === 101) c.rpn = (c.rpn & 127) | (b << 7)
      else if (a === 6 && c.rpn === 0) c.bendRange = b
      else if (a === 120) this.notes = this.notes.filter((note) => note.channel !== id)
      else if (a === 123) {
        for (const note of this.notes)
          if (note.channel === id) {
            note.held = false
            if (!c.sustain) note.released = this.time
          }
      } else if (a === 121) {
        const program = c.program
        this.channels[id] = channel()
        this.channels[id]!.program = program
        for (const note of this.notes)
          if (note.channel === id && !note.held) note.released = this.time
      }
    }
  }
  render(time: number, step: number): void {
    if (time + 1e-8 < this.time) this.seek(time)
    this.time = time
    if (this.asset)
      while (this.cursor < this.asset.events.length && this.asset.events[this.cursor]!.time <= time)
        this.message(this.asset.events[this.cursor++]!)
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
              c.bend * c.bendRange +
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
      const value = wave * envelope * note.velocity * c.volume * c.expression * 0.15
      this.left += value * (c.pan > 0 ? 1 - c.pan : 1)
      this.right += value * (c.pan < 0 ? 1 + c.pan : 1)
    }
  }
}
