import { speakerWave } from './wave-speakers.ts'

// Independent PCM rows; duplication is WaveImpl.cpp:1334/1352. The final
// stereo coefficient is the existing Web policy, not a Windows device claim.
export const quadRows = [[.125, -.25], [.25, -.125], [.375, 0], [.5, .125],
  [-.125, .25], [-.25, .125], [-.375, 0], [-.5, -.125]] as const
export const quadGain = 1 + 0.70710678
export const quadFiles = () => ({
  'quad-stereo.wav': speakerWave(quadRows, { frames: 8208 }),
  'quad-mono.wav': speakerWave(quadRows.map((row) => [row[0]]), { frames: 8208 }),
  'quad-masked.wav': speakerWave(quadRows, { frames: 8208, mask: 3 }),
  'quad-stereo.wav.sli': new TextEncoder().encode("#2.00\nLink {From=8200;To=8184;}\nLabel {Position=8192;Name='phrase';}"),
})
export function quadGameFiles() {
  const rate = 48000, frames = rate / 5,
    stereo = Array.from({ length: frames }, (_, frame) => [
      Math.round(Math.sin(frame * 2 * Math.PI * 440 / rate) * 8192) / 32768,
      Math.round(Math.sin(frame * 2 * Math.PI * 880 / rate) * 4096) / 32768]),
    labels = new TextEncoder().encode("#2.00\nLabel {Position=80;Name='phrase';}")
  return { 'quad-stereo.wav': speakerWave(stereo, { rate }),
    'quad-mono.wav': speakerWave(stereo.map((row) => [row[0]! / 2]), { rate }),
    'quad-masked.wav': speakerWave(stereo, { rate, mask: 3 }),
    'quad-stereo.wav.sli': labels, 'quad-mono.wav.sli': labels, 'quad-masked.wav.sli': labels }
}

export const quadSource = String.raw`
System.exitOnNoWindowStartup=false;
var quadMusic,quadWindow,quadStage=0,quadPauses=0;
class QuadWave extends WaveSoundBuffer {
 var phrases=0;
 function QuadWave(){super.WaveSoundBuffer(null);}
 function onLabel(name){if(name=="phrase"){phrases++;if(phrases==2)global.Debug.message("quad-loop:"+global.quadStage);}}
}
function quadOpen(name,fresh=false){
 if(fresh && quadMusic!==void){quadMusic.stop();invalidate quadMusic;quadMusic=void;}
 if(quadMusic===void)quadMusic=new QuadWave();
 quadMusic.open(name);quadMusic.phrases=0;return [quadMusic.bits,quadMusic.channels].join(",");
}
function quadPlay(){quadMusic.play();return [quadMusic.status,quadMusic.bits,quadMusic.channels].join(",");}
function quadNext(){
 quadStage++;
 if(quadStage==3)System.setArgument("-wsexpandquad","no");
 quadOpen(quadStage==1?"quad-mono.wav":quadStage==2?"quad-masked.wav":"quad-stereo.wav",quadStage==3);
 quadMusic.looping=true;quadPlay();Debug.message("quad-stage:"+quadStage+":"+quadMusic.channels);
}
function quadMenu(){
 quadWindow=new Window();quadWindow.caption="Four speaker music";quadWindow.setInnerSize(240,60);
 var root=new Layer(quadWindow,null);quadWindow.add(root);root.holdAlpha=false;root.setSize(240,60);root.fillRect(0,0,240,60,0xff102030);
 for(var i=0;i<3;i++){
  var button=new Layer(quadWindow,root);quadWindow.add(button);button.holdAlpha=false;button.setPos(i*80,0,78,60);
  button.fillRect(0,0,78,60,[0xff208040,0xff805020,0xff404080][i]);button.visible=true;
  if(i==0)button.onClick=function(){global.quadNext();};
  else if(i==1)button.onClick=function(){global.quadMusic.paused=!global.quadMusic.paused;global.quadPauses++;global.Debug.message("quad-pause:"+global.quadPauses+":"+global.quadMusic.paused);};
  else button.onClick=function(){global.quadMusic.stop();global.Debug.message("quad-stopped:"+global.quadMusic.samplePosition);};
 }
 quadOpen("quad-stereo.wav");quadMusic.looping=true;quadPlay();quadWindow.visible=true;
 Debug.message("quad-ready:"+System.getArgument("-wsexpandquad")+":"+quadMusic.channels);
}
`
