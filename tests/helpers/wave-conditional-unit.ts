import { wave } from './audio.ts'

/** At 8 kHz the native 8 Hz Decode request is 1000 source frames. Flag 0
 * initially disables the 400->1200 link; the first request selects 800->0
 * before evaluating the label at 100. Therefore it must include 400..799. */
export const conditionalSli = `#2.00
Link {From=400;To=1200;Condition=eq;CondVar=0;RefValue=1;}
Link {From=800;To=0;}
Link {From=1600;To=0;}
Label {Position=100;Name=':[0]=1';}
Label {Position=400;Name='middle';}
Label {Position=1200;Name='next';}
`
export const conditionalFiles = () => ({
  'conditional.wav': wave(Array.from({ length: 32000 * 2 }, (_, at) => {
    const frame = Math.floor(at / 2), value = frame < 400 ? .125 : frame < 800 ? .25 : frame < 1200 ? .375 : .5
    return at % 2 ? -value / 2 : value
  }), 8000, 2),
  'conditional.wav.sli': new TextEncoder().encode(conditionalSli),
})
export function conditionalGameFiles() {
  const rate = 8000, frames = 32000, samples: number[] = []
  for (let at = 0; at < frames; at++) {
    const frequency = at < 400 ? 400 : at < 800 ? 800 : at < 1200 ? 1000 : 1200,
      sample = Math.round(Math.sin(at * 2 * Math.PI * frequency / rate) * 4096) / 16384
    samples.push(sample, -sample / 2)
  }
  return { 'conditional.wav': wave(samples, rate, 2), 'conditional.wav.sli': new TextEncoder().encode(conditionalSli) }
}
export const conditionalSdkExpected = 'middle|1|play'
export const conditionalSource = String.raw`
System.exitOnNoWindowStartup=false;
var branchMusic,branchWindow,branchPanel,branchSerial=0;
class ConditionalMusic extends WaveSoundBuffer {
 var first="",journal=[];
 function ConditionalMusic(){super.WaveSoundBuffer(null);}
 function onLabel(name){
  if(name!="middle" && name!="next")return;
  journal.add(name);
  if(first==""){
   first=name;
   if(global.branchPanel!==void && isvalid global.branchPanel)
    global.branchPanel.fillRect(0,0,240,30,name=="middle"?0xff208040:0xff804020);
   global.Debug.message("branch-choice:"+global.branchSerial+":"+name);
  }
 }
}
function branchClose(){if(branchMusic!==void && isvalid branchMusic)invalidate branchMusic;branchMusic=void;}
function branchStart(paused=false){
 branchClose();branchMusic=new ConditionalMusic();branchMusic.open("conditional.wav");
 branchMusic.flags[0]=0;branchMusic.paused=paused;branchMusic.play();return branchMusic.status;
}
function branchRestart(flag){
 branchMusic.paused=true;branchMusic.flags[0]=flag;branchMusic.samplePosition=0;
 branchMusic.first="";branchMusic.journal.clear();branchSerial++;branchMusic.paused=false;
 Debug.message("branch-restart:"+branchSerial+":"+flag);
}
function branchMenu(){
 branchStart(true);branchWindow=new Window();branchWindow.caption="Conditional music phrases";branchWindow.setInnerSize(240,90);branchWindow.visible=true;
 var root=new Layer(branchWindow,null);branchWindow.add(root);root.holdAlpha=false;root.setSize(240,90);root.fillRect(0,0,240,90,0xff202020);
 branchPanel=new Layer(branchWindow,root);branchWindow.add(branchPanel);branchPanel.holdAlpha=false;branchPanel.setPos(0,60,240,30);branchPanel.fillRect(0,0,240,30,0xff404060);branchPanel.visible=true;
 for(var i=0;i<4;i++){
  var button=new Layer(branchWindow,root);branchWindow.add(button);button.holdAlpha=false;button.setPos(i*60,0,58,60);
  button.fillRect(0,0,58,60,[0xff208040,0xff805020,0xff406080,0xff804060][i]);button.visible=true;
  if(i==0)button.onClick=function(){global.branchMusic.paused=false;global.Debug.message("branch-playing:"+global.branchSerial);};
  else if(i==1)button.onClick=function(){global.branchMusic.paused=true;global.Debug.message("branch-paused:"+global.branchSerial);};
  else if(i==2)button.onClick=function(){global.branchRestart(0);};
  else button.onClick=function(){global.branchRestart(1);};
 }
 branchWindow.onKeyDown=function(key,shift){if(key==27){global.branchMusic.stop();global.Debug.message("branch-stopped");}};
 Debug.message("branch-ready");
}
var branchSdkTimer,branchSdkTicks=0,branchAfter;
function branchSdkFinish(result){
 if(branchSdkTimer!==void && isvalid branchSdkTimer){branchSdkTimer.enabled=false;invalidate branchSdkTimer;}branchSdkTimer=void;
 try{branchClose();}catch(e){result+="|cleanup:"+e.message;}
 branchAfter(result);
}
function branchSdkTick(){
 try{
  if(branchMusic.first!=""){branchSdkFinish(branchMusic.first+"|"+branchMusic.flags[0]+"|"+branchMusic.status);return;}
  if(++branchSdkTicks>200)branchSdkFinish("unexpected-error:Conditional music label timed out");
 }catch(e){branchSdkFinish("unexpected-error:"+e.message);}
}
function branchSdkStart(){
 branchSdkTicks=0;branchSdkTimer=new Timer(global,"branchSdkTick");branchSdkTimer.interval=20;branchSdkTimer.enabled=true;
 try{branchStart();}catch(e){branchSdkFinish("unexpected-error:"+e.message);}
}
`
