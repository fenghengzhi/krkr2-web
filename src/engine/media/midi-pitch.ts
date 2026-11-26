/** RPN 0/1/2 for older Windows GS melodic behavior. KRKR2 sends these
 * messages through MIDI_MAPPER; the configured device is not fixed.
 * Microsoft's documented Compatible mode retains fine-tuning LSB on MSB
 * writes, ignores bend cents and preserves RPN selection across CC121:
 * https://microsoft.github.io/MIDI/kb/in-box-general-midi-synth/#compatible-mode
 * This does not reproduce its instrument bank, percussion or bend glide. */
export class MidiPitch {
  private parameter = 0x3fff
  private registered = true
  private bendSemitones = 2
  private fine = 8192
  private coarse = 64
  constructor(previous?: MidiPitch) {
    // MIDIImpl replay sends CC121, not a module reset. The older GS device
    // preserves tuning parameters and their current selection at this point.
    if (previous) {
      this.parameter = previous.parameter
      this.registered = previous.registered
      this.bendSemitones = previous.bendSemitones
      this.fine = previous.fine
      this.coarse = previous.coarse
    }
  }
  control(controller: number, value: number): void {
    // Invalid raw data bytes are still transported by midiOut's native
    // parser; they do not define a valid parameter update in this renderer.
    if (!Number.isInteger(value) || value < 0 || value > 127) return
    if (controller === 101) {
      this.registered = true
      this.parameter = (this.parameter & 127) | (value << 7)
    } else if (controller === 100) {
      this.registered = true
      this.parameter = (this.parameter & 0x3f80) | value
    } else if (controller === 98 || controller === 99) this.registered = false
    else if (this.registered && (controller === 6 || controller === 38)) {
      if (this.parameter === 0) {
        if (controller === 6) this.bendSemitones = value
      } else if (this.parameter === 1) {
        this.fine = controller === 6 ? (value << 7) | (this.fine & 127) : (this.fine & 0x3f80) | value
      } else if (this.parameter === 2 && controller === 6) this.coarse = value
    }
  }
  tuning(): number { return this.coarse - 64 + (this.fine - 8192) / 8192 }
  bendOffset(bend: number): number { return bend * this.bendSemitones }
}
