export const videoPeriodCases = [
  ['past-time', '0:6:'],
  ['frame-equal', '1:-1:1'],
  ['future-time', '1:-1:1'],
  ['same-future', '1:-1:1'],
  ['same-past', '0:6:'],
  ['zero-rewind', '1:-1:1'],
  ['consumed', '0:-1:'],
  ['close-past', '0:6:'],
  ['closed-future', '1:-1:1'],
  ['whole-loop', '1:-1:0,1'],
  ['segment', '1:-1:3,1'],
  ['negative-segment-start', '1:-1:3,1'],
  ['segment-end-after-movie', '1:-1:1'],
  ['inactive-segment', '1:-1:1'],
] as const

/** One real game button advances the scenario. The movie's own frame callback
 * ends a no-cue case; no wall-clock sleep is used to infer a missing event. */
export const videoPeriodSource = String.raw`
var cueWindow=new Window();cueWindow.caption="Movie cues";cueWindow.setInnerSize(112,72);cueWindow.visible=true;
var cueRoot=new Layer(cueWindow,null);cueRoot.setSize(112,72);cueRoot.fillRect(0,0,112,72,0xff102030);
var cueImage=new Layer(cueWindow,cueRoot);cueImage.visible=true;
var cueMarker=new Layer(cueWindow,cueRoot);cueMarker.setPos(80,0,16,16);cueMarker.fillRect(0,0,16,16,0xff000000);cueMarker.visible=true;
var cueButton=new Layer(cueWindow,cueRoot);cueButton.setPos(0,52,100,16);cueButton.fillRect(0,0,100,16,0xff408060);cueButton.visible=true;
var cueIndex=0,cueActive=false,cueCount=0,cueReasons=[],cueName="",cueNegative=false;
function cueFinish(){
 if(!cueActive)return;
 cueActive=false;cueMovie.pause();
 cueMarker.fillRect(0,0,16,16,cueCount?0xff00ff00:0xff000000);cueMarker.update();cueWindow.update();
 Debug.message("cue-done:"+cueName+":"+cueCount+":"+cueMovie.periodEventFrame+":"+cueReasons.join(","));
}
class CueMovie extends VideoOverlay {
 function CueMovie(w){super.VideoOverlay(w);}
 function onFrameUpdate(frame){if(global.cueActive && global.cueNegative && frame>=14)global.cueFinish();}
 function onPeriod(reason){
  if(!global.cueActive)return;
  global.cueReasons.add(reason);
  if(reason==1){global.cueCount++;global.cueFinish();}
 }
}
var cueMovie=new CueMovie(cueWindow);cueMovie.mode=vomLayer;cueMovie.layer1=cueImage;
cueMovie.open("colors.mp4");cueMovie.pause();cueMovie.visible=true;
function cueNext(){
 if(cueActive || cueIndex>=${videoPeriodCases.length})return;
 cueCount=0;cueReasons.clear();cueMovie.pause();cueMovie.loop=false;cueMovie.cancelSegmentLoop();
 cueMarker.fillRect(0,0,16,16,0xff000000);cueMarker.update();
 // The consumed control deliberately retains the previous one-shot result.
 if(cueIndex!=6)cueMovie.cancelPeriodEvent();
 cueNegative=false;
 switch(cueIndex){
  case 0:cueName="past-time";cueMovie.frame=12;cueMovie.setPeriodEvent(6);cueMovie.position=0;cueNegative=true;break;
  case 1:cueName="frame-equal";cueMovie.frame=12;cueMovie.setPeriodEvent(6);cueMovie.frame=6;break;
  case 2:cueName="future-time";cueMovie.frame=0;cueMovie.setPeriodEvent(6);cueMovie.position=1000;break;
  case 3:cueName="same-future";cueMovie.frame=12;cueMovie.setPeriodEvent(6);cueMovie.position=0;cueMovie.setPeriodEvent(6);break;
  case 4:cueName="same-past";cueMovie.frame=0;cueMovie.setPeriodEvent(6);cueMovie.position=1000;cueMovie.setPeriodEvent(6);cueNegative=true;break;
  case 5:cueName="zero-rewind";cueMovie.frame=0;cueMovie.setPeriodEvent(0);cueMovie.rewind();break;
  case 6:cueName="consumed";cueMovie.rewind();cueNegative=true;break;
  case 7:cueName="close-past";cueMovie.frame=12;cueMovie.setPeriodEvent(6);cueMovie.close();cueMovie.open("colors.mp4");cueMovie.pause();cueNegative=true;break;
  case 8:cueName="closed-future";cueMovie.close();cueMovie.setPeriodEvent(6);cueMovie.open("colors.mp4");cueMovie.pause();break;
  case 9:cueName="whole-loop";cueMovie.frame=12;cueMovie.setPeriodEvent(6);cueMovie.position=1200;cueMovie.loop=true;break;
  case 10:cueName="segment";cueMovie.frame=12;cueMovie.setPeriodEvent(6);cueMovie.setSegmentLoop(6,14);break;
  case 11:cueName="negative-segment-start";cueMovie.frame=12;cueMovie.setPeriodEvent(6);cueMovie.setSegmentLoop(-9,14);break;
  case 12:cueName="segment-end-after-movie";cueMovie.close();cueMovie.setSegmentLoop(-12,400);cueMovie.open("colors.mp4");cueMovie.pause();cueMovie.setPeriodEvent(6);break;
  case 13:cueName="inactive-segment";cueMovie.frame=0;cueMovie.setSegmentLoop(2147483647,0);cueMovie.setPeriodEvent(6);break;
 }
 cueIndex++;cueActive=true;cueMovie.play();Debug.message("cue-start:"+cueName);
}
cueButton.onClick=function(){global.cueNext();};
Debug.message("cue-button-ready");
`
