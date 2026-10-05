export const videoClass = String.raw`
class VideoOverlay {
  var __videoId,__videoWindow;
  function VideoOverlay(window){
    if(window===null || !(window instanceof "Window"))throw new Exception("VideoOverlay requires a Window");
    __videoWindow=window;__videoId=__host("Video.create",this,window,window.__windowId);
  }
  function finalize(){}
  function __videoDispatch(events,immediate=false){for(var i=0;i<events.count;i++){var event=events[i];if(!immediate || !System.eventDisabled)this[event[0]](event[1]*);}}
  function __videoRun(method,args){var result=__host("Video.call",__videoId,method,args);__videoDispatch(result.callbacks,true);return result.value;}
  function open(name){__videoRun("close",[]);__videoRun("open",[string(name)]);}
  ${['play', 'stop', 'pause', 'rewind', 'prepare', 'close'].map((name) => `function ${name}(){__videoRun("${name}",[]);}`).join('\n')}
  function setPos(args*){if(args.count<2)throw new global.Exception("VideoOverlay.setPos requires two arguments");__host("Video.geometry",__videoId,"setPos",int(args[0]),int(args[1]));}
  function setSize(args*){if(args.count<2)throw new global.Exception("VideoOverlay.setSize requires two arguments");__host("Video.geometry",__videoId,"setSize",int(args[0]),int(args[1]));}
  function setBounds(args*){if(args.count<4)throw new global.Exception("VideoOverlay.setBounds requires four arguments");__host("Video.geometry",__videoId,"setBounds",int(args[0]),int(args[1]),int(args[2]),int(args[3]));}
  function setSegmentLoop(start,end){__videoRun("segment",[int(start),int(end)]);}
  function cancelSegmentLoop(){__videoRun("segment",[-1,-1]);}
  function setPeriodEvent(frame=-1){periodEventFrame=frame;}
  function cancelPeriodEvent(){periodEventFrame=-1;}
  function selectAudioStream(args*){if(args.count<1)throw new Exception("VideoOverlay.selectAudioStream requires an index");__videoRun("audioStream",[int(args[0])]);}
  property enabledAudioStream{getter(){return __videoRun("get",["enabledAudioStream"]);}setter(value){__videoRun("audioStream",[int(value)]);}}
  function setMixingLayer(args*){
    if(args.count<1)throw new global.Exception("VideoOverlay.setMixingLayer requires a Layer argument");
    __host("Video.mixingLayer",__videoId,args[0]);
  }
  function resetMixingLayer(){__host("Video.mixingLayer",__videoId,null);}
  function onStatusChanged(status){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onStatusChanged",target:this,status:status]);}
  function onPeriod(reason){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onPeriod",target:this,reason:reason]);}
  function onFrameUpdate(frame){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onFrameUpdate",target:this,frame:frame]);}
  function onCallbackCommand(command,arg){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onCallbackCommand",target:this,command:command,arg:arg]);}
  ${[1, 2].map((channel) => `property layer${channel}{getter(){return __host("Video.layerGet",__videoId,${channel - 1});}setter(layer){__host("Video.layer",__videoId,${channel - 1},layer);}}`).join('\n')}
  ${['left', 'top', 'width', 'height', 'visible'].map((name) => `property ${name}{getter(){return __videoRun("get",["${name}"]);}setter(value){__host("Video.geometry",__videoId,"${name}",int(${name === 'visible' ? '!!value' : 'value'}));}}`).join('\n')}
  ${['loop', 'mode', 'position', 'frame', 'playRate', 'audioVolume', 'audioBalance', 'periodEventFrame', 'mixingMovieAlpha', 'mixingMovieBGColor'].map((name) => `property ${name}{getter(){return __videoRun("get",["${name}"]);}setter(value){__videoRun("set",["${name}",${name === 'playRate' || name === 'mixingMovieAlpha' ? 'real' : 'int'}(${name === 'loop' ? '!!value' : 'value'})]);}}`).join('\n')}
  ${['status', 'originalWidth', 'originalHeight', 'fps', 'numberOfFrame', 'totalTime', 'numberOfAudioStream', 'numberOfVideoStream', 'enabledVideoStream', 'segmentLoopStartFrame', 'segmentLoopEndFrame'].map((name) => `property ${name}{getter(){return __videoRun("get",["${name}"]);}}`).join('\n')}
}
`
