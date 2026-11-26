import { wave } from './audio.ts'

export const waveRiffNames = ['riff-zero.wav', 'riff-short.wav', 'riff-long.wav', 'riff-first.wav', 'riff-unpadded.wav', 'riff-padded.wav'] as const
const concat = (...parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((n, value) => n + value.length, 0))
  let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length } return bytes
}
function chunk(name: string, data: Uint8Array) {
  const header = new Uint8Array(8); header.set(new TextEncoder().encode(name))
  new DataView(header.buffer).setUint32(4, data.length, true); return concat(header, data)
}
export const waveRiffPcm = Array.from({ length: 60 }, (_, i) => [.25, .5, .75][Math.floor(i / 20)]!)
export function waveRiffFiles(game = false): Record<string, Uint8Array> {
  const rate = game ? 48000 : 1000, frames = game ? 96000 : 60,
    samples = Array.from({ length: frames }, (_, frame) => game
      ? Math.round(12000 * Math.sin(2 * Math.PI * 440 * frame / rate)) / 32768 : waveRiffPcm[frame]!),
    good = wave(samples.flatMap((value) => [value, -value]), rate, 2),
    alternate = wave(Array.from({ length: frames }, (_, frame) => game
      ? Math.round(12000 * Math.sin(2 * Math.PI * 660 * frame / rate)) / 32768 : -.75).flatMap((value) => [value, value]), rate * 2, 2),
    files: Record<string, Uint8Array> = {}, header = good.slice(0, 12)
  const wrap = (...parts: Uint8Array[]) => {
    const bytes = concat(header, ...parts); new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true); return bytes
  }
  for (const [name, declared] of [['riff-zero.wav', 0], ['riff-short.wav', 4], ['riff-long.wav', 0xffffffff]] as const) {
    const bytes = good.slice(); new DataView(bytes.buffer).setUint32(4, declared, true); files[name] = bytes
  }
  // The first data before fmt is skipped. Once fmt was found, later fmt/data
  // are not substitutions for the first selected pair.
  files['riff-first.wav'] = wrap(alternate.subarray(36), good.subarray(12, 36), good.subarray(36), alternate.subarray(12))
  // TVPFindRIFFChunk uses the author's declared skip exactly, without the
  // standard RIFF pad. All chunks and both selected PCM planes are complete.
  files['riff-unpadded.wav'] = wrap(chunk('JUNK', new Uint8Array([1, 2, 3])), good.subarray(12))
  // Existing Web-standard compatibility is retained by the fallback, not
  // attributed to TVPFindRIFFChunk. The original unpadded pass still wins.
  files['riff-padded.wav'] = wrap(chunk('JUNK', new Uint8Array([1, 2, 3])), new Uint8Array(1), good.subarray(12))
  const to = game ? 48000 : 20, from = frames, encode = new TextEncoder()
  for (const name of waveRiffNames) files[name + '.sli'] = encode.encode(`#2.00\nLink {From=${from};To=${to};Smooth=False;Condition=eq;CondVar=0;RefValue=0;}\nLabel {Position=0;Name='head';}\nLabel {Position=${to};Name='loop';}\nLabel {Position=${from};Name='tail';}\n`)
  return files
}
export const waveRiffSource = String.raw`
System.exitOnNoWindowStartup=false;
var riffNames=["riff-zero.wav","riff-short.wav","riff-long.wav","riff-first.wav","riff-unpadded.wav","riff-padded.wav"],riffIndex=0;
class RiffMusic extends WaveSoundBuffer {
 var seen=[];
 function RiffMusic(){super.WaveSoundBuffer(null);}
 function onLabel(name){seen.add(name);if(seen.count<12)Debug.message("riff-label:"+name);}
}
var riffMusic=new RiffMusic();
function riffStart(name){riffMusic.open(name);riffMusic.seen.clear();riffMusic.play();return riffMusic.status;}
function riffSdk(name,play=false){
 var w=void,result,failed=false,error;
 try{w=new RiffMusic();w.open(name);
  if(play){w.paused=true;w.play();result=[w.status,w.frequency,w.bits,w.channels,w.totalTime,w.labels.tail.samplePosition].join("|");}
  else result=[w.status,w.frequency,w.labels.head.samplePosition,w.labels.loop.samplePosition,w.labels.tail.samplePosition].join("|");
 }catch(e){failed=true;error=e;}
 try{if(w!==void && isvalid w)invalidate w;}catch(e){if(failed)Debug.message("riff-cleanup:"+e.message);else throw e;}
 if(failed)throw error;return result;
}
function riffMenu(){
 global.riffWindow=new Window();riffWindow.caption="Legacy WAVE recordings";riffWindow.setInnerSize(320,60);
 var root=new Layer(riffWindow,null);riffWindow.add(root);root.setSize(320,60);root.holdAlpha=false;root.fillRect(0,0,320,60,0xff102030);
 var next=new Layer(riffWindow,root),seek=new Layer(riffWindow,root),pause=new Layer(riffWindow,root),finish=new Layer(riffWindow,root),buttons=[next,seek,pause,finish];
 for(var i=0;i<4;i++){riffWindow.add(buttons[i]);buttons[i].setPos(i*80,0,76,60);buttons[i].holdAlpha=false;buttons[i].fillRect(0,0,76,60,0xff206040+i*0x101010);buttons[i].visible=true;}
 next.onClick=function(){global.riffIndex=(global.riffIndex+1)%6;global.riffStart(global.riffNames[global.riffIndex]);global.Debug.message("riff-track:"+global.riffIndex);};
 seek.onClick=function(){global.riffMusic.samplePosition=60000;global.Debug.message("riff-seek");};
 pause.onClick=function(){global.riffMusic.paused=!global.riffMusic.paused;global.Debug.message("riff-pause:"+global.riffMusic.paused);};
 finish.onClick=function(){global.riffMusic.flags[0]=1;global.Debug.message("riff-finish");};
 riffStart(riffNames[0]);riffWindow.visible=true;Debug.message("riff-track:0");
}
`
export const waveRiffSdkExpected = Object.fromEntries([
  ...waveRiffNames.filter((name) => name !== 'riff-padded.wav').map((name) => ['wave-' + name, 'stop|1000|0|20|60']),
  ['wave-riff-play', 'play|1000|16|2|60|60'],
])
