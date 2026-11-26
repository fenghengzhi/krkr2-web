import { speakerWave } from './wave-speakers.ts'

export const spatialRows = [[.125, .375], [.25, .5], [-.125, -.375], [-.25, -.5]] as const
export function spatialFiles() {
  return { 'spatial-mono.wav': speakerWave(spatialRows.map((row) => [row[0]]), { frames: 8208 }),
    'spatial-stereo.wav': speakerWave(spatialRows, { frames: 8208 }),
    'spatial-masked.wav': speakerWave(spatialRows, { frames: 8208, mask: 3 }),
    'spatial-mono.wav.sli': new TextEncoder().encode("#2.00\nLink {From=8200;To=8184;}\nLabel {Position=8192;Name='phrase';}"),
    'spatial-stereo.wav.sli': new TextEncoder().encode("#2.00\nLink {From=8200;To=8184;}\nLabel {Position=8192;Name='phrase';}") }
}
export function spatialGameFiles() {
  const rate = 48000, stereo = Array.from({ length: 9600 }, (_, frame) => [
    Math.round(Math.sin(frame * 2 * Math.PI * 440 / rate) * 8192) / 32768,
    Math.round(Math.sin(frame * 2 * Math.PI * 880 / rate) * 4096) / 32768]),
    sli = new TextEncoder().encode("#2.00\nLabel {Position=80;Name='phrase';}")
  return { 'spatial-mono.wav': speakerWave(stereo.map((row) => [row[0]!]), { rate }),
    'spatial-stereo.wav': speakerWave(stereo, { rate }),
    'spatial-masked.wav': speakerWave(stereo, { rate, mask: 3 }),
    'spatial-mono.wav.sli': sli, 'spatial-stereo.wav.sli': sli, 'spatial-masked.wav.sli': sli }
}

export const spatialSource = String.raw`
System.exitOnNoWindowStartup=false;
var spatialMusic,spatialWindow,spatialStage=0,spatialPauses=0;
class SpatialWave extends WaveSoundBuffer {
 var phrases=0;
 function SpatialWave(){super.WaveSoundBuffer(null);}
 function onLabel(name){if(name=="phrase")phrases++;}
}
function spatialOpen(name){
 if(spatialMusic===void)spatialMusic=new SpatialWave();
 spatialMusic.open(name);spatialMusic.looping=true;
}
function spatialNext(){
 spatialStage++;
 if(spatialStage==1)spatialMusic.posX=1;
 else if(spatialStage==2)spatialMusic.setPos(0,0,1);
 else if(spatialStage==3)spatialMusic.posZ=4;
 else if(spatialStage==4){spatialMusic.posZ=0;spatialMusic.posY=2;}
 else if(spatialStage==5){System.setArgument("-wsuse3d","no");spatialOpen("spatial-stereo.wav");spatialMusic.setPos(-1,0,0);spatialMusic.play();}
 else if(spatialStage==6){spatialOpen("spatial-masked.wav");spatialMusic.setPos(-4,0,0);spatialMusic.play();}
 Debug.message("spatial-stage:"+spatialStage);
}
function spatialMenu(){
 spatialWindow=new Window();spatialWindow.caption="Spatial sound";spatialWindow.setInnerSize(240,60);
 var root=new Layer(spatialWindow,null);spatialWindow.add(root);root.holdAlpha=false;root.setSize(240,60);root.fillRect(0,0,240,60,0xff102030);
 for(var i=0;i<3;i++){
  var button=new Layer(spatialWindow,root);spatialWindow.add(button);button.holdAlpha=false;button.setPos(i*80,0,78,60);
  button.fillRect(0,0,78,60,[0xff208040,0xff805020,0xff404080][i]);button.visible=true;
  if(i==0)button.onClick=function(){global.spatialNext();};
  else if(i==1)button.onClick=function(){global.spatialMusic.paused=!global.spatialMusic.paused;global.spatialPauses++;global.Debug.message("spatial-pause:"+global.spatialPauses+":"+global.spatialMusic.paused);};
  else button.onClick=function(){global.spatialMusic.stop();global.Debug.message("spatial-stopped:"+global.spatialMusic.samplePosition);};
 }
 spatialOpen("spatial-mono.wav");spatialMusic.setPos(-1,0,0);spatialMusic.play();spatialWindow.visible=true;
 Debug.message("spatial-ready:"+System.getArgument("-wsuse3d"));
}
`
