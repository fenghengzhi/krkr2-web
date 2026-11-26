import { videoColorRanges } from '../media/video-color.ts'

export const videoClass = String.raw`
class VideoOverlay {
  var __videoId,__videoWindow;
  function VideoOverlay(window){
    if(window===null || !(window instanceof "Window"))throw new Exception("VideoOverlay requires a Window");
    __videoWindow=window;__videoId=__host("Video.create",this,window,window.__windowId);
  }
  function finalize(){}
  function __videoDispatch(events,immediate=false){if(events.count)__host("Video.dispatchCallbacks",this,events,immediate);}
  function __videoRun(method,args){var result=__host("Video.call",__videoId,method,args);__videoDispatch(result.callbacks,true);return result.value;}
  function open(args*){
    if(args.count<1){__videoRun("prepareOpen",[]);return;}
    // Native checks arity and converts ttstr before Open enters its Close.
    // A conversion failure must leave the playing graph and its events live.
    var name=string(args[0]);
    __videoRun("close",[]);__videoRun("open",[name]);
  }
  ${['play', 'stop', 'pause', 'rewind', 'close'].map((name) => `function ${name}(){__videoRun("${name}",[]);}`).join('\n')}
  function prepare(){
    if(!__videoRun("canPrepare",[]))return;
    __videoRun("pause",[]);__videoRun("prepareRewind",[]);
    __videoRun("prepareArm",[]);__videoRun("play",[]);
  }
  function setPos(args*){if(args.count<2)throw new global.Exception("VideoOverlay.setPos requires two arguments");__host("Video.geometry",__videoId,"setPos",int(args[0]),int(args[1]));}
  function setSize(args*){if(args.count<2)throw new global.Exception("VideoOverlay.setSize requires two arguments");__host("Video.geometry",__videoId,"setSize",int(args[0]),int(args[1]));}
  function setBounds(args*){if(args.count<4)throw new global.Exception("VideoOverlay.setBounds requires four arguments");__host("Video.geometry",__videoId,"setBounds",int(args[0]),int(args[1]),int(args[2]),int(args[3]));}
  function setSegmentLoop(args*){
    if(args.count<2){__videoRun("segment",[]);return;}
    __videoRun("segment",[int(args[0]),int(args[1])]);
  }
  function cancelSegmentLoop(){__videoRun("segment",[-1,-1]);}
  function setPeriodEvent(args*){if(args.count==0)periodEventFrame=-1;else if(args.count==1)periodEventFrame=args[0];}
  function cancelPeriodEvent(){periodEventFrame=-1;}
  function selectAudioStream(args*){if(args.count<1)throw new Exception("VideoOverlay.selectAudioStream requires an index");__videoRun("audioStream",[int(args[0])]);}
  property enabledAudioStream{getter(){return __videoRun("get",["enabledAudioStream"]);}setter(value){__videoRun("audioStream",[int(value)]);}}
  property enabledVideoStream{getter(){return __videoRun("get",["enabledVideoStream"]);}setter(value){__videoRun("videoStream",[int(value)]);}}
  function setMixingLayer(args*){
    if(args.count<1)throw new global.Exception("VideoOverlay.setMixingLayer requires a Layer argument");
    __host("Video.mixingLayer",__videoId,args[0]);
  }
  function resetMixingLayer(){__host("Video.mixingLayer",__videoId,null);}
  ${Object.entries(videoColorRanges).map(([name, range]) => `
    property ${name}{getter(){return __videoRun("colorGet",["${name}",""]);}setter(value){__videoRun("colorSet",["${name}",real(value)]);}}
    ${Object.keys(range).map((field) => `property ${name}${field}{getter(){return __videoRun("colorGet",["${name}","${field}"]);}}`).join('\n')}
  `).join('\n')}
  function onStatusChanged(status){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onStatusChanged",target:this,status:status]);}
  function onPeriod(reason){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onPeriod",target:this,reason:reason]);}
  function onFrameUpdate(frame){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onFrameUpdate",target:this,frame:frame]);}
  function onCallbackCommand(command,arg){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onCallbackCommand",target:this,command:command,arg:arg]);}
  ${[1, 2].map((channel) => `property layer${channel}{getter(){return __host("Video.layerGet",__videoId,${channel - 1});}setter(layer){__host("Video.layer",__videoId,${channel - 1},layer);}}`).join('\n')}
  ${['left', 'top', 'width', 'height', 'visible'].map((name) => `property ${name}{getter(){return __videoRun("get",["${name}"]);}setter(value){__host("Video.geometry",__videoId,"${name}",int(${name === 'visible' ? '!!value' : 'value'}));}}`).join('\n')}
  ${['loop', 'mode', 'position', 'frame', 'playRate', 'audioVolume', 'audioBalance', 'periodEventFrame', 'mixingMovieAlpha', 'mixingMovieBGColor'].map((name) => `property ${name}{getter(){return __videoRun("get",["${name}"]);}setter(value){__videoRun("set",["${name}",${name === 'playRate' || name === 'mixingMovieAlpha' ? 'real' : 'int'}(${name === 'loop' ? '!!value' : 'value'})]);}}`).join('\n')}
  ${['status', 'originalWidth', 'originalHeight', 'fps', 'numberOfFrame', 'totalTime', 'numberOfAudioStream', 'numberOfVideoStream', 'segmentLoopStartFrame', 'segmentLoopEndFrame'].map((name) => `property ${name}{getter(){return __videoRun("get",["${name}"]);}}`).join('\n')}
}
function __krkrVideoCallbacks(report){
 return function(movie,events,immediate){
  for(var i=0;i<events.count;i++){
   var event=events[i];
   if(!immediate || !global.System.eventDisabled){
    try{movie[event[0]](event[1]*);}catch(error){this.report(error);}
   }
  }
 } incontextof %[report:report];
}
function __krkrVideoFrame(report){
 var body=function(movie,frame,layer,deferredPeriod){
  if(frame>=0 && !global.System.eventDisabled){
   try{movie.onFrameUpdate(frame);}catch(error){this.report(error);}
  }
  if(!(isvalid movie))return;
  // The native WndProc rechecks the object latch AFTER onFrameUpdate. Its
  // callbacks can reopen, close or prepare the same object recursively.
  if(layer && global.__host("Video.preparePending",movie.__videoId)){
   if(!global.System.eventDisabled){
    try{movie.onPeriod(2);}catch(error){this.report(error);}
   }
   if(!(isvalid movie))return;
   movie.__videoRun("pause",[]);movie.__videoRun("prepareRewind",[]);
   movie.__videoRun("prepareClear",[]);
  }else if(deferredPeriod && frame>=0){
   // The original WndProc reads the cue AFTER the callback. Cancellation,
   // rearming, seeking and reopening in onFrameUpdate affect this same check.
   movie.__videoRun("periodTake",[frame]);
  }
 } incontextof %[report:report];
 return function(movie,frame,layer=true,deferredPeriod=false,epoch=0,token=0){
  var id=movie.__videoId;
  try{this.body(movie,frame,layer,deferredPeriod);}
  catch(error){
   if(deferredPeriod){try{global.__host("Video.frameDone",id,epoch,token);}catch(cleanup){global.Debug.message("Video callback cleanup: "+cleanup.message);}}
   throw error;
  }
  if(deferredPeriod)global.__host("Video.frameDone",id,epoch,token);
 } incontextof %[body:body];
}
global.__host("Video.bindCallbacks",__krkrVideoCallbacks(global.__krkrImmediateError),__krkrVideoFrame(global.__krkrImmediateError));
delete global.__krkrVideoCallbacks;delete global.__krkrVideoFrame;delete global.__krkrImmediateError;
`
