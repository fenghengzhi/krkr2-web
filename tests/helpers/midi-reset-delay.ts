import { midi } from './audio.ts'

export const midiResetPackets = {
  gm: [0x7e, 0x7f, 9, 1, 0xf7],
  gs: [0x41, 0x10, 0x42, 0x12, 0x40, 0, 0x7f, 0, 0x41, 0xf7],
  mode: [0x41, 0x10, 0x42, 0x12, 0, 0, 0x7f, 0, 1, 0xf7],
  xg: [0x43, 0x10, 0x4c, 0, 0, 0x7e, 0, 0xf7],
} as const
/** 100 ticks/quarter and 500 ms/quarter: one tick is exactly 5 ms. */
export function midiResetDelayFile(kind: keyof typeof midiResetPackets = 'gm', repeats = 1, noteTick = 0): Uint8Array {
  const packet = midiResetPackets[kind], track: number[] = []
  for (let count = 0; count < repeats; count++) track.push(0, 0xf0, packet.length, ...packet)
  track.push(noteTick, 0xc0, 48, 0, 0xb0, 7, 100, 0, 0x90, 69, 100,
    40 - noteTick, 0x80, 69, 0, 0, 0xff, 0x2f, 0)
  return midi([track], 100)
}
/** Independent score-authored first-note delays; no reset or production timing helper. */
export const midiResetReferenceFile = (noteTick: number) => midi([[
  noteTick, 0xc0, 48, 0, 0xb0, 7, 100, 0, 0x90, 69, 100,
  40 - noteTick, 0x80, 69, 0, 0, 0xff, 0x2f, 0,
]], 100)
export const midiResetDelayFiles = () => ({
  'reset-one.mid': midiResetDelayFile(), 'reset-two.mid': midiResetDelayFile('gm', 2),
  'reference-one.mid': midiResetReferenceFile(10), 'reference-two.mid': midiResetReferenceFile(20),
})
export const midiResetDelaySource = String.raw`
System.exitOnNoWindowStartup=false;
var resetMusic=new MIDISoundBuffer(null),resetStage=0;
function resetPlay(name){resetMusic.open(name);resetMusic.looping=true;resetMusic.play();return resetMusic.status;}
function resetMenu(){
 global.resetWindow=new Window();resetWindow.caption="MIDI module initialization";resetWindow.setInnerSize(240,60);
 var root=new Layer(resetWindow,null);resetWindow.add(root);root.setSize(240,60);root.holdAlpha=false;root.fillRect(0,0,240,60,0xff102030);
 var next=new Layer(resetWindow,root),stop=new Layer(resetWindow,root),again=new Layer(resetWindow,root);
 resetWindow.add(next);resetWindow.add(stop);resetWindow.add(again);
 var buttons=[next,stop,again];for(var i=0;i<3;i++){var b=buttons[i];b.setPos(i*80,0,76,60);b.holdAlpha=false;b.fillRect(0,0,76,60,0xff206040+i*0x101010);b.visible=true;}
 next.onClick=function(){global.resetStage++;global.resetPlay(global.resetStage%2?"reset-two.mid":"reset-one.mid");global.Debug.message("reset-selected:"+global.resetStage);};
 stop.onClick=function(){global.resetMusic.stop();global.Debug.message("reset-stopped");};
 again.onClick=function(){global.resetMusic.play();global.Debug.message("reset-restarted");};
 resetPlay("reset-one.mid");resetWindow.visible=true;Debug.message("reset-menu-ready");
}
Debug.message("reset-source-ready");
`
