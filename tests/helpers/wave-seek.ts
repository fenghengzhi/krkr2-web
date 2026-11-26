import { wave } from './audio.ts'

export const waveSeekPattern = [0.125, -0.25, 0.375, -0.5, 0.625, -0.75, 0.875, -1] as const
export const waveSeekFrames = 88200
export const waveSeekFiles = () => ({
  'seek.wav': wave(Array.from({ length: waveSeekFrames }, (_, at) => waveSeekPattern[at % 8]!), 44100),
  'seek.wav.sli': new TextEncoder().encode("#2.00\nLabel {Position=0;Name='zero';}\nLabel {Position=44;Name='ms44';}\nLabel {Position=45;Name='sample45';}\nLabel {Position=1000;Name='later';}"),
  'seek-other.wav': wave(Array.from({ length: 96000 }, (_, at) => waveSeekPattern[at % 8]!), 48000),
  'seek-other.wav.sli': new TextEncoder().encode("#2.00\nLabel {Position=44;Name='old44';}\nLabel {Position=48;Name='new48';}"),
  'seek-loop.wav': wave(Array.from({ length: 8200 }, (_, at) => waveSeekPattern[at % 8]!), 44100),
  'seek-loop.wav.sli': new TextEncoder().encode("#2.00\nLink {From=8200;To=8192;}\nLabel {Position=8194;Name='loop';}"),
  // The real browser output remains independently observable after a rejected
  // seek, without depending on a platform's output-rate interpolation phase.
  'seek-constant.wav': wave(Array(44100 * 30).fill(0.25), 44100),
})

export const waveSeekSdkExpected = 'zero|ms44|ms44|sample45|zero|old44|new48'
export const waveSeekSource = String.raw`
System.exitOnNoWindowStartup=false;
class SeekWave extends WaveSoundBuffer {
 var markers=[],states=[],completed=0,first=void;
 function SeekWave(){super.WaveSoundBuffer(null);}
 function onLabel(name){markers.add(name);if(first===void)first=name;}
 function onStatusChanged(status){states.add(status);}
 function onFadeCompleted(){completed++;}
}
function waveSeekInvalid(w,total){
 w.samplePosition=total;w.samplePosition=total+1;w.samplePosition=-1;
 w.samplePosition=9223372036854775807;w.position=-1;w.position=2000000;
}
// Original getters cannot observe the decoder cursor before DirectSound has
// been created. These SDK controls instead play and record the first real SLI
// label reached from the requested source position. No elapsed position or
// hardware PCM equivalence is inferred from the label observations.
var waveSeekAfter,seekSdkTimer,seekSdkWave,seekSdkAt=0,seekSdkTicks=0,seekSdkRows=[];
function waveSeekSdkClose(){
 if(seekSdkTimer!==void && isvalid seekSdkTimer){seekSdkTimer.enabled=false;invalidate seekSdkTimer;}seekSdkTimer=void;
 if(seekSdkWave!==void && isvalid seekSdkWave)invalidate seekSdkWave;seekSdkWave=void;
}
function waveSeekSdkFinish(result){
 var cleanup;
 try{waveSeekSdkClose();}catch(e){cleanup=e;}
 if(cleanup!==void)result+="|cleanup:"+cleanup.message;
 waveSeekAfter(result);
}
function waveSeekSdkNext(){
 seekSdkWave=new SeekWave();seekSdkWave.open("seek.wav");
 if(seekSdkAt>0){seekSdkWave.paused=true;seekSdkWave.play();seekSdkWave.stop();seekSdkWave.paused=false;}
 if(seekSdkAt<=1)seekSdkWave.position=1;
 else if(seekSdkAt==2){seekSdkWave.samplePosition=44;waveSeekInvalid(seekSdkWave,88200);}
 else if(seekSdkAt==3)seekSdkWave.samplePosition=45;
 else if(seekSdkAt==4){seekSdkWave.samplePosition=45;seekSdkWave.position=4611686018427387904;}
 else {
  seekSdkWave.open("seek-other.wav");
  if(seekSdkAt==6){seekSdkWave.paused=true;seekSdkWave.play();seekSdkWave.stop();seekSdkWave.paused=false;}
  seekSdkWave.position=1;
 }
 seekSdkWave.first=void;
 seekSdkWave.play();seekSdkTicks=0;
}
function waveSeekSdkTick(){
 try{
  if(seekSdkWave.first===void){if(++seekSdkTicks>400)waveSeekSdkFinish("unexpected-error:Wave seek label timed out");return;}
  seekSdkRows.add(seekSdkWave.first);seekSdkWave.stop();invalidate seekSdkWave;seekSdkWave=void;
  if(++seekSdkAt==7){waveSeekSdkFinish(seekSdkRows.join("|"));return;}
  waveSeekSdkNext();
 }catch(e){waveSeekSdkFinish("unexpected-error:"+e.message);}
}
function waveSeekSdkStart(){
 seekSdkAt=0;seekSdkRows=[];
 try{waveSeekSdkNext();seekSdkTimer=new Timer(global,"waveSeekSdkTick");seekSdkTimer.interval=20;seekSdkTimer.enabled=true;}
 catch(e){waveSeekSdkFinish("unexpected-error:"+e.message);}
}
Debug.message("wave-seek-ready");
`
