import { wave } from './audio.ts'

// WaveImpl 3026–3069 combines mutevol after voice/global volume. Its fixed
// 25-percent table bucket is -3010 hundredths of dB, not a linear 0.25 gain.
export const waveFocusAttenuation = -3010
export const waveFocusFiles = () => ({
  'focus.wav': wave(Array.from({ length: 32000 * 2 }, (_, at) => at % 2 ? -.25 : .5), 1000, 2),
  'focus.wav.sli': new TextEncoder().encode("#2.00\nLabel {Position=4096;Name='heard';}\nLink {From=6144;To=4096;}\n"),
})
export const waveFocusGameFiles = () => ({
  'focus.wav': wave(Array.from({ length: 48000 * 30 }, (_, at) =>
    Math.round(Math.sin(at * 2 * Math.PI * 750 / 48000) * 16384) / 32768), 48000),
  'focus.wav.sli': new TextEncoder().encode('#2.00\n' + Array.from({ length: 30 }, (_, at) =>
    `Label {Position=${at * 48000};Name='beat';}`).join('\n')),
})
export const waveFocusSource = String.raw`
System.exitOnNoWindowStartup=false;
var focusSound,focusLabels=0;
class FocusWave extends WaveSoundBuffer {
 function FocusWave(){super.WaveSoundBuffer(null);}
 function onLabel(name){global.focusLabels++;}
}
function focusOpen(){
 if(focusSound!==void){focusSound.stop();invalidate focusSound;}
 global.focusSound=new FocusWave();focusSound.open("focus.wav");focusSound.looping=true;focusSound.play();
 return focusSound.status+":"+WaveSoundBuffer.globalFocusMode;
}
function focusReplace(){
 WaveSoundBuffer.globalFocusMode=sgfmNeverMute;
 System.setArgument("-wsmute","never");System.setArgument("-wsmutevol","100");
 global.focusOpen();Debug.message("focus-reopened:"+WaveSoundBuffer.globalFocusMode);
}
function focusToggle(){focusSound.paused=!focusSound.paused;Debug.message("focus-paused:"+int(focusSound.paused));}
function focusMenu(){
 global.focusWindow=new Window();focusWindow.caption="Background music level";focusWindow.setInnerSize(160,60);
 var root=new Layer(focusWindow,null);focusWindow.add(root);root.setSize(160,60);root.holdAlpha=false;root.fillRect(0,0,160,60,0xff182838);
 var again=new Layer(focusWindow,root);focusWindow.add(again);again.setPos(0,0,78,60);again.holdAlpha=false;
 again.fillRect(0,0,78,60,0xff286040);again.visible=true;again.onClick=function(){global.focusReplace();};
 var pause=new Layer(focusWindow,root);focusWindow.add(pause);pause.setPos(80,0,78,60);pause.holdAlpha=false;
 pause.fillRect(0,0,78,60,0xff604028);pause.visible=true;pause.onClick=function(){global.focusToggle();};
 global.focusOpen();focusWindow.visible=true;
 Debug.message("focus-ready:"+WaveSoundBuffer.globalFocusMode+":"+System.getArgument("-wsmute")+":"+System.getArgument("-wsmutevol"));
}
Debug.message("focus-source-ready");
`
