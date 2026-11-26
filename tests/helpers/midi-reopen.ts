import { midi } from './audio.ts'

export const midiReopenFile = (key: number) => midi([[
  0, 0xc0, 48, 0, 0xb0, 7, 100, 0, 0x90, key, 100,
  0xa3, 0x94, 0, 0x80, key, 0, 0, 0xff, 0x2f, 0,
]], 480)
export const midiReopenFiles = () => ({
  'midi-old.mid': midiReopenFile(69), 'midi-next.mid': midiReopenFile(81),
  'midi-bad.mid': new Uint8Array([78, 79, 80, 69]),
  // Native SMF loading never invokes the Wave SLI parser.
  'midi-next.mid.sli': new TextEncoder().encode('#2.00\nLink {From=0;To=0;Smooth=invalid;}'),
})
export const midiReopenExpected: Readonly<Record<string, string>> = {
  cold: '0|stop|80000||stop|20000|20000',
  replace: '0|stop|80000|||20000|20000',
  missing: '1|stop|80000|||20000|20000',
  bad: '1|unload|80000||unload|20000|20000',
}
export const midiReopenSource = String.raw`
System.exitOnNoWindowStartup=false;
class ReopenMidi extends MIDISoundBuffer {
 var completed=[],states=[];
 function ReopenMidi(){super.MIDISoundBuffer(null);}
 function onStatusChanged(value){states.add(value);}
 function onFadeCompleted(){completed.add(volume);}
}
function midiReopenObserve(kind){
 var w=new ReopenMidi(),result,primary,failed=false,cleanup;
 try{
  if(kind!="cold")w.open("midi-old.mid");
  w.states.clear();w.volume=80000;w.fade(20000,1000000000);
  var rejected=false;
  try{w.open(kind=="missing"?"midi-missing.mid":kind=="bad"?"midi-bad.mid":"midi-next.mid");}
  catch(e){rejected=true;if(kind!="missing" && kind!="bad")throw e;}
  result=[int(rejected),w.status,w.volume,w.completed.join(","),w.states.join(",")].join("|");
  w.stopFade();result+="|"+w.volume+"|"+w.completed.join(",");
 }catch(e){primary=e;failed=true;}
 try{invalidate w;}catch(e){cleanup=e;}
 if(failed){if(cleanup!==void)Debug.message("midi-reopen-cleanup:"+cleanup.message);throw primary;}
 if(cleanup!==void)throw cleanup;return result;
}
var reopenMusic;
function midiReopenStart(){
 if(reopenMusic!==void && isvalid reopenMusic)invalidate reopenMusic;
 reopenMusic=new ReopenMidi();reopenMusic.open("midi-old.mid");reopenMusic.play();
 return reopenMusic.status;
}
function midiReopenAttempt(name){try{reopenMusic.open(name);return "opened:"+reopenMusic.status;}catch(e){return "rejected:"+reopenMusic.status;}}
function midiReopenMenu(){
 global.midiReopenWindow=new Window();midiReopenWindow.caption="MIDI song replacement";midiReopenWindow.setInnerSize(320,60);
 var root=new Layer(midiReopenWindow,null);midiReopenWindow.add(root);root.setSize(320,60);root.holdAlpha=false;root.fillRect(0,0,320,60,0xff102030);
 var missing=new Layer(midiReopenWindow,root),next=new Layer(midiReopenWindow,root),bad=new Layer(midiReopenWindow,root),recover=new Layer(midiReopenWindow,root);
 midiReopenWindow.add(missing);midiReopenWindow.add(next);midiReopenWindow.add(bad);midiReopenWindow.add(recover);
 var buttons=[missing,next,bad,recover];
 for(var i=0;i<buttons.count;i++){var b=buttons[i];b.setPos(i*80,0,76,60);b.holdAlpha=false;b.fillRect(0,0,76,60,0xff206040+i*0x101010);b.visible=true;}
 missing.onClick=function(){global.Debug.message("midi-missing:"+global.midiReopenAttempt("midi-missing.mid"));};
 next.onClick=function(){var state=global.midiReopenAttempt("midi-next.mid");global.reopenMusic.play();global.Debug.message("midi-next:"+state);};
 bad.onClick=function(){global.Debug.message("midi-bad:"+global.midiReopenAttempt("midi-bad.mid"));};
 recover.onClick=function(){global.reopenMusic.open("midi-old.mid");global.reopenMusic.play();global.Debug.message("midi-recovered:"+global.reopenMusic.status);};
 midiReopenStart();reopenMusic.volume=80000;reopenMusic.fade(20000,1000000000);
 midiReopenWindow.visible=true;Debug.message("midi-reopen-buttons-ready");
}
Debug.message("midi-reopen-source-ready");
`
