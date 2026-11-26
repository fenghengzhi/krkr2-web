import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const longVorbisRate = 48000, longVorbisSamples = 96 * longVorbisRate,
  longVorbisLoopStart = 84 * longVorbisRate, longVorbisLoopEnd = 86 * longVorbisRate
export function longVorbisBytes(): Uint8Array {
  const directory = resolve('out/verification/long-vorbis'),
    reference = JSON.parse(readFileSync(resolve(directory, 'reference.json'), 'utf8')),
    bytes = new Uint8Array(readFileSync(resolve(directory, 'long-bgm.ogg')))
  if (reference.complete !== true || reference.rate !== longVorbisRate || reference.samples !== longVorbisSamples ||
      bytes.length !== reference.bytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256)
    throw new Error('Long Vorbis fixture differs from its hosted encoder record')
  return bytes
}
export function longVorbisFiles(): Record<string, Uint8Array> {
  const bytes = longVorbisBytes()
  // Stock GetEntityToken quotes text only with apostrophes. Double quotes
  // would become part of the name and never match the game's "late" hook.
  return { 'long-bgm.ogg': bytes, 'loop-bgm.ogg': bytes,
    'loop-bgm.ogg.sli': new TextEncoder().encode(`#2.00\nLink {From=${longVorbisLoopEnd};To=${longVorbisLoopStart};Smooth=False;}\nLabel {Position=${longVorbisLoopStart};Name='late';}\n`) }
}
export const longVorbisSource = String.raw`
System.exitOnNoWindowStartup=false;
var longProgress;
class LongMusic extends WaveSoundBuffer {
 var labels=[],lateCount=0;
 function LongMusic(){super.WaveSoundBuffer(null);}
 function onLabel(name){
  labels.add(name);
  if(name=="late"){
   lateCount++;
   if(global.longProgress!==void){
    global.longProgress.fillRect(0,0,400,32,lateCount==1?0xff406080:0xff208040);
    global.longProgress.drawText(8,6,"Music phrase "+lateCount,0xffffff,255,true);
   }
  }
  Debug.message("long-label:"+name+":"+labels.count);
 }
}
var longMusic=new LongMusic();
function longStart(loop=false){longMusic.open(loop?"loop-bgm.ogg":"long-bgm.ogg");longMusic.play();return longMusic.status;}
function longSeek(frame){longMusic.samplePosition=frame;return longMusic.samplePosition;}
function longMenu(){
 global.longWindow=new Window();longWindow.caption="Long Ogg music";longWindow.setInnerSize(400,100);
 var root=new Layer(longWindow,null);longWindow.add(root);root.setSize(400,100);root.holdAlpha=false;root.fillRect(0,0,400,100,0xff102030);
 global.longProgress=new Layer(longWindow,root);longWindow.add(longProgress);longProgress.setPos(0,64,400,32);
 longProgress.holdAlpha=false;longProgress.fillRect(0,0,400,32,0xff102030);longProgress.visible=true;
 var far=new Layer(longWindow,root),back=new Layer(longWindow,root),loop=new Layer(longWindow,root),pause=new Layer(longWindow,root),edge=new Layer(longWindow,root);
 var buttons=[far,back,loop,pause,edge];for(var i=0;i<5;i++){longWindow.add(buttons[i]);buttons[i].setPos(i*80,0,76,60);buttons[i].holdAlpha=false;buttons[i].fillRect(0,0,76,60,0xff206040+i*0x101010);buttons[i].visible=true;}
 far.onClick=function(){global.longSeek(4080000);global.Debug.message("long-far");};
 back.onClick=function(){global.longSeek(2304000);global.Debug.message("long-back");};
 loop.onClick=function(){global.longStart(true);global.longSeek(4032000);global.Debug.message("long-loop");};
 pause.onClick=function(){global.longMusic.paused=!global.longMusic.paused;global.Debug.message("long-pause:"+global.longMusic.paused);};
 edge.onClick=function(){global.longSeek(192007);global.Debug.message("long-page-edge");};
 longStart();longWindow.visible=true;Debug.message("long-ready");
}
`
