import { midi } from './audio.ts'

/** Authored MIDI bytes and independently transposed/reference-pitch scores.
 * Older GS melodic controls: coarse 64 / fine 8192 are neutral, the wheel
 * defaults to two semitones, cents are ignored and fine MSB retains its LSB.
 * https://microsoft.github.io/MIDI/kb/in-box-general-midi-synth/#compatible-mode */
export const midiPitchCases = [
  { name: 'default', messages: [], key: 69, bend: 8192 },
  { name: 'default-bend', messages: [[0xe0, 0, 0]], key: 67, bend: 8192 },
  { name: 'octave', messages: [[0xb0, 101, 0], [0xb0, 100, 2], [0xb0, 6, 76],
    [0xb0, 101, 127], [0xb0, 100, 127], [0xb0, 6, 52]], key: 81, bend: 8192 },
  { name: 'lower', messages: [[0xb0, 101, 0], [0xb0, 100, 2], [0xb0, 6, 52], [0xb0, 38, 127]], key: 57, bend: 8192 },
  { name: 'fine-half', messages: [[0xb0, 101, 0], [0xb0, 100, 1], [0xb0, 6, 96], [0xb0, 38, 0]], key: 69, bend: 10240 },
  { name: 'fine-bit', messages: [[0xb0, 101, 0], [0xb0, 100, 1], [0xb0, 6, 64], [0xb0, 38, 64]], key: 69, bend: 8224 },
  { name: 'fine-down', messages: [[0xb0, 101, 0], [0xb0, 100, 1], [0xb0, 6, 0], [0xb0, 38, 0]], key: 68, bend: 8192 },
  { name: 'cents-ignored', messages: [[0xb0, 101, 0], [0xb0, 100, 0], [0xb0, 6, 0], [0xb0, 38, 50], [0xe0, 0, 0]], key: 69, bend: 8192 },
  { name: 'combined', messages: [[0xb0, 101, 0], [0xb0, 100, 2], [0xb0, 6, 76],
    [0xb0, 101, 0], [0xb0, 100, 1], [0xb0, 6, 0], [0xb0, 38, 0],
    [0xb0, 101, 0], [0xb0, 100, 0], [0xb0, 6, 2], [0xb0, 38, 25], [0xe0, 0, 0]], key: 78, bend: 8192 },
  { name: 'nrpn', messages: [[0xb0, 101, 0], [0xb0, 100, 0], [0xb0, 6, 12],
    [0xb0, 99, 0], [0xb0, 98, 1], [0xb0, 6, 2], [0xb0, 38, 50], [0xe0, 0, 0]], key: 57, bend: 8192 },
  { name: 'msb-keeps-fine', messages: [[0xb0, 101, 0], [0xb0, 100, 1],
    [0xb0, 6, 64], [0xb0, 38, 64], [0xb0, 6, 64]], key: 69, bend: 8224 },
  { name: 'selector-back', messages: [[0xb0, 101, 0], [0xb0, 100, 1], [0xb0, 6, 96],
    [0xb0, 101, 0], [0xb0, 100, 0], [0xb0, 6, 12], [0xe0, 0, 0]], key: 57, bend: 10240 },
  { name: 'controller-reset', messages: [[0xb0, 101, 0], [0xb0, 100, 2], [0xb0, 6, 76],
    [0xb0, 101, 0], [0xb0, 100, 1], [0xb0, 6, 0], [0xb0, 38, 0],
    [0xb0, 101, 0], [0xb0, 100, 0], [0xb0, 6, 12], [0xe0, 0, 0],
    [0xb0, 121, 0], [0xb0, 6, 0], [0xb0, 38, 0], [0xe0, 0, 0]], key: 80, bend: 8192 },
  { name: 'reset-keeps-fine-selector', messages: [[0xb0, 101, 0], [0xb0, 100, 1],
    [0xb0, 6, 64], [0xb0, 38, 64], [0xb0, 121, 0], [0xb0, 6, 96]], key: 69, bend: 10272 },
] as const

