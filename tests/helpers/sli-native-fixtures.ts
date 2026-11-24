import { wave } from './audio.ts'

// Native syntax, hand-authored expected labels/flags. No parser or mixer is
// used to produce these expectations. All links are inside the actual PCM.
export const sliNativeText = String.raw`#2.00
# Equal-position unconditional and lower-flag alternatives are deliberately first.
Link {From=200;To=800;Smooth=No;Condition=no;CondVar=0;RefValue=0;}
Link {From=200;To=600;Smooth=False;Condition=eq;CondVar=0;RefValue=0;}
Link {From=200;To=400;Smooth=No;Condition=eq;CondVar=1;RefValue=1;}
Label {Position=0;Name='start';}
Label {Position=10;Name="quoted";}
Label {Position=20;Name=':[0]++5';}
Label {Position=21;Name=':[0]--[1]';}
Label {Position=22;Name=':[0]=-3';}
Label {Position=23;Name=':[2]=7';}
Label {Position=24;Name=':[0]+=[2]';}
Label {Position=25;Name=':[0]-=2';}
Label {Position=26;Name=':[3]++';}
Label {Position=27;Name=':[3]--99';}
Label {Position=28;Name=':[3]+=10005';}
Label {Position=29;Name=':[3]++';}
Label {Position=30;Name=':[4]=1';}
Label {Position=31;Name=':[4]-=9';}
Label {Position=40;Name='path\tone';}
Label {Position=41;Name='日本語';}
Label {Position=300;Name='skipped';}
Label {Position=400;Name='selected';}
Label {Position=800;Name='later';}
`
export const sliNativeLabels = [
  'start', '"quoted"', ':[0]++5', ':[0]--[1]', ':[0]=-3', ':[2]=7', ':[0]+=[2]', ':[0]-=2',
  ':[3]++', ':[3]--99', ':[3]+=10005', ':[3]++', ':[4]=1', ':[4]-=9', 'path\\tone', '日本語', 'selected', 'later',
] as const
export const sliNativeFlags = [5, 1, 7, 9999, 0] as const
export const sliInvalidNames = ['bad-smooth.wav', 'bad-field.wav', 'bad-condition.wav', 'bad-utf8.wav'] as const
export function sliNativeFiles(): Record<string, Uint8Array> {
  const pcm = wave(Array<number>(1000).fill(0.25), 1000), utf8 = new TextEncoder(),
    encode = (text: string) => utf8.encode(text), badUtf8 = [
      ...encode("#2.00\nLabel {Position=0;Name='"), 0xff, ...encode("';}"),
    ]
  return {
    'native.wav': pcm, 'native.wav.sli': encode(sliNativeText),
    'bad-smooth.wav': pcm, 'bad-smooth.wav.sli': encode('#2.00\nLink {From=1;To=0;Smooth=Maybe;}'),
    'bad-field.wav': pcm, 'bad-field.wav.sli': encode('#2.00\nLabel {Position=0;Unknown=1;}'),
    'bad-condition.wav': pcm, 'bad-condition.wav.sli': encode('#2.00\nLink {From=1;To=0;Condition=bad;}'),
    'bad-utf8.wav': pcm, 'bad-utf8.wav.sli': Uint8Array.from(badUtf8),
  }
}
export const sliNativeSource = String.raw`
System.exitOnNoWindowStartup=false;
var sliLabels=[],sliStarted=false;
class SliSound extends WaveSoundBuffer {
  function SliSound(){super.WaveSoundBuffer(null);}
  function onLabel(name){global.sliLabels.add(name);global.Debug.message("sli-label:"+name);}
  function onStatusChanged(status){
    global.Debug.message("sli-status:"+status);
    if(status=="stop" && global.sliStarted){global.sliStarted=false;global.Debug.message("sli-finished:"+global.sliFlagText());}
  }
}
var sliSound=new SliSound();
function sliTryOpen(name){try{global.sliSound.open(name);return "open";}catch(error){return error.message;}}
function sliBegin(){
  global.sliLabels.clear();global.sliSound.open("native.wav");global.sliSound.flags[1]=1;global.sliStarted=true;global.sliSound.play();return 0;
}
function sliFlagText(){var f=global.sliSound.flags;return [f[0],f[1],f[2],f[3],f[4]].join(",");}
Debug.message("sli-ready");
`
