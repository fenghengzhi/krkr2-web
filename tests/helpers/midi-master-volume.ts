import { midi } from './audio.ts'

// Authored SMF, 100 PPQ and 500000 us/quarter: one tick = 5 ms.
// Master Volume's byte order is ll, mm; device id is deliberately varied.
// Microsoft MIDI 4db4520 UmpDispatcher.cpp1534, SynthEngine.cpp1751 and
// DlsUnits.h: gain in dB = 40 log10(value / 16383). Our Web bank uses exact
// zero for silence; these references do not assert a physical GS noise floor.
export const masterPacket = (value: number, device = 0x7f) =>
  [0x7f, device, 4, 1, value & 127, value >> 7, 0xf7]
const start = [0, 0xc0, 80, 0, 0xb0, 7, 100, 0, 0x90, 69, 100]
export function masterScore(split = false, device = 0x7f): Uint8Array {
  const half = masterPacket(8192, device), zero = masterPacket(0, device), fine = masterPacket(8193, device), full = masterPacket(16383, device)
  return midi([[...start,
    ...(split ? [20, 0xf0, 3, ...half.slice(0, 3), 10, 0xf7, 4, ...half.slice(3)] : [20, 0xf0, 7, ...half]),
    split ? 10 : 20, 0xf0, 7, ...zero,
    20, 0xf0, 7, ...fine, 20, 0xf0, 7, ...full,
    20, 0x80, 69, 0, 0, 0xff, 0x2f, 0,
  ]], 100)
}
export const masterPlain = (ticks = 100) => midi([[...start, ticks, 0x80, 69, 0, 0, 0xff, 0x2f, 0]], 100)
export const masterTail = () => midi([[...start, 100, 0xf0, 7, ...masterPacket(0),
  0, 0x80, 69, 0, 0, 0xff, 0x2f, 0]], 100)
export const midiMasterFiles = () => ({
  'master-score.mid': masterScore(), 'master-split.mid': masterScore(true, 0x10),
  'master-plain.mid': masterPlain(), 'master-tail.mid': masterTail(),
  'master-long.mid': midi([[...start, 0x87, 0xa9, 0x40, 0x80, 69, 0, 0, 0xff, 0x2f, 0]], 100),
})
export const midiMasterSource = String.raw`
System.exitOnNoWindowStartup=false;
var masterMusic=new MIDISoundBuffer(null),masterStep=0;
function masterStart(name,loop=false){masterMusic.open(name);masterMusic.looping=loop;masterMusic.play();return masterMusic.status;}
function masterQuiet(){MIDISoundBuffer.midiOut(<%f0 7f 10 04 01 00 40 f7%>);}
function masterMute(){MIDISoundBuffer.midiOut(<%f0 7f 00 04 01 00 00 f7%>);}
function masterFine(){MIDISoundBuffer.midiOut(<%f0 7f 7f 04 01 01 40 f7%>);}
function masterRestore(){MIDISoundBuffer.midiOut(<%f0 7f 7f 04 01 7f 7f f7%>);}
function masterNext(){
 masterStep++;
 if(masterStep==1)masterQuiet();
 else if(masterStep==2)masterMute();
 else if(masterStep==3)masterFine();
 else if(masterStep==4){MIDISoundBuffer.midiOut(<%b0 79 00%>);masterMusic.volume=50000;}
 else if(masterStep==5){masterMusic.stop();masterMusic.play();}
 else if(masterStep==6){masterMusic.stop();MIDISoundBuffer.midiOut(<%f0 7e 7f 09 01 f7%>);masterMusic.play();}
 else if(masterStep==7){masterQuiet();masterStart("master-long.mid");}
 Debug.message("master-stage:"+masterStep+":"+masterMusic.status);
}
function masterMenu(){
 global.masterWindow=new Window();masterWindow.caption="MIDI music fade";masterWindow.setInnerSize(160,60);
 var root=new Layer(masterWindow,null);masterWindow.add(root);root.setSize(160,60);root.holdAlpha=false;root.fillRect(0,0,160,60,0xff183048);
 var next=new Layer(masterWindow,root);masterWindow.add(next);next.setPos(0,0,160,60);next.holdAlpha=false;next.fillRect(0,0,160,60,0xff408060);next.visible=true;
 next.onClick=function(){global.masterNext();};
 masterWindow.onKeyDown=function(key,shift){if(key==27){global.masterMusic.stop();global.Debug.message("master-stopped");}};
 masterStart("master-long.mid");masterWindow.visible=true;Debug.message("master-stage:0:play");
}
Debug.message("master-source-ready");
`
