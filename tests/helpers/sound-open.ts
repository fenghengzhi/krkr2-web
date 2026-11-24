import { wave } from './audio.ts'

export const soundOpenExpected: Readonly<Record<string, string>> = {
  wave: 'open-count|open-string|stop|50000|1|1|0|0|1|stop',
  midi: 'open-count|open-string|unload',
  cdda: 'open-count|open-string|unload',
}
export const soundOpenFiles = () => ({
  'open-keep.wav': wave(Array(1000).fill(0.25), 1000),
  'open-keep.wav.sli': new TextEncoder().encode("#2.00\nLabel {Position=50;Name='kept';}"),
})
export const soundOpenSource = String.raw`
System.exitOnNoWindowStartup=false;
class OpenWave extends WaveSoundBuffer {
  var completed=0,seen=[],states=[];
  function OpenWave(){super.WaveSoundBuffer(null);}
  function onFadeCompleted(){completed++;}
  function onLabel(name){seen.add(name);}
  function onStatusChanged(value){states.add(value);}
}
function soundOpenErrors(w){
  var result=[];
  try{w.open();}catch(e){result.add(e.message);}
  // TJS objects have their own string representation; octets are the native
  // unconvertible string case (tjsVariant.h AsString/ToString).
  try{w.open(<%00%>,%[]);}catch(e){result.add(e.message);}
  return result.join("|");
}
function soundOpenObserve(kind){
  System.assignMessage("TJSBadParamCount","open-count");
  System.assignMessage("TJSVariantConvertError","open-string");
  var w=kind=="wave"?new OpenWave():kind=="midi"?new MIDISoundBuffer(null):new CDDASoundBuffer(null);
  var result,old,primary,failed=false,cleanup;
  try{
    if(kind=="wave"){w.open("open-keep.wav");w.volume=50000;old=w.labels;w.fade(0,1000000000);}
    result=soundOpenErrors(w)+"|"+w.status;
    if(kind=="wave"){
      result+="|"+w.volume+"|"+int(old==w.labels)+"|"+int(isvalid old)+"|"+w.completed;
      w.stopFade();result+="|"+w.volume+"|"+w.completed;
      w.open("open-keep.wav",%[]);result+="|"+w.status;
    }
  }catch(e){primary=e;failed=true;}
  try{invalidate w;}catch(e){cleanup=e;}
  if(failed){if(cleanup!==void)Debug.message("sound-open-cleanup:"+cleanup.message);throw primary;}
  if(cleanup!==void)throw cleanup;
  return result;
}
Debug.message("sound-open-ready");
`