export function midiPitchFile(messages: readonly (readonly number[])[], key = 69, channel = 0): Uint8Array {
  return midi([[
    ...messages.flatMap((message) => [0, message[0]! + channel, ...message.slice(1)]),
    0, 0xc0 + channel, 48, 0, 0x90 + channel, key, 100,
    40, 0x80 + channel, key, 0, 0, 0xff, 0x2f, 0,
  ]], 100)
}
export function midiPitchReference(key: number, bend = 8192, channel = 0): Uint8Array {
  return midiPitchFile([[0xe0, bend & 127, bend >> 7]], key, channel)
}
export const midiPitchLong = (key = 69) => midi([[
  0, 0xc0, 48, 0, 0x90, key, 100, 0xa3, 0x94, 0, 0x80, key, 0, 0, 0xff, 0x2f, 0,
]], 480)
export const midiPitchLate = () => midi([[
  0, 0xc0, 48, 0, 0x90, 69, 100,
  21, 0xb0, 101, 0, 0, 0xb0, 100, 2, 0, 0xb0, 6, 76,
  19, 0x80, 69, 0, 0, 0xff, 0x2f, 0,
]], 100)
export function midiPitchFiles(): Record<string, Uint8Array> {
  return { 'pitch-base.mid': midiPitchLong(), 'pitch-late.mid': midiPitchLate(),
    ...Object.fromEntries(midiPitchCases.map((entry) => [`pitch-${entry.name}.mid`, midiPitchFile(entry.messages)])) }
}
export const midiPitchSource = String.raw`
System.exitOnNoWindowStartup=false;
var pitchMusic=new MIDISoundBuffer(null);
function pitchStart(name){pitchMusic.open(name);pitchMusic.play();return pitchMusic.status;}
function pitchUp(){MIDISoundBuffer.midiOut(<% b0 65 00 b0 64 02 b0 06 4c b0 65 7f b0 64 7f %>);}
function pitchDown(){MIDISoundBuffer.midiOut(<% b0 65 00 b0 64 02 b0 06 34 b0 65 7f b0 64 7f %>);}
function pitchFine(){MIDISoundBuffer.midiOut(<% b0 65 00 b0 64 02 b0 06 40 b0 65 00 b0 64 01 b0 06 00 b0 26 00 b0 65 7f b0 64 7f %>);}
function pitchControllers(){MIDISoundBuffer.midiOut(<% b0 79 00 %>);}
function pitchBend(){MIDISoundBuffer.midiOut(<% b0 65 00 b0 64 00 b0 06 0c e0 00 00 %>);}
function pitchReplay(){pitchMusic.stop();pitchMusic.play();}
function pitchModule(){MIDISoundBuffer.midiOut(<% f0 7e 7f 09 01 f7 %>);pitchMusic.stop();pitchMusic.play();}
var pitchStep=0;
function pitchNext(){
 if(pitchStep==0)pitchUp();
 else if(pitchStep==1)pitchReplay();
 else if(pitchStep==2)pitchBend();
 else if(pitchStep==3)pitchControllers();
 else if(pitchStep==4){pitchDown();pitchReplay();}
 else if(pitchStep==5){pitchFine();pitchReplay();}
 else if(pitchStep==6)pitchModule();
 else throw new Exception("Pitch route exceeded its bound");
 pitchStep++;Debug.message("pitch-step:"+pitchStep+":"+pitchMusic.status);
}
function pitchMenu(){
 pitchStep=0;
 global.pitchWindow=new Window();pitchWindow.caption="MIDI musical tuning";pitchWindow.setInnerSize(160,60);
 pitchWindow.onKeyDown=function(key,shift){if(key==27){global.pitchMusic.stop();global.Debug.message("pitch-stopped");}};
 var root=new Layer(pitchWindow,null);pitchWindow.add(root);root.setSize(160,60);root.holdAlpha=false;root.fillRect(0,0,160,60,0xff102030);
 var next=new Layer(pitchWindow,root);pitchWindow.add(next);next.setPos(0,0,156,60);next.holdAlpha=false;next.fillRect(0,0,156,60,0xff206040);next.visible=true;
 next.onClick=function(){global.pitchNext();};
 pitchStart("pitch-base.mid");pitchWindow.visible=true;Debug.message("pitch-menu-ready");
}
Debug.message("pitch-source-ready");
`
