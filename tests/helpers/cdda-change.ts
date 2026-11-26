import { wave } from './audio.ts'

export const cddaChangeDiscs = [{ drive: 'D', cue: 'disc-one.cue' }, { drive: 'E', cue: 'disc-e.cue' }] as const
/** Independent constant stereo planes make each drive's contribution exact. */
export function cddaChangeFiles(): Record<string, string | Uint8Array> {
  const pcm = (left: number, right: number) => wave(Array.from({ length: 4000 }, (_, i) => i % 2 ? right : left), 1000, 2),
    cue = (name: string) => `FILE "${name}" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n`
  return { 'disc-one.cue': cue('one.wav'), 'disc-two.cue': cue('two.wav'), 'disc-e.cue': cue('e.wav'),
    'disc-held.cue': cue('held.wav'), 'one.wav': pcm(.25, .125), 'two.wav': pcm(-.25, -.125),
    'e.wav': pcm(.125, -.125), 'direct.wav': pcm(.0625, .03125), 'wave.wav': pcm(.03125, .015625),
    'held.wav': pcm(.5, -.5) }
}

export const cddaChangeSource = String.raw`
System.exitOnNoWindowStartup=false;
class ChangeDiscSound extends CDDASoundBuffer {
 var states=[],fades=0,reopenOnUnload=false;
 function ChangeDiscSound(){super.CDDASoundBuffer(null);}
 function onStatusChanged(value){
  states.add(value);
  if(value=="unload" && reopenOnUnload){reopenOnUnload=false;open("D:1");play();}
 }
 function onFadeCompleted(){fades++;}
}
var changeD=new ChangeDiscSound(),changeE=new ChangeDiscSound(),changeDirect=new CDDASoundBuffer(null),changeWave=new WaveSoundBuffer(null);
function changeStart(){
 changeD.open("D:1");changeD.looping=true;changeD.play();
 changeE.open("E:1");changeE.looping=true;changeE.play();
 changeDirect.open("direct.wav");changeDirect.looping=true;changeDirect.play();
 changeWave.open("wave.wav");changeWave.looping=true;changeWave.play();
 return changeState();
}
function changeState(){return [changeD.status,changeE.status,changeDirect.status,changeWave.status].join(",");}
function changeAttempt(name){
 try{changeD.open(name);return "opened:"+changeD.status;}
 catch(error){return "rejected:"+changeD.status;}
}
Debug.message("disc-change-source-ready");
`
