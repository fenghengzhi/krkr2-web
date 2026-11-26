import { wave } from './audio.ts'

/** Native WaveLoopManager::Decode joins source segments before the device
 * resamples them. Independent logical sequence: [-.5,-.5,+.5,+.5] repeated.
 * Physical data after the hard link is +.875 and must never bleed into it. */
export const loopPhrase = [-.5, -.5, .5, .5] as const
export const loopHalfRate = [-.5, -.5, -.5, 0, .5, .5, .5, 0] as const
export const loopSli = (from: number, to: number) =>
  `#2.00\nLink {From=${from};To=${to};Smooth=False;}\nLabel {Position=${to};Name='phrase';}\n`
export function waveLoopResamplingFiles(): Record<string, Uint8Array> {
  const stereo = (left: readonly number[]) => left.flatMap((value) => [value, -value / 2]),
    long = Array<number>(8196).fill(.875)
  for (let at = 8188; at < 8192; at++) long[at] = loopPhrase[at - 8188]!
  return {
    'resample-whole.wav': wave(stereo(loopPhrase), 1000, 2),
    'resample-sli.wav': wave(stereo(long), 1000, 2),
    'resample-sli.wav.sli': new TextEncoder().encode(loopSli(8192, 8188)),
  }
}
export const waveLoopResamplingSource = String.raw`
System.exitOnNoWindowStartup=false;
class ResampleMusic extends WaveSoundBuffer {
 var marks=0;
 function ResampleMusic(){super.WaveSoundBuffer(null);}
 function onLabel(name){if(name=="phrase")marks++;}
}
var resampleMusic=new ResampleMusic(),resampleChoice=0;
function resampleStart(whole){
 resampleChoice=whole?0:1;resampleMusic.open(whole?"resample-whole.wav":"resample-sli.wav");
 resampleMusic.looping=whole;resampleMusic.samplePosition=whole?0:8188;resampleMusic.marks=0;resampleMusic.play();
 return resampleMusic.status;
}
function resampleMenu(){
 global.resampleWindow=new Window();resampleWindow.caption="Music loop joins";resampleWindow.setInnerSize(320,60);
 var root=new Layer(resampleWindow,null);resampleWindow.add(root);root.setSize(320,60);root.holdAlpha=false;root.fillRect(0,0,320,60,0xff183048);
 for(var i=0;i<4;i++){
  var button=new Layer(resampleWindow,root);resampleWindow.add(button);button.setPos(i*80,0,78,60);button.holdAlpha=false;
  button.fillRect(0,0,78,60,0xff285038+i*0x101010);button.visible=true;button.action=i;
  button.onClick=function(){
   if(this.action==0)global.resampleStart(true);
   else if(this.action==1)global.resampleStart(false);
   else if(this.action==2)global.resampleMusic.paused=!global.resampleMusic.paused;
   else {global.resampleMusic.looping=false;global.resampleMusic.stop();}
   global.Debug.message("resample-action:"+this.action+":"+global.resampleMusic.status+":"+global.resampleMusic.paused);
  };
 }
 resampleStart(true);resampleWindow.visible=true;Debug.message("resample-menu-ready");
}
Debug.message("resample-source-ready");
`
