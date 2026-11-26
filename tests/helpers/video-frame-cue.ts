/** Fixed VideoOvlImpl.cpp EC_UPDATE: frame callback, then current cue.
 * A real game button selects each authored scene; no console drives playback. */
export const videoFrameCueSource = String.raw`
System.exitOnNoWindowStartup=false;
var fcWindow=new Window();fcWindow.caption="Movie frame cue order";fcWindow.setInnerSize(160,80);
var fcRoot=new Layer(fcWindow,null);fcWindow.add(fcRoot);fcRoot.setSize(160,80);fcRoot.holdAlpha=false;fcRoot.fillRect(0,0,160,80,0xff102030);
var fcLeft=new Layer(fcWindow,fcRoot),fcRight=new Layer(fcWindow,fcRoot);
fcWindow.add(fcLeft);fcWindow.add(fcRight);fcLeft.setSize(64,48);fcRight.setPos(80,0,64,48);fcLeft.visible=fcRight.visible=true;
var fcLog=[],fcRound=-1,fcActive=false,fcChanged=false,fcPeriods=0,fcNames=["cancel","future","tail","close"];
function fcFinish(){
 if(!fcActive)return;fcActive=false;
 if(fcMovie.status!="unload")fcMovie.pause();
 fcWindow.update();Debug.message("frame-cue-done:"+fcNames[fcRound]+":"+fcPeriods+":"+fcMovie.status+":"+fcMovie.periodEventFrame);
}
class FrameCuePlayer extends VideoOverlay {
 function FrameCuePlayer(w){super.VideoOverlay(w);}
 function onFrameUpdate(f){
  if(!global.fcActive)return;
  global.fcLog.add("frame:"+f+":"+status);
  if(!global.fcChanged && f>=2){
   global.fcChanged=true;
   if(global.fcRound==0){cancelPeriodEvent();global.fcLog.add("cancel");}
   else if(global.fcRound==1){periodEventFrame=8;global.fcLog.add("future:8");}
   else if(global.fcRound==3){close();global.fcLog.add("closed");}
  }
  if(global.fcRound==0 && f>=12)global.fcFinish();
 }
 function onPeriod(reason){
  if(!global.fcActive)return;
  global.fcLog.add("period:"+reason+":"+status);
  if(reason==1){global.fcPeriods++;global.fcFinish();}
 }
 function onStatusChanged(s){if(global.fcActive)global.fcLog.add("status:"+s);}
}
var fcMovie=new FrameCuePlayer(fcWindow);fcMovie.mode=vomLayer;fcMovie.layer1=fcLeft;fcMovie.layer2=fcRight;
fcMovie.open("colors.mp4");fcMovie.pause();fcMovie.frame=0;
function fcNext(){
 if(fcActive || fcRound>=3)return;
 fcRound++;fcMovie.pause();fcMovie.frame=0;fcMovie.periodEventFrame=fcRound==2?17:2;
 fcLog.clear();fcPeriods=0;fcChanged=false;fcActive=true;fcMovie.play();
 Debug.message("frame-cue-start:"+fcNames[fcRound]);
}
var fcNextButton=new Layer(fcWindow,fcRoot);fcWindow.add(fcNextButton);fcNextButton.setPos(0,56,160,24);
fcNextButton.holdAlpha=false;fcNextButton.fillRect(0,0,160,24,0xff408060);fcNextButton.visible=true;
fcNextButton.onClick=function(){global.fcNext();};
fcWindow.visible=true;Debug.message("frame-cue-ready");
`
