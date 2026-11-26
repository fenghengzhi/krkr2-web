import { wave } from './audio.ts'

/** Authored from WaveIntf SetPaused/SetLooping(bool) and the fixed native
 * tTJSVariant bool conversion. No production conversion is used for expected
 * values. Strings intentionally differ from the numerically equal reals. */
export const waveBooleanExpected: Readonly<Record<string, string>> = {
  'wave-bool-paused': '0,1,1,1,1,0,1,0,0,0,1,0,0,0,1,1,1,1',
  'wave-bool-looping': '0,1,1,1,1,0,1,0,0,0,1,0,0,0,1,1,1,1',
  'wave-bool-control': '1,1|0,0|1,1|1|1,1|0,1|0,0',
}
export const waveBooleanFiles = () => ({
  // A 24-frame asymmetric stereo phrase, three repeats of an exact dyadic
  // eight-frame pattern. Values are representable in the stored signed16 PCM.
  'bool-phrase.wav': wave(Array.from({ length: 48 }, (_, at) =>
    (at % 2 ? [-0.5, -0.375, -0.25, -0.125, 0.5, 0.375, 0.25, 0.125]
      : [0.125, 0.25, 0.375, 0.5, -0.125, -0.25, -0.375, -0.5])[Math.floor(at / 2) % 8]!), 1000, 2),
  'bool-phrase.wav.sli': new TextEncoder().encode("#2.00\nLabel { Position=4; Name='beat'; }\n"),
  // Same short duration with constant stereo values makes every real browser
  // output sample independently checkable despite its device resampling rate.
  'bool-loop.wav': wave(Array.from({ length: 48 }, (_, at) => at % 2 ? -0.5 : 0.25), 1000, 2),
})
export const waveBooleanSource = String.raw`
System.exitOnNoWindowStartup=false;
var waveBooleanReads=0;
function waveBooleanOnce(){waveBooleanReads++;return %[];}
function waveBooleanCase(id,owned){
 var w=new WaveSoundBuffer(null);owned.add(w);
 if(id=="wave-bool-paused" || id=="wave-bool-looping"){
  var values=[0,1,-1,0.5,-0.5,0.0,4294967296,void,null,"0","1","0.5","-0.5","yes",[],%[],<%00%>,function(){}],result=[];
  for(var i=0;i<values.count;i++){
   if(id=="wave-bool-paused"){w.paused=values[i];result.add(w.paused);}
   else {w.looping=values[i];result.add(w.looping);}
  }
  return result.join(",");
 }
 if(id=="wave-bool-control"){
  var other=new WaveSoundBuffer(null);owned.add(other);
  w.paused=0.5;w.looping=-0.5;
  var result=[w.paused,w.looping].join(",")+"|"+[other.paused,other.looping].join(",");waveBooleanReads=0;
  w.paused=waveBooleanOnce();w.looping=<%00%>;
  result+="|"+[w.paused,w.looping].join(",")+"|"+waveBooleanReads;
  w.stop();result+="|"+[w.paused,w.looping].join(",");
  w.volume=0.5;var rejected=false;
  try{w.volume=%[];}catch(e){rejected=true;}
  result+="|"+w.volume+","+int(rejected);
  invalidate w;var fresh=new WaveSoundBuffer(null);owned.add(fresh);
  return result+"|"+[fresh.paused,fresh.looping].join(",");
 }
 throw new Exception("Unknown Wave boolean control");
}
function waveBooleanObserve(id){
 var owned=[],result,primary,failed=false,cleanup=[];
 try{result=waveBooleanCase(id,owned);}catch(e){primary=e;failed=true;}
 for(var i=owned.count-1;i>=0;i--){try{if(isvalid owned[i])invalidate owned[i];}catch(e){cleanup.add(e.message);}}
 if(failed){if(cleanup.count)Debug.message("wave-bool-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Wave boolean cleanup failed: "+cleanup.join("|"));
 return result;
}
class BooleanWave extends WaveSoundBuffer {
 var states=[],marks=[];
 function BooleanWave(){super.WaveSoundBuffer(null);}
 function onStatusChanged(s){states.add(s);}
 function onLabel(s){marks.add(s);}
}
var boolMusic, boolWindow;
function waveBooleanState(){return [boolMusic.status,boolMusic.paused,boolMusic.looping,boolMusic.samplePosition,boolMusic.marks.count].join(",");}
function waveBooleanStart(name){
 boolMusic=new BooleanWave();boolMusic.open(name);boolMusic.looping=0.5;boolMusic.paused=0.5;boolMusic.play();
 return waveBooleanState();
}
function waveBooleanMenu(){
 waveBooleanStart("bool-loop.wav");
 boolWindow=new Window();boolWindow.caption="Wave pause and loop";boolWindow.setInnerSize(180,60);boolWindow.visible=true;
 var root=new Layer(boolWindow,null);boolWindow.add(root);root.holdAlpha=false;root.setSize(180,60);root.fillRect(0,0,180,60,0xff202020);
 var resume=new Layer(boolWindow,root);boolWindow.add(resume);resume.holdAlpha=false;resume.setPos(0,0,60,60);resume.fillRect(0,0,60,60,0xff208040);resume.visible=true;
 var pause=new Layer(boolWindow,root);boolWindow.add(pause);pause.holdAlpha=false;pause.setPos(60,0,60,60);pause.fillRect(0,0,60,60,0xffc08020);pause.visible=true;
 var finish=new Layer(boolWindow,root);boolWindow.add(finish);finish.holdAlpha=false;finish.setPos(120,0,60,60);finish.fillRect(0,0,60,60,0xff804080);finish.visible=true;
 resume.onClick=function(){global.boolMusic.paused=0;global.Debug.message("wave-bool-resume:"+global.boolMusic.paused);};
 pause.onClick=function(){global.boolMusic.paused=-0.5;global.Debug.message("wave-bool-pause:"+global.boolMusic.paused);};
 finish.onClick=function(){global.boolMusic.looping="0.5";global.Debug.message("wave-bool-once:"+global.boolMusic.looping);};
 Debug.message("wave-bool-menu:"+[boolMusic.status,boolMusic.paused,boolMusic.looping].join(","));
}
function waveBooleanClose(){if(boolMusic!==void && isvalid boolMusic)invalidate boolMusic;return "closed";}
`
