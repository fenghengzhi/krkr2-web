import { midi } from './audio.ts'

/** 5 ms/tick. The first note deliberately precedes the only ProgramChange.
 * Original MIDIImpl rewinds the track, not the device's selected instrument. */
export function midiProgramReplayFile(initialProgram?: number, reset = false, programAtEnd = false): Uint8Array {
  return midi([[
    ...(reset ? [0, 0xf0, 5, 0x7e, 0x7f, 9, 1, 0xf7] : []),
    ...(initialProgram === undefined ? [] : [0, 0xc0, initialProgram]),
    0, 0x90, 69, 100,
    programAtEnd ? 40 : 20, 0xc0, 48,
    programAtEnd ? 0 : 20, 0x80, 69, 0, 0, 0xff, 0x2f, 0,
  ]], 100)
}
export const midiProgramReplayFiles = () => ({
  'program-song.mid': midiProgramReplayFile(),
  'program-end.mid': midiProgramReplayFile(undefined, false, true),
  // Independently authored reference: the same note explicitly selects the
  // retained instrument before note-on. No production-state introspection.
  'program-reference.mid': midiProgramReplayFile(48),
  'program-reset.mid': midiProgramReplayFile(undefined, true),
})
export const midiProgramReplaySource = String.raw`
System.exitOnNoWindowStartup=false;
class ReplayMidi extends MIDISoundBuffer {
 var states=[];
 function ReplayMidi(){super.MIDISoundBuffer(null);}
 function onStatusChanged(value){states.add(value);}
}
var programMusic=new ReplayMidi();
function programStart(name,loop){programMusic.open(name);programMusic.looping=loop;programMusic.play();return programMusic.status;}
function programMenu(){
 global.programWindow=new Window();programWindow.caption="MIDI instrument replay";programWindow.setInnerSize(240,60);
 var root=new Layer(programWindow,null);programWindow.add(root);root.setSize(240,60);root.holdAlpha=false;root.fillRect(0,0,240,60,0xff102030);
 var stop=new Layer(programWindow,root),again=new Layer(programWindow,root),reference=new Layer(programWindow,root);
 programWindow.add(stop);programWindow.add(again);programWindow.add(reference);
 var buttons=[stop,again,reference];for(var i=0;i<3;i++){var b=buttons[i];b.setPos(i*80,0,76,60);b.holdAlpha=false;b.fillRect(0,0,76,60,0xff206040+i*0x101010);b.visible=true;}
 stop.onClick=function(){global.programMusic.stop();global.Debug.message("program-stopped");};
 again.onClick=function(){global.programMusic.play();global.Debug.message("program-replayed");};
 reference.onClick=function(){global.programStart("program-reference.mid",true);global.Debug.message("program-reference");};
 programStart("program-end.mid",true);programWindow.visible=true;Debug.message("program-menu-ready");
}
Debug.message("program-source-ready");
`
