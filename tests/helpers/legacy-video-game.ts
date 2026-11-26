export const legacyVideoCases = [
  { file: 'legacy-program.mpg', format: 'mpeg', audio: true, audioOffset: .3 },
  { file: 'legacy-mjpeg.avi', format: 'avi', audio: true, audioOffset: 0 },
  { file: 'legacy-elementary.m1v', format: 'mpegvideo', audio: false, audioOffset: 0 },
  { file: 'legacy-program.mpeg', format: 'mpeg', audio: true, audioOffset: .3 },
  { file: 'legacy-elementary.mpv', format: 'mpegvideo', audio: false, audioOffset: 0 },
] as const

export const mpeg2XvidCases = [
  { file: 'legacy-mpeg2.mpg', format: 'mpeg', audio: true, audioOffset: .3 },
  { file: 'legacy-xvid.avi', format: 'avi', audio: true, audioOffset: 0 },
] as const

export const aviAdpcmCases = [
  { file: 'legacy-msvideo1.avi', format: 'avi', audio: true, audioOffset: 0 },
  { file: 'legacy-div3.avi', format: 'avi', audio: true, audioOffset: 0 },
] as const

export const windowsMediaCases = [
  { file: 'legacy-wmv1.wmv', format: 'asf', audio: true, audioOffset: 0 },
  { file: 'legacy-wmv2.asf', format: 'asf', audio: true, audioOffset: .3 },
] as const

export const legacyVideoColors = [[220, 30, 30], [25, 210, 35], [30, 45, 220]] as const

/** Author markers are intentionally coarse enough to survive MPEG/JPEG and
 * H.264 conversion. They identify every frame without fixed decoded bytes. */
export function legacyFrameCode(pixels: ArrayLike<number>): number {
  if (pixels.length !== 96 * 64 * 4) throw new Error('Wrong legacy movie frame dimensions')
  let code = 0
  for (let bit = 0; bit < 7; bit++) {
    const at = (52 * 96 + 12 + bit * 12) * 4,
      level = (pixels[at]! + pixels[at + 1]! + pixels[at + 2]!) / 3
    if (level > 180) code |= 1 << bit
    else if (level > 70) throw new Error(`Ambiguous legacy frame marker at bit ${bit}: ${level}`)
  }
  return code
}

export function legacyVideoGame(cases: readonly { file: string }[]): string { return String.raw`
System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;
var legacyWindow=new Window();legacyWindow.caption="Legacy movie player";legacyWindow.setInnerSize(200,128);
var legacyRoot=new Layer(legacyWindow,null);legacyRoot.setSize(200,128);legacyRoot.holdAlpha=false;
legacyRoot.fillRect(0,0,200,128,0xff102030);
var legacyLeft=new Layer(legacyWindow,legacyRoot),legacyRight=new Layer(legacyWindow,legacyRoot);
legacyLeft.setSize(96,64);legacyRight.setPos(104,0,96,64);legacyLeft.visible=legacyRight.visible=true;
var legacyFiles=${JSON.stringify(cases.map((item) => item.file))},legacyIndex=0;
var legacyEvents=[],legacyDropped=0,legacyPrepareCount=0,legacyOpenClock="";
function legacyRecord(value){if(legacyEvents.count<384)legacyEvents.add(value);else legacyDropped++;}
function legacyWord(layer){
 var code=0;for(var bit=0;bit<7;bit++)if((layer.getMainPixel(12+bit*12,52)&255)>180)code|=1<<bit;return code;
}
class LegacyMovie extends VideoOverlay {
 function LegacyMovie(w){super.VideoOverlay(w);}
 function onStatusChanged(value){global.legacyRecord("status:"+value);}
 function onFrameUpdate(frame){global.legacyRecord("frame:"+frame+":"+status+":"+global.legacyWord(global.legacyLeft)+":"+global.legacyWord(global.legacyRight));}
 function onPeriod(reason){
  global.legacyRecord("period:"+reason+":"+status+":"+global.legacyWord(global.legacyLeft)+":"+global.legacyWord(global.legacyRight));
  if(reason==2)global.legacyPrepareCount++;
 }
}
var legacyMovie=new LegacyMovie(legacyWindow);legacyMovie.mode=vomLayer;
legacyMovie.layer1=legacyLeft;legacyMovie.layer2=legacyRight;
function legacyOpen(){
 legacyEvents.clear();global.legacyDropped=0;global.legacyPrepareCount=0;
 legacyMovie.open(legacyFiles[legacyIndex]);global.legacyOpenClock=legacyMovie.frame+"|"+legacyMovie.position;
 legacyMovie.loop=true;legacyMovie.pause();legacyMovie.frame=0;
 Debug.message("legacy-ready:"+legacyIndex+":"+legacyFiles[legacyIndex]);
}
function legacyAction(action){
 if(action==0){if(legacyIndex+1<legacyFiles.count){global.legacyIndex++;global.legacyOpen();}return;}
 if(action>=1 && action<=3){
  legacyMovie.pause();
  if(action==1)legacyMovie.frame=25;
  else if(action==2)legacyMovie.frame=50;
  else legacyMovie.position=3200;
 }else if(action==4){
  legacyEvents.clear();global.legacyPrepareCount=0;legacyMovie.prepare();
  legacyEvents.add("return:"+legacyMovie.status);
 }else if(action==5)legacyMovie.play();
 else if(action==6)legacyMovie.pause();
 else legacyMovie.stop();
 Debug.message("legacy-action:"+legacyIndex+":"+action+":"+legacyMovie.status);
}
function legacyState(){return [legacyIndex,legacyMovie.status,legacyMovie.frame,legacyMovie.position,legacyPrepareCount,legacyDropped].join("|");}
var legacyLabels=["Next","Red frame","Green frame","Blue seek","Prepare","Play","Pause","Stop"],legacyButtons=[];
for(var i=0;i<8;i++){
 var button=new Layer(legacyWindow,legacyRoot);button.setPos((i%4)*50,72+(i\4)*28,48,24);
 button.holdAlpha=false;button.fillRect(0,0,48,24,0xff305878);button.font.height=9;
 button.drawText(2,5,legacyLabels[i],0xffffff);button.visible=true;button.action=i;
 button.onClick=function(){global.legacyAction(this.action);};legacyButtons.add(button);
}
legacyWindow.visible=true;legacyOpen();
` }

export const legacyVideoGameSource = legacyVideoGame(legacyVideoCases)
