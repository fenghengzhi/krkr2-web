import { wave } from './audio.ts'

export const waveFadeExpected: Readonly<Record<string, string>> = {
  invalid: 'fade-invalid|fade-invalid|fade-count|fade-real|0|0|1',
  replacement: '80000,100000|100000|2',
  reentry: '80000,20000,100000|100000|3',
  narrow: '50000,20000|20000|2',
  target: '100000,0|0|2',
  disabled: '60000|60000|1',
  stop: '0|0|1',
}
export const waveFadeDelayedExpected = '50000|0|80000|80000'
export const waveFadeFiles = () => ({ 'fade.wav': wave(Array(1000).fill(0.5), 1000) })

/** Shared with the fixed Windows SDK. All synchronous controls are bounded,
 * use no playback device, and observe the actual inherited fade methods. */
export const waveFadeSource = String.raw`
System.exitOnNoWindowStartup=false;
class FadeControl extends WaveSoundBuffer {
  var observations=[],reenter=false;
  function FadeControl(){super.WaveSoundBuffer(null);}
  function onFadeCompleted(){
    observations.add(volume);
    if(reenter && observations.count==1){volume=40000;fade(20000,1);}
  }
}
function waveFadeBody(id,w){
  var failures=[],prefix="";
  if(id=="invalid"){
    w.fade(0,1000000000);
    try{w.fade(10000,0);}catch(e){failures.add(e.message);}
    try{w.fade(10000,1,-1);}catch(e){failures.add(e.message);}
    try{w.fade(%[]);}catch(e){failures.add(e.message);}
    try{w.fade(10000,%[]);}catch(e){failures.add(e.message);}
    prefix=failures.join("|")+"|"+w.observations.count;
    w.stopFade();return prefix+"|"+w.volume+"|"+w.observations.count;
  }
  if(id=="replacement"||id=="reentry"){
    w.volume=80000;w.fade(0,1000000000);
    w.reenter=id=="reentry";w.fade(100000,id=="reentry"?1000000000:1);w.stopFade();
  }else if(id=="narrow"){
    w.fade(4295017296,4294967297,4294967296,%[]);w.fade(20000,1,void);
  }else if(id=="target"){
    w.fade(200000,1);w.fade(-100000,1);
  }else if(id=="disabled"){
    System.eventDisabled=true;w.fade(20000,1);w.stopFade();System.eventDisabled=false;w.fade(60000,1);
  }else if(id=="stop"){
    w.stopFade();w.fade(0,1000000000);w.stopFade();w.stopFade();
  }else throw new Exception("Unknown fade control");
  return w.observations.join(",")+"|"+w.volume+"|"+w.observations.count;
}
function waveFadeObserve(id){
  System.assignMessage("TVPInvalidParam","fade-invalid");
  System.assignMessage("TJSBadParamCount","fade-count");
  System.assignMessage("TJSVariantConvertError","fade-real");
  var w=new FadeControl(),result,primary,failed=false,cleanup;
  try{result=waveFadeBody(id,w);}catch(e){primary=e;failed=true;}
  System.eventDisabled=false;
  try{invalidate w;}catch(e){cleanup=e;}
  if(failed){if(cleanup!==void)Debug.message("fade-cleanup:"+cleanup.message);throw primary;}
  if(cleanup!==void)throw cleanup;
  return result;
}
var fadeDelayed,fadeDelayedTimer,fadeDelayedResult,fadeDelayedAfter;
function fadeDelayedTick(){
  global.fadeDelayedTimer.enabled=false;invalidate global.fadeDelayedTimer;
  var w=global.fadeDelayed,result=w.volume+"|"+w.observations.count;
  w.stopFade();result+="|"+w.volume+"|"+w.observations.join(",");invalidate w;
  global.fadeDelayedResult=result;Debug.message("fade-delayed:"+result);
  if(global.fadeDelayedAfter!==void)global.fadeDelayedAfter(result);
}
function fadeDelayedStart(){
  global.fadeDelayed=new FadeControl();global.fadeDelayed.volume=50000;
  global.fadeDelayed.fade(80000,59,1);
  global.fadeDelayedTimer=new Timer(global,"fadeDelayedTick");global.fadeDelayedTimer.interval=240;global.fadeDelayedTimer.enabled=true;
  return "waiting";
}
Debug.message("wave-fade-ready");
`
