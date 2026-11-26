import { wave } from './audio.ts'

const text = (value: string) => new TextEncoder().encode(value)
const sli = (frames: number, pipeline = false) => text('#2.00\n' +
  (pipeline ? `Link {From=${frames};To=0;Smooth=True;Condition=eq;RefValue=1;CondVar=0;}\n` : '') +
  `Label {Position=0;Name='head';}\nLabel {Position=${frames};Name='tail';}\n`)
export const waveTailFiles = () => {
  const small = wave(Array.from({ length: 48 }, (_, i) => i % 2 ? -0.5 : 0.25), 1000, 2),
    native = wave(Array.from({ length: 9600 }, (_, i) => i % 2 ? -0.5 : 0.25), 48000, 2)
  return {
    'tail-small.wav': small, 'tail-small.wav.sli': sli(24),
    'tail-small-smooth.wav': small, 'tail-small-smooth.wav.sli': sli(24, true),
    'tail-next.wav': wave(Array.from({ length: 96000 }, (_, i) => i % 2 ? 0.125 : 0.5), 48000, 2),
    'tail-native.wav': native, 'tail-native.wav.sli': sli(4800),
    'tail-native-smooth.wav': native, 'tail-native-smooth.wav.sli': sli(4800, true),
    'tail-game.wav': wave(Array.from({ length: 96000 }, (_, i) => i % 2 ? -0.5 : 0.25), 48000, 2),
    'tail-game.wav.sli': sli(48000),
  }
}
export const waveTailSdkExpected: Readonly<Record<string, string>> = {
  'wave-tail-normal': 'head,tail,stop|stop,play|1',
  'wave-tail-smooth': 'head,tail,stop|stop,play|1',
}
export const waveTailSource = String.raw`
System.exitOnNoWindowStartup=false;
var tailCurrent,tailNext,tailJournal=[],tailCount=0,tailWindow,tailHeldPosition;
class TailWave extends WaveSoundBuffer {
 var armed=false;
 function TailWave(){super.WaveSoundBuffer(null);}
 function onLabel(name){
  if(!armed)return;
  global.tailJournal.add(name);
  if(name=="tail"){
   global.tailCount++;
   global.tailNext.play();
   global.Debug.message("wave-tail-next:"+global.tailNext.status);
  }
 }
 function onStatusChanged(s){if(armed && s=="stop")global.tailJournal.add("stop");}
}
function waveTailClose(){
 var failures=[];
 try{if(tailCurrent!==void && isvalid tailCurrent){tailCurrent.armed=false;invalidate tailCurrent;}}catch(e){failures.add(e.message);}tailCurrent=void;
 try{if(tailNext!==void && isvalid tailNext)invalidate tailNext;}catch(e){failures.add(e.message);}tailNext=void;
 if(failures.count)throw new Exception("Tail sound cleanup: "+failures.join("|"));
 return "closed";
}
function waveTailStart(name,paused=false){
 waveTailClose();tailJournal=[];tailCount=0;
 tailNext=new WaveSoundBuffer(null);tailNext.open("tail-next.wav");tailNext.looping=true;
 tailCurrent=new TailWave();tailCurrent.open(name);tailCurrent.paused=paused;tailCurrent.armed=true;tailCurrent.play();
 return [tailCurrent.status,tailNext.status,tailCount].join(",");
}
function waveTailState(){return [tailCurrent.status,tailNext.status].join(",")+"|"+tailJournal.join(",")+"|"+tailCount;}
function waveTailManualStop(){tailCurrent.armed=false;tailCurrent.stop();tailNext.stop();return [tailCurrent.status,tailNext.status,tailCount].join(",");}
function waveTailMenu(){
 waveTailStart("tail-game.wav",true);
 tailWindow=new Window();tailWindow.caption="Music tail handoff";tailWindow.setInnerSize(180,60);tailWindow.visible=true;
 var root=new Layer(tailWindow,null);tailWindow.add(root);root.holdAlpha=false;root.setSize(180,60);root.fillRect(0,0,180,60,0xff202020);
 var play=new Layer(tailWindow,root);tailWindow.add(play);play.holdAlpha=false;play.setPos(0,0,60,60);play.fillRect(0,0,60,60,0xff208040);play.visible=true;
 var pause=new Layer(tailWindow,root);tailWindow.add(pause);pause.holdAlpha=false;pause.setPos(60,0,60,60);pause.fillRect(0,0,60,60,0xffb08020);pause.visible=true;
 var stop=new Layer(tailWindow,root);tailWindow.add(stop);stop.holdAlpha=false;stop.setPos(120,0,60,60);stop.fillRect(0,0,60,60,0xff804080);stop.visible=true;
 play.onClick=function(){global.tailCurrent.paused=false;global.Debug.message("wave-tail-play:"+global.tailCurrent.status);};
 pause.onClick=function(){global.tailCurrent.paused=true;global.tailHeldPosition=global.tailCurrent.samplePosition;global.Debug.message("wave-tail-paused");};
 stop.onClick=function(){global.Debug.message("wave-tail-manual:"+global.waveTailManualStop());};
 Debug.message("wave-tail-ready");
}
// The existing Windows/Wine runner invokes these bounded, actual-play cases.
// No duration getter, silent-device inference or substitute MIDI endpoint is
// used to prove delivery: the original tail label must start the second Wave.
var waveTailAfter,tailSdkTimer,tailSdkIndex=0,tailSdkTicks=0;
function waveTailSdkFinishCase(result){
 var id=tailSdkIndex==0?"wave-tail-normal":"wave-tail-smooth";
 try{waveTailClose();}catch(e){result+="|cleanup:"+e.message;}
 waveTailAfter(id,result);
 if(++tailSdkIndex<2){waveTailSdkNext();return;}
 if(tailSdkTimer!==void && isvalid tailSdkTimer){tailSdkTimer.enabled=false;invalidate tailSdkTimer;}tailSdkTimer=void;
 waveTailAfter("done","");
}
function waveTailSdkNext(){
 tailSdkTicks=0;
 try{waveTailStart(tailSdkIndex==0?"tail-native.wav":"tail-native-smooth.wav");}
 catch(e){waveTailSdkFinishCase("unexpected-error:"+e.message);}
}
function waveTailSdkTick(){
 try{
  if(tailJournal.find("stop")>=0 && tailCount>0){waveTailSdkFinishCase(tailJournal.join(",")+"|"+[tailCurrent.status,tailNext.status].join(",")+"|"+tailCount);return;}
  if(++tailSdkTicks>200)waveTailSdkFinishCase("unexpected-error:Tail label timed out:"+waveTailState());
 }catch(e){waveTailSdkFinishCase("unexpected-error:"+e.message);}
}
function waveTailSdkStart(){
 tailSdkIndex=0;tailSdkTimer=new Timer(global,"waveTailSdkTick");tailSdkTimer.interval=20;tailSdkTimer.enabled=true;waveTailSdkNext();
}
`
