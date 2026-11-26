// MIDIImpl.cpp ProcessEvent forwards every F0/F7, but only these complete F0
// prefixes reset the owner's CC7 values and introduce its 50 ms resend wait.
// A device may recognize additional reset addresses or a split F7 completion;
// that does not make it a sequencer-generated volume resend.
const resetPrefixes = [
  [0x41, 0x10, 0x42, 0x12, 0x40, 0, 0x7f, 0, 0x41, 0xf7],
  [0x41, 0x10, 0x42, 0x12, 0, 0, 0x7f],
  [0x7e, 0x7f, 9, 1, 0xf7],
  [0x43, 0x10, 0x4c, 0, 0, 0x7e, 0, 0xf7],
] as const
export const resetsNativeSmfModule = (event: { status: number; data: readonly number[] }): boolean =>
  event.status === 0xf0 && resetPrefixes.some((prefix) =>
    prefix.length <= event.data.length && prefix.every((value, index) => event.data[index] === value))
