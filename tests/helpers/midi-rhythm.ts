import { midi } from './audio.ts'

// Independent authored GS wire addresses. Microsoft MIDI 4db4520,
// UmpDispatcher::GsPartToChannel / DispatchSysEx, SynthEngine::SetDrumChannel:
// part 0 -> channel 10, 1..9 -> channels 1..9, 10..15 -> channels 11..16.
// The selected compatible device ignores dd; routing starts after GS Reset.
// KRKR MIDIImpl.cpp516-566 forwards F0/F7 rather than interpreting this address.
export const gsResetPacket = (device = 0x10) => [0x41, device, 0x42, 0x12, 0x40, 0, 0x7f, 0, 0x41, 0xf7]
export function gsPartPacket(part: number, value: number, device = 0x10): number[] {
  const address = 0x10 + part
  return [0x41, device, 0x42, 0x12, 0x40, address, 0x15, value,
    (128 - ((0x40 + address + 0x15 + value) & 127)) & 127, 0xf7]
}
/** 100 PPQ: 5 ms/tick. Note 36 starts at .1 s, ends at .9 s; EOT = 1 s.
 * The two reference songs have no GS messages, only ordinary GM channels. */
export function rhythmScore(options: { channel: number; part?: number; value?: number; device?: number; split?: boolean; reset?: boolean }): Uint8Array {
  const { channel, part, value = 1, device = 0x10, split = false, reset = true } = options, track: number[] = []
  if (part !== undefined) {
    const packet = gsPartPacket(part, value, device)
    if (reset) { const bytes = gsResetPacket(device); track.push(0, 0xf0, bytes.length, ...bytes) }
    if (split) track.push(0, 0xf0, 5, ...packet.slice(0, 5), 0, 0xf7, packet.length - 5, ...packet.slice(5))
    else track.push(0, 0xf0, packet.length, ...packet)
  }
  track.push(20, 0xc0 + channel, 80, 0, 0x90 + channel, 36, 100,
    0x81, 0x20, 0x80 + channel, 36, 0, 20, 0xff, 0x2f, 0)
  return midi([track], 100)
}
export const midiRhythmFiles = () => ({
  'rhythm-reference.mid': rhythmScore({ channel: 9 }),
  'rhythm-gs.mid': rhythmScore({ channel: 0, part: 1, split: true }),
  'rhythm-melodic.mid': rhythmScore({ channel: 9, part: 0, value: 0, device: 0x7f }),
  'melodic-reference.mid': rhythmScore({ channel: 0 }),
})
export const midiRhythmSource = String.raw`
System.exitOnNoWindowStartup=false;
var rhythmMusic=new MIDISoundBuffer(null),rhythmSerial=0;
function rhythmStart(index){
 var names=["rhythm-reference.mid","rhythm-gs.mid","rhythm-melodic.mid","melodic-reference.mid"];
 rhythmMusic.open(names[index]);rhythmMusic.looping=true;rhythmMusic.play();
 rhythmSerial++;Debug.message("rhythm-selected:"+rhythmSerial+":"+index+":"+rhythmMusic.status);
 return rhythmMusic.status;
}
function rhythmMenu(){
 global.rhythmWindow=new Window();rhythmWindow.caption="GS rhythm parts";rhythmWindow.setInnerSize(320,60);
 var root=new Layer(rhythmWindow,null);rhythmWindow.add(root);root.setSize(320,60);root.holdAlpha=false;root.fillRect(0,0,320,60,0xff183048);
 var gm=new Layer(rhythmWindow,root),gs=new Layer(rhythmWindow,root),melodic=new Layer(rhythmWindow,root),reference=new Layer(rhythmWindow,root);
 var buttons=[gm,gs,melodic,reference];
 for(var i=0;i<4;i++){var b=buttons[i];rhythmWindow.add(b);b.setPos(i*80,0,76,60);b.holdAlpha=false;b.fillRect(0,0,76,60,0xff306040+i*0x101010);b.visible=true;}
 gm.onClick=function(){global.rhythmStart(0);};gs.onClick=function(){global.rhythmStart(1);};
 melodic.onClick=function(){global.rhythmStart(2);};reference.onClick=function(){global.rhythmStart(3);};
 rhythmWindow.onKeyDown=function(key,shift){if(key==27){global.rhythmMusic.stop();global.Debug.message("rhythm-stopped");}};
 rhythmWindow.visible=true;Debug.message("rhythm-menu-ready");
}
Debug.message("rhythm-source-ready");
`
