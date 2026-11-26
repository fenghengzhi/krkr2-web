import { wave } from './audio.ts'

export const cddaReopenDiscs = [
  { drive: 'D', cue: 'disc-a.cue' }, { drive: 'E', cue: 'disc-b.cue' },
  { drive: 'F', cue: 'disc-bad.cue' },
] as const

/** Author-defined tracks; no decoder/mixer computes the expected samples.
 * CUE timestamps are exact seconds at 75 frames/s. */
export function cddaReopenFiles(tones = false): Record<string, string | Uint8Array> {
  const rate = tones ? 48000 : 1000,
    samples = (hz: number, value: number, seconds = 4) => Array.from({ length: rate * seconds * 2 }, (_, i) => {
      const left = tones ? Math.round(Math.sin(Math.floor(i / 2) * 2 * Math.PI * hz / rate) * 8192) / 32768 : value
      return i % 2 ? tones ? -left : -left / 2 : left
    }),
    second = wave(samples(880, .25), rate, 2)
  return {
    'disc-a.cue': 'FILE "a.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:04:00\n' +
      'FILE "held.wav" WAVE\nTRACK 03 AUDIO\nINDEX 01 00:00:00\nFILE "cancel.wav" WAVE\nTRACK 04 AUDIO\nINDEX 01 00:00:00\n',
    'disc-b.cue': 'FILE "b.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n',
    'disc-bad.cue': 'FILE "bad.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n',
    'a.wav': wave([...samples(440, .5), ...samples(880, .25)], rate, 2),
    'b.wav': wave(samples(660, -.5), rate, 2), 'held.wav': second, 'cancel.wav': second,
    'bad.wav': Uint8Array.of(78, 79, 80, 69),
  }
}

// CDDAImpl::Open preserves BaseSoundBuffer's fade across StopPlay and a drive
// Close/Open. No physical-drive availability or WinMM mixer is simulated here.
export const cddaReopenSource = String.raw`
System.exitOnNoWindowStartup=false;
class ReopenDisc extends CDDASoundBuffer {
 var states=[],completed=[],replaceOnce=false;
 function ReopenDisc(){super.CDDASoundBuffer(null);}
 function onStatusChanged(value){
  states.add(value);
  if(value=="stop" && replaceOnce){replaceOnce=false;open("E:1");}
 }
 function onFadeCompleted(){completed.add(volume);Debug.message("disc-fade-complete:"+volume+":"+completed.count);}
}
var discMusic;
function discReopenStart(){
 if(discMusic!==void && isvalid discMusic)invalidate discMusic;
 global.discMusic=new ReopenDisc();discMusic.open("D:1");discMusic.looping=true;discMusic.play();
 return discMusic.status;
}
function discReopenState(){return [discMusic.status,discMusic.volume,discMusic.completed.join(","),discMusic.states.join(",")].join("|");}
function discReopenAttempt(name){
 try{discMusic.open(name);return "opened:"+discMusic.status;}
 catch(error){return "rejected:"+discMusic.status;}
}
function discReopenAction(action){
 if(action==0)discMusic.fade(0,30000);
 else if(action==1){discMusic.open("D:2");discMusic.play();}
 else if(action==2){discMusic.open("E:1");discMusic.play();}
 else discMusic.stopFade();
 Debug.message("disc-button:"+action+":"+discMusic.status+":"+discMusic.completed.count);
}
function discReopenMenu(){
 global.discWindow=new Window();discWindow.caption="CD music fade";discWindow.setInnerSize(320,60);
 var root=new Layer(discWindow,null);discWindow.add(root);root.setSize(320,60);root.holdAlpha=false;root.fillRect(0,0,320,60,0xff102030);
 for(var i=0;i<4;i++){
  var button=new Layer(discWindow,root);discWindow.add(button);button.setPos(i*80,0,76,60);button.holdAlpha=false;
  button.fillRect(0,0,76,60,0xff206040+i*0x101010);button.visible=true;button.action=i;
  button.onClick=function(){global.discReopenAction(this.action);};
 }
 discReopenStart();discWindow.visible=true;Debug.message("disc-reopen-ready");
}
Debug.message("disc-reopen-source-ready");
`
