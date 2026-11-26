import { wave } from './audio.ts'

// Author-defined integer frames. Native mono narrows each channel to i16,
// sums it, and divides toward zero. The four output frames are literal.
export const outputFrames = [[16384, -8192], [1, -2], [-32768, 32767], [32767, 32767]] as const
export const outputMono = [4096, 0, 0, 32767] as const
export function outputWave() {
  return wave(Array.from({ length: 8208 * 2 }, (_, index) => outputFrames[Math.floor(index / 2) % 4]![index % 2]! / 32768), 1000, 2)
}
export function outputFloatWave() {
  const frames = 8208, bytes = new Uint8Array(44 + frames * 2 * 4), view = new DataView(bytes.buffer)
  for (const [at, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const)
    bytes.set(new TextEncoder().encode(text), at)
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true)
  view.setUint16(20, 3, true); view.setUint16(22, 2, true); view.setUint32(24, 1000, true)
  view.setUint32(28, 8000, true); view.setUint16(32, 8, true); view.setUint16(34, 32, true)
  view.setUint32(40, frames * 8, true)
  for (let frame = 0; frame < frames; frame++) {
    view.setFloat32(44 + frame * 8, Math.sin(frame * 2 * Math.PI / 13) * .2, true)
    view.setFloat32(48 + frame * 8, Math.cos(frame * 2 * Math.PI / 11) * .15, true)
  }
  return bytes
}
export function outputS32Wave() {
  const bytes = outputFloatWave(), view = new DataView(bytes.buffer), values = [0x4000ffff, -0x40000001, 0x7fffffff, -1]
  view.setUint16(20, 1, true)
  for (let frame = 0; frame < 8208; frame++) {
    view.setInt32(44 + frame * 8, values[frame % 4]!, true); view.setInt32(48 + frame * 8, 0, true)
  }
  return bytes
}
export const waveOutputFiles = () => ({
  'output.wav': outputWave(), 'output.wav.sli': new TextEncoder().encode("#2.00\nLink {From=4112;To=4096;}\nLabel {Position=4096;Name='loop';}\n"),
  'output-plain.wav': outputWave(), 'output-float.wav': outputFloatWave(), 'output-s32.wav': outputS32Wave(),
})
export function waveOutputGameFiles() {
  const rate = 48000, frames = rate * 4, dual: number[] = [], anti: number[] = []
  for (let frame = 0; frame < frames; frame++) {
    dual.push(Math.round(Math.sin(frame * 2 * Math.PI * 440 / rate) * 8192) / 32768,
      Math.round(Math.sin(frame * 2 * Math.PI * 880 / rate) * 8192) / 32768)
    const value = Math.round(Math.sin(frame * 2 * Math.PI * 660 / rate) * 8192) / 32768
    anti.push(value, -value)
  }
  return { 'output-dual.wav': wave(dual, rate, 2), 'output-anti.wav': wave(anti, rate, 2) }
}

export const waveOutputSource = String.raw`
System.exitOnNoWindowStartup=false;
var outputSound,outputMidi,outputLabels=[];
class OutputWave extends WaveSoundBuffer {
 function OutputWave(){super.WaveSoundBuffer(null);}
 function onLabel(name){global.outputLabels.add(name);}
}
function outputOpen(name){
 if(outputSound!==void){outputSound.stop();invalidate outputSound;}
 global.outputSound=new OutputWave();outputSound.open(name);return [outputSound.bits,outputSound.channels].join(",");
}
function outputPlay(){outputSound.play();return [outputSound.status,outputSound.bits,outputSound.channels].join(",");}
function outputGameAction(action){
 if(action==0){outputSound.open("output-anti.wav");outputSound.play();}
 else if(action==1)outputSound.paused=!outputSound.paused;
 else {
  System.setArgument("-wsforcecnv",System.getArgument("-wsforcecnv")=="i16m"?"i16":"i16m");
  global.outputOpen("output-dual.wav");outputSound.looping=true;outputSound.play();
 }
 Debug.message("output-action:"+action+":"+outputSound.status+":"+outputSound.paused+":"+outputSound.bits+":"+outputSound.channels);
}
function outputMenu(){
 global.outputWindow=new Window();outputWindow.caption="Wave output format";outputWindow.setInnerSize(240,60);
 var root=new Layer(outputWindow,null);outputWindow.add(root);root.setSize(240,60);root.holdAlpha=false;root.fillRect(0,0,240,60,0xff102030);
 for(var i=0;i<3;i++){
  var button=new Layer(outputWindow,root);outputWindow.add(button);button.setPos(i*80,0,78,60);button.holdAlpha=false;
  button.fillRect(0,0,78,60,0xff204060);button.visible=true;button.action=i;
  button.onClick=function(){global.outputGameAction(this.action);};
 }
 global.outputOpen("output-dual.wav");outputSound.looping=true;outputSound.play();outputWindow.visible=true;
 Debug.message("output-ready:"+System.getArgument("-wsforcecnv")+":"+outputSound.bits+":"+outputSound.channels);
}
Debug.message("output-source-ready");
`
