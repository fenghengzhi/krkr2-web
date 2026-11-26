import { wave } from './audio.ts'

// Two valid states: (flag0,flag15)=(1,1) stays in the first phrase, (0,0)
// moves to the second. The impossible intermediate (0,1) takes the third.
// No production SLI parser or mixer generates these inputs or expectations.
export function waveResetSli(scale = 1): string {
  return `#2.00\nLink {From=${40 * scale};To=${80 * scale};Smooth=False;Condition=eq;CondVar=0;RefValue=0;}\n` +
    `Link {From=${40 * scale};To=0;Smooth=False;Condition=no;CondVar=0;RefValue=0;}\nLink {From=${80 * scale};To=${160 * scale};Smooth=False;Condition=eq;CondVar=15;RefValue=1;}\n` +
    `Link {From=${120 * scale};To=${80 * scale};Smooth=False;Condition=no;CondVar=0;RefValue=0;}\nLink {From=${200 * scale};To=${160 * scale};Smooth=False;Condition=no;CondVar=0;RefValue=0;}\n` +
    `Label {Position=${80 * scale};Name='next';}\nLabel {Position=${160 * scale};Name='wrong';}\n`
}
export function waveResetFiles(game = false): Record<string, Uint8Array> {
  const rate = game ? 48000 : 1000, scale = game ? 480 : 1, samples: number[] = []
  for (let frame = 0; frame < 200 * scale; frame++) {
    const phrase = Math.floor(frame / (80 * scale)),
      value = game ? Math.round(12000 * Math.sin(2 * Math.PI * [440, 660, 1100][phrase]! * frame / rate)) / 32768
        : [0.25, 0.5, -0.75][phrase]!
    samples.push(value, -value)
  }
  return { 'routes.wav': wave(samples, rate, 2), 'routes.wav.sli': new TextEncoder().encode(waveResetSli(scale)) }
}
export const waveResetSource = String.raw`
System.exitOnNoWindowStartup=false;
class ResetMusic extends WaveSoundBuffer {
 var seen=[];
 function ResetMusic(){super.WaveSoundBuffer(null);}
 function onLabel(name){seen.add(name);if(seen.count<12)Debug.message("reset-label:"+name);}
}
var resetMusic=new ResetMusic();
function resetFlagText(w){var values=[];for(var i=0;i<16;i++)values.add(w.flags[i]);return values.join(",");}
function resetStart(){resetMusic.open("routes.wav");resetMusic.flags[0]=1;resetMusic.flags[15]=1;resetMusic.seen.clear();resetMusic.play();return resetMusic.status;}
function resetMusicFlags(){resetMusic.flags.reset();return resetFlagText(resetMusic);}
function resetSdk(play){
 var w=void,other=void,result,failed=false,error,cleanup=[];
 try{
  w=new ResetMusic();other=new ResetMusic();w.flags.reset();var empty=resetFlagText(w);
  w.open("routes.wav");other.open("routes.wav");other.flags[0]=73;
  for(var i=0;i<16;i++)w.flags[i]=i+1;
  if(play){w.paused=true;w.play();}
  w.flags.reset();result=empty+"|"+resetFlagText(w)+"|"+other.flags[0]+"|"+w.status+":"+w.paused;
 }catch(e){failed=true;error=e;}
 try{if(w!==void && isvalid w)invalidate w;}catch(e){cleanup.add(e.message);}
 try{if(other!==void && isvalid other)invalidate other;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("reset-sdk-cleanup:"+cleanup.join("|"));throw error;}
 if(cleanup.count)throw new Exception(cleanup.join("|"));return result;
}
function resetMenu(){
 global.resetWindow=new Window();resetWindow.caption="Music branch reset";resetWindow.setInnerSize(240,60);
 var root=new Layer(resetWindow,null);resetWindow.add(root);root.setSize(240,60);root.holdAlpha=false;root.fillRect(0,0,240,60,0xff102030);
 var reset=new Layer(resetWindow,root),restart=new Layer(resetWindow,root),pause=new Layer(resetWindow,root),buttons=[reset,restart,pause];
 for(var i=0;i<3;i++){resetWindow.add(buttons[i]);buttons[i].setPos(i*80,0,76,60);buttons[i].holdAlpha=false;buttons[i].fillRect(0,0,76,60,0xff206040+i*0x101010);buttons[i].visible=true;}
 reset.onClick=function(){global.resetMusicFlags();global.Debug.message("reset-applied");};
 restart.onClick=function(){global.resetStart();global.Debug.message("reset-restarted");};
 pause.onClick=function(){global.resetMusic.paused=!global.resetMusic.paused;global.Debug.message("reset-paused:"+global.resetMusic.paused);};
 resetStart();resetWindow.visible=true;Debug.message("reset-ready");
}
`
const zero = Array<number>(16).fill(0).join(',')
export const waveResetExpected = { 'wave-flags-stopped': `${zero}|${zero}|73|stop:0`, 'wave-flags-paused': `${zero}|${zero}|73|play:1` }
