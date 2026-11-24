import { midi } from './audio.ts'

interface OpenCase { id: string; bytes: Uint8Array; expected: string }
export function midiOpenCases(): OpenCase[] {
  const valid = midi([[0, 0x90, 60, 96, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0]])
  const badFormat = valid.slice(), badTrack = valid.slice()
  new DataView(badFormat.buffer).setUint16(8, 2)
  badTrack.set([74, 85, 78, 75], 14)
  return [
    { id: 'complete', bytes: valid, expected: 'opened' },
    { id: 'short-id', bytes: valid.slice(0, 3), expected: 'read-short' },
    { id: 'wrong-id', bytes: Uint8Array.of(78, 79, 80, 69), expected: 'smf:<MThd not found>' },
    { id: 'short-header', bytes: valid.slice(0, 13), expected: 'read-short' },
    { id: 'wrong-format', bytes: badFormat, expected: 'smf:<Format must be 0 or 1>' },
    { id: 'short-track-id-and-size', bytes: valid.slice(0, 21), expected: 'read-short' },
    { id: 'wrong-track-id', bytes: badTrack, expected: 'smf:<MTrk not found>' },
    { id: 'short-track-body', bytes: valid.slice(0, -1), expected: 'read-short' },
  ]
}

export const midiOpenSource = `
System.assignMessage("TVPInvalidSMF","smf:<%1>");
System.assignMessage("TJSReadError","read-short");
var midiMusic=new MIDISoundBuffer(null);
function openMidiFile(name){try{global.midiMusic.open(name);return "opened";}catch(e){return e.message;}}
`
