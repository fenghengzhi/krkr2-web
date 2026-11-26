import { speakerWave } from './wave-speakers.ts'

/** Authored physical planes, in Microsoft WAVEFORMATEXTENSIBLE bit order.
 * Stereo numbers state the Web policy explicitly; they are not measurements
 * of a Windows driver's downmix. The FFmpeg controls resolve channel NAMES
 * from these real headers, independently of the product's mask decoder. */
export const waveMaskCases = [
  { name: 'surround-center', mask: 0x107, row: [0, 0, .5, 0], stereo: [.35355339, .35355339], pan: ['0.70710678*FC', '0.70710678*FC'] },
  { name: 'surround-back-center', mask: 0x107, row: [0, 0, 0, .5], stereo: [.25, .25], pan: ['0.5*BC', '0.5*BC'] },
  { name: 'quad-back-left', mask: 0x33, row: [0, 0, .5, 0], stereo: [.35355339, 0], pan: ['0.70710678*BL', '0*FL'] },
  { name: 'two-one-lfe', mask: 0xb, row: [0, 0, .5], stereo: [0, 0], pan: ['0*LFE', '0*LFE'] },
  { name: 'three-front-center', mask: 0x7, row: [0, 0, .5], stereo: [.35355339, .35355339], pan: ['0.70710678*FC', '0.70710678*FC'] },
  { name: 'five-back-right', mask: 0x37, row: [0, 0, 0, 0, .5], stereo: [0, .35355339], pan: ['0*FL', '0.70710678*BR'] },
  { name: 'five-side-right', mask: 0x607, row: [0, 0, 0, 0, .5], stereo: [0, .35355339], pan: ['0*FL', '0.70710678*SR'] },
  { name: 'six-side-left', mask: 0x60f, row: [0, 0, 0, 0, .5, 0], stereo: [.35355339, 0], pan: ['0.70710678*SL', '0*FL'] },
  { name: 'seven-one-side-left', mask: 0x63f, row: [0, 0, 0, 0, 0, 0, .5, 0], stereo: [.25, 0], pan: ['0.5*SL', '0*FL'] },
  { name: 'seven-one-wide-left', mask: 0xff, row: [0, 0, 0, 0, 0, 0, .5, 0], stereo: [.5, 0], pan: ['FLC', '0*FL'] },
] as const

export function waveMaskFiles(): Record<string, Uint8Array> {
  return { ...Object.fromEntries(waveMaskCases.map((entry) => [`mask-${entry.name}.wav`,
    speakerWave(Array.from({ length: 8 }, (_, frame) => entry.row.map((value) => frame < 4 ? value : -value)),
      { mask: entry.mask, frames: 32000, rate: 8000 })])),
    // An independently authored two-period phrase straddles the 8192 page.
    'mask-surround-center.wav.sli': new TextEncoder().encode("#2.00\nLink { From=8200; To=8184; Smooth=false; }\nLabel { Position=8192; Name='phrase'; }\n") }
}

export const waveMaskSdkNames = ['surround-center', 'two-one-lfe', 'five-back-right', 'seven-one-wide-left'] as const
// Cold native open establishes InputFormat, but the output Format is only
// established by play. In particular totalTime must not be read before play.
export const waveMaskSdkExpected = Object.fromEntries(waveMaskSdkNames.map((name) =>
  [`wave-mask-${name}`, 'stop|8000']))
export const waveMaskSdkSource = String.raw`
function maskSdk(name){
 var sound=new WaveSoundBuffer(null),result;
 try{sound.open(name);result=[sound.status,sound.frequency].join("|");}
 catch(e){invalidate sound;throw e;}
 invalidate sound;return result;
}
`

export const waveMaskSource = String.raw`
System.exitOnNoWindowStartup=false;
class MaskMusic extends WaveSoundBuffer {
 function MaskMusic(){super.WaveSoundBuffer(null);}
 function onLabel(name){if(name=="phrase")global.maskLabels++;}
}
var maskMusic=new MaskMusic(),maskLabels=0,maskSelection=-1;
var maskNames=${JSON.stringify(waveMaskCases.map((entry) => entry.name))};
function maskOpen(index){
 maskMusic.open("mask-"+maskNames[index]+".wav");maskMusic.looping=true;maskMusic.play();
 return maskMusic.channels+"|"+maskMusic.status;
}
function maskNext(){
 global.maskSelection++;if(maskSelection>=maskNames.count)global.maskSelection=0;
 maskOpen(maskSelection);Debug.message("mask-selected:"+maskSelection+":"+maskNames[maskSelection]);
}
function maskMenu(){
 global.maskWindow=new Window();maskWindow.caption="Surround music";maskWindow.setInnerSize(240,60);
 var root=new Layer(maskWindow,null);maskWindow.add(root);root.setSize(240,60);root.holdAlpha=false;root.fillRect(0,0,240,60,0xff102030);
 var next=new Layer(maskWindow,root),pause=new Layer(maskWindow,root),seek=new Layer(maskWindow,root);
 maskWindow.add(next);maskWindow.add(pause);maskWindow.add(seek);
 next.setPos(0,0,76,60);pause.setPos(80,0,76,60);seek.setPos(160,0,76,60);
 next.holdAlpha=pause.holdAlpha=seek.holdAlpha=false;
 next.fillRect(0,0,76,60,0xff208060);pause.fillRect(0,0,76,60,0xff406080);seek.fillRect(0,0,76,60,0xff805030);
 next.visible=pause.visible=seek.visible=true;
 next.onClick=function(){global.maskNext();};
 pause.onClick=function(){global.maskMusic.paused=!global.maskMusic.paused;global.Debug.message("mask-paused:"+global.maskMusic.paused);};
 seek.onClick=function(){global.maskMusic.samplePosition=8188;global.Debug.message("mask-seek:"+global.maskSelection);};
 maskWindow.visible=true;Debug.message("mask-menu-ready");
}
Debug.message("mask-source-ready");
`
