/** MIDIImpl's two public volume controls first combine in the 100000 scale,
 * then become one 7-bit module-volume control. Channel CC7 is scaled by that
 * integer separately; it is not a continuous gain on the final stereo PCM. */
export function midiBufferVolume(volume: number, volume2: number): number {
  const combined = Math.trunc(Math.trunc(volume / 10) * Math.trunc(volume2 / 10) / 1000)
  return Math.max(0, Math.min(127, Math.trunc(combined * 127 / 100000)))
}
