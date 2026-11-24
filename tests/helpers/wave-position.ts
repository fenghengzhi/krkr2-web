import { wave } from './audio.ts'

/** The same real TJS controls run in the pinned Windows SDK and the Web VM.
 * Expected floats below are authored IEEE-754 dyadic fractions, not product
 * calculations. They equal the former long decimal constants exactly:
 * 0.1f=13421773/2^27; 0.2f=13421773/2^26; 0.00075f=12884902/2^34;
 * 0.001f=8589935/2^33; 0.003f=12884902/2^32. This avoids making coordinate
 * equality also depend on the separate long-decimal TJS parser behavior. */
export const wavePositionExpected: Readonly<Record<string, string>> = {
  'position-default': '+0.0,+0.0,+0.0,0,unload',
  'position-real': '1,1,1,1,1,1,1',
  'position-arguments': 'wave-args|wave-args|wave-args|wave-real|4,5,6|1|+0.0,+0.0,+0.0',
  'position-properties': '1,1,1|wave-real|1,1,1',
  'position-pan-before': '1,2,3|1,1,1|7,8,9|1,1,1|50000|1',
  'position-independent': '1,2,3|4,5,6|0,0|1|+0.0,+0.0,+0.0',
  'position-playback': '1,1|7,8,9|7,8,9|unload|7,8,9|stop|7,8,9',
  'position-callback': '7,8,9|25000|play|1',
}
export const wavePositionFiles = () => ({
  // Constant, independently authored stereo PCM: left +1/4, right -1/2.
  'position.wav': wave(Array.from({ length: 24000 * 2 }, (_, at) => at % 2 ? -0.5 : 0.25), 48000, 2),
})
export const wavePositionSource = String.raw`
System.exitOnNoWindowStartup=false;
function wavePositionText(w){return [w.posX,w.posY,w.posZ].join(",");}
function wavePositionHolders(){
  System.assignMessage("TJSBadParamCount","wave-args");
  System.assignMessage("TJSVariantConvertError","wave-real");
}
class PositionCallbackWave extends WaveSoundBuffer {
  var armed=false,seen="",calls=0;
  function PositionCallbackWave(){super.WaveSoundBuffer(null);}
  function onStatusChanged(s){
    if(s=="play" && armed){calls++;setPos(7,8,9);pan=25000;seen=global.wavePositionText(this);}
  }
}
function wavePositionNew(owned,callback=false){
  var w=callback?new PositionCallbackWave():new WaveSoundBuffer(null);owned.add(w);return w;
}
function wavePositionCase(id,owned){
  var w=wavePositionNew(owned),v,result="",errors=[];
    switch(id){
      case "position-default":return wavePositionText(w)+","+w.pan+","+w.status;
      case "position-real":
        v=w.setPos("0.1",16777217,-0.2);
        result=[v===void,w.posX==(13421773.0/134217728.0),w.posY==16777216,w.posZ==(-13421773.0/67108864.0),w.pan==0].join(",");
        w.setPos(1e100,-1e100,0);
        return result+","+int(w.posX>1e100)+","+int(w.posY< -1e100);
      case "position-arguments":
        w.setPos(4,5,6);
        try{w.setPos();}catch(e){errors.add(e.message);}
        try{w.setPos(%[]);}catch(e){errors.add(e.message);}
        try{w.setPos(1,2);}catch(e){errors.add(e.message);}
        try{w.setPos(10,%[],30);}catch(e){errors.add(e.message);}
        result=errors.join("|")+"|"+wavePositionText(w);
        v=w.setPos(1,2,3,%[]);result+="|"+int(v===void);
        w.setPos(void,void,void);return result+"|"+wavePositionText(w);
      case "position-properties":
        w.posX=0.1;w.posY=-0.2;w.posZ=16777217;
        result=[w.posX==(13421773.0/134217728.0),w.posY==(-13421773.0/67108864.0),w.posZ==16777216].join(",");
        try{w.posY=%[];}catch(e){result+="|"+e.message;}
        return result+"|"+[w.posX==(13421773.0/134217728.0),w.posY==(-13421773.0/67108864.0),w.posZ==16777216].join(",");
      case "position-pan-before":
        w.setPos(1,2,3);w.pan=0;result=wavePositionText(w);
        w.pan=50000;result+="|"+[w.posX==(12884902.0/17179869184.0),w.posY==(8589935.0/8589934592.0),w.posZ==0].join(",");
        w.setPos(7,8,9);w.pan=50000;result+="|"+wavePositionText(w);
        w.pan=-100000;result+="|"+[w.posX==(-12884902.0/4294967296.0),w.posY==(8589935.0/8589934592.0),w.posZ==0].join(",");
        w.pan=4295017296;return result+"|"+w.pan+"|"+int(w.posX==(12884902.0/17179869184.0));
      case "position-independent":
        v=wavePositionNew(owned);w.setPos(1,2,3);v.setPos(4,5,6);
        result=wavePositionText(w)+"|"+wavePositionText(v)+"|"+w.pan+","+v.pan;
        invalidate w;result+="|"+int(!isvalid w);invalidate v;
        w=wavePositionNew(owned);return result+"|"+wavePositionText(w);
      case "position-playback":
        w.setPos(1,2,3);w.open("position.wav");w.pan=50000;
        result=[w.posX==(12884902.0/17179869184.0),w.posY==(8589935.0/8589934592.0)].join(",");
        w.play();w.setPos(7,8,9);w.pan=-50000;result+="|"+wavePositionText(w);
        w.stop();w.pan=0;result+="|"+wavePositionText(w);
        try{w.open("absent-position.wav");}catch(e){}
        result+="|"+w.status;w.pan=100000;result+="|"+wavePositionText(w);
        w.open("position.wav");return result+"|"+w.status+"|"+wavePositionText(w);
      case "position-callback":
        invalidate w;w=wavePositionNew(owned,true);w.open("position.wav");w.armed=true;w.play();
        return w.seen+"|"+w.pan+"|"+w.status+"|"+w.calls;
    }
    throw new Exception("Unknown wave position control");
}
function wavePositionObserve(id){
  wavePositionHolders();
  var owned=[],result,primary,failed=false,cleanup=[];
  try{result=wavePositionCase(id,owned);}catch(e){primary=e;failed=true;}
  for(var i=owned.count-1;i>=0;i--){try{if(isvalid owned[i])invalidate owned[i];}catch(e){cleanup.add(e.message);}}
  if(failed){if(cleanup.count)Debug.message("wave-position-cleanup:"+cleanup.join("|"));throw primary;}
  if(cleanup.count)throw new Exception("Wave position cleanup failed: "+cleanup.join("|"));
  return result;
}
`
