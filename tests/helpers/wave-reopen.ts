import { wave } from './audio.ts'

export const waveReopenExpected: Readonly<Record<string, string>> = {
  cold: '0|stop|80000||stop|20000|20000',
  reopen: '0|stop|80000||unload,stop|20000|20000',
  missing: '1|unload|80000||unload|20000|20000',
  sli: '1|unload|80000||unload|20000|20000',
  reentry: '0|stop|60000|60000|unload,stop|10000|60000,10000',
}
export const waveReopenFiles = () => ({
  'reopen-a.wav': wave(Array(32000).fill(0.5), 1000),
  'reopen-b.wav': wave(Array(32000).fill(0.25), 1000),
  'reopen-a.wav.sli': new TextEncoder().encode("#2.00\nLabel {Position=10;Name='old';}"),
  'reopen-b.wav.sli': new TextEncoder().encode("#2.00\nLabel {Position=10;Name='new';}"),
  'reopen-bad.wav': wave(Array(1000).fill(0.75), 1000),
  'reopen-bad.wav.sli': new TextEncoder().encode('#2.00\nLink {From=10;To=0;Smooth=oops;}'),
})

/** The original SDK can run these without a playback device. Long fades have
 * a zero per-beat delta, so elapsed runner time cannot change the observations. */
export const waveReopenSource = String.raw`
System.exitOnNoWindowStartup=false;
class ReopenWave extends WaveSoundBuffer {
 var completed=[],states=[],labelsSeen=[],replaceOnUnload=false;
 function ReopenWave(){super.WaveSoundBuffer(null);}
 function onFadeCompleted(){completed.add(volume);}
 function onLabel(name){labelsSeen.add(name);}
 function onStatusChanged(status){
  states.add(status);
  if(status=="unload" && replaceOnUnload){replaceOnUnload=false;volume=60000;fade(10000,1000000000);}
 }
}
function waveReopenBody(kind,w){
 if(kind!="cold")w.open("reopen-a.wav");
 w.states.clear();w.volume=80000;w.fade(20000,1000000000);
 w.replaceOnUnload=kind=="reentry";
 var failed=false;
 try{w.open(kind=="missing"?"reopen-missing.wav":kind=="sli"?"reopen-bad.wav":kind=="cold"?"reopen-a.wav":"reopen-b.wav");}
 catch(e){failed=true;if(kind!="missing" && kind!="sli")throw e;}
 var before=[int(failed),w.status,w.volume,w.completed.join(","),w.states.join(",")].join("|");
 w.stopFade();return before+"|"+w.volume+"|"+w.completed.join(",");
}
function waveReopenObserve(kind){
 var w=new ReopenWave(),result,primary,failed=false,cleanup;
 try{result=waveReopenBody(kind,w);}catch(e){primary=e;failed=true;}
 try{invalidate w;}catch(e){cleanup=e;}
 if(failed){if(cleanup!==void)Debug.message("reopen-cleanup:"+cleanup.message);throw primary;}
 if(cleanup!==void)throw cleanup;return result;
}
Debug.message("wave-reopen-ready");
`
