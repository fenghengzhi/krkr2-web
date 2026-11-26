import { midi, wave } from './audio.ts'

export const waveFreeFiles = () => ({
  'free-a.wav': wave(Array(32000).fill(0.25)),
  'free-b.wav': wave(Array(32000).fill(0.125)),
  'free-cd.wav': wave(Array(32000).fill(0.0625)),
  'free-a.wav.sli': new TextEncoder().encode("#2.00\nLabel {Position=10;Name='a';}"),
  'free-b.wav.sli': new TextEncoder().encode("#2.00\nLabel {Position=15;Name='b';}"),
  // Ten minutes, no notes: an independent real SMF transport with exact
  // public progress, without adding a synthesizer to the PCM reference.
  'free-midi.mid': midi([[0x87, 0xa9, 0x40, 0xff, 0x2f, 0]], 100),
})

/** Fixed WaveImpl.cpp TVPReleaseSoundBuffers(false), TVPReleaseDirectSound,
 * and WaveImpl.h FreeDirectSoundBuffer: Stop callback, then destroy playback
 * buffers, retaining Decoder/LoopManager/BaseSoundBuffer's fade. */
export const waveFreeExpected = {
  'wave-free-cold': 'unload|1|1|80000|0|20000|1',
  'wave-free-loaded': 'stop,stop|0,0|1,1|1,1|7,9|1|a:stop,play;b:stop,stop|0|0|1|play,play',
}

export const waveFreeSource = String.raw`
System.exitOnNoWindowStartup=false;
var freeA,freeB,freeCd,freeMidi,freeWindow,freePanel;
var freeRecording=false,freeOrder=[];
class FreeWave extends WaveSoundBuffer {
 var name,states=[],marks=[],done=0,restart=false;
 function FreeWave(n){super.WaveSoundBuffer(null);name=n;}
 function onStatusChanged(s){
  states.add(s);
  if(s=="stop" && global.freeRecording){
   global.freeOrder.add(name+":"+global.freeA.status+","+global.freeB.status);
   if(restart){restart=false;play();}
  }
 }
 function onLabel(s){marks.add(s);}
 function onFadeCompleted(){done++;global.Debug.message("wave-free-fade:"+name+":"+done);}
}
function waveFreeObserveBody(kind,owned){
 freeA=new FreeWave("a");owned.add(freeA);freeB=new FreeWave("b");owned.add(freeB);
 freeA.paused=true;freeA.looping=true;freeA.volume=80000;freeOrder.clear();
 if(kind=="wave-free-cold"){
  freeA.fade(20000,1000000000);WaveSoundBuffer.freeDirectSound(%[]);
  var text=[freeA.status,freeA.paused,freeA.looping,freeA.volume,freeA.done].join("|");
  freeA.stopFade();return text+"|"+freeA.volume+"|"+freeA.done;
 }
 freeA.open("free-a.wav");freeB.open("free-b.wav");
 freeA.paused=true;freeB.paused=true;freeB.looping=true;
 freeA.play();freeB.play();freeA.flags[0]=7;freeB.flags[1]=9;
 var labels=freeA.labels;freeA.fade(0,1000000000);freeRecording=true;
 freeB.freeDirectSound();freeRecording=false;
 var text=[freeA.status,freeB.status].join(",")+"|"+[freeA.samplePosition,freeB.samplePosition].join(",")+
  "|"+[freeA.paused,freeB.paused].join(",")+"|"+[freeA.looping,freeB.looping].join(",")+
  "|"+[freeA.flags[0],freeB.flags[1]].join(",")+"|"+int(labels===freeA.labels)+"|"+freeOrder.join(";")+"|"+freeA.done;
 freeA.stopFade();text+="|"+freeA.volume+"|"+freeA.done;
 freeA.play();freeB.play();return text+"|"+[freeA.status,freeB.status].join(",");
}
function waveFreeObserve(kind){
 var owned=[],result,primary,failed=false,cleanup=[];
 try{result=waveFreeObserveBody(kind,owned);}catch(e){primary=e;failed=true;}
 freeRecording=false;
 for(var i=owned.count-1;i>=0;i--){try{if(isvalid owned[i])invalidate owned[i];}catch(e){cleanup.add(e.message);}}
 freeA=void;freeB=void;
 if(failed){if(cleanup.count)Debug.message("free-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception(cleanup.join("|"));return result;
}
function waveFreeStart(){
 freeA=new FreeWave("a");freeB=new FreeWave("b");
 freeA.open("free-a.wav");freeB.open("free-b.wav");freeA.looping=freeB.looping=true;
 freeCd=new CDDASoundBuffer(null);freeCd.open("free-cd.wav");freeCd.looping=true;
 freeMidi=new MIDISoundBuffer(null);freeMidi.open("free-midi.mid");
 freeA.play();freeB.play();freeCd.play();freeMidi.play();
}
function waveFreeState(){return [freeA.status,freeB.status,freeCd.status,freeMidi.status].join(",");}
function waveFreeMenu(){
 waveFreeStart();freeWindow=new Window();freeWindow.caption="Release and resume music";
 freeWindow.setInnerSize(240,90);freeWindow.visible=true;
 var root=new Layer(freeWindow,null);freeWindow.add(root);root.holdAlpha=false;root.setSize(240,90);root.fillRect(0,0,240,90,0xff202020);
 freePanel=new Layer(freeWindow,root);freeWindow.add(freePanel);freePanel.holdAlpha=false;freePanel.setPos(0,60,240,30);freePanel.fillRect(0,0,240,30,0xff208040);freePanel.visible=true;
 for(var i=0;i<3;i++){
  var b=new Layer(freeWindow,root);freeWindow.add(b);b.holdAlpha=false;b.setPos(i*80,0,80,60);
  b.fillRect(0,0,80,60,[0xff804020,0xff208040,0xff404080][i]);b.visible=true;
  if(i==0)b.onClick=function(){
   global.freeOrder.clear();global.freeRecording=true;global.freeA.fade(0,360);
   global.WaveSoundBuffer.freeDirectSound();global.freeRecording=false;
   global.freePanel.fillRect(0,0,240,30,0xff804020);global.Debug.message("wave-free-release:"+global.waveFreeState());
  };
  else if(i==1)b.onClick=function(){
   global.freeA.volume=100000;global.freeA.play();global.freeB.play();
   global.freePanel.fillRect(0,0,240,30,0xff208040);global.Debug.message("wave-free-resume:"+global.waveFreeState());
  };
  else b.onClick=function(){
   global.freeB.freeDirectSound();global.freeCd.stop();global.freeMidi.stop();
   global.freePanel.fillRect(0,0,240,30,0xff404080);global.Debug.message("wave-free-off:"+global.waveFreeState());
  };
 }
 Debug.message("wave-free-ready:"+waveFreeState());
}
`
