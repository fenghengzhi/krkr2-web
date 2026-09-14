export const videoClass = String.raw`
class VideoOverlay {
  var __videoId,__videoWindow,__videoLayer1=null,__videoLayer2=null;
  function VideoOverlay(window){
    if(window===null || !(window instanceof "Window"))throw new Exception("VideoOverlay requires a Window");
    __videoWindow=window;__videoId=__host("Video.create",__videoDispatch);window.add(this);
  }
  function finalize(){if(__videoId===void)return;var id=__videoId;__videoId=void;__host("Video.destroy",id);__videoWindow.remove(this);__videoWindow=null;__videoLayer1=null;__videoLayer2=null;}
  function __videoDispatch(events,immediate=false){for(var i=0;i<events.count;i++){var event=events[i];if(!immediate || !System.eventDisabled)this[event[0]](event[1]*);}}
  function __videoRun(method,args){var result=__host("Video.call",__videoId,method,args);__videoDispatch(result.callbacks,true);return result.value;}
  function open(name){__videoRun("close",[]);__videoRun("open",[string(name)]);}
  ${['play', 'stop', 'pause', 'rewind', 'prepare', 'close'].map((name) => `function ${name}(){__videoRun("${name}",[]);}`).join('\n')}
  function setPos(left,top){this.left=left;this.top=top;}
  function setSize(width,height){this.width=width;this.height=height;}
  function setBounds(left,top,width,height){setPos(left,top);setSize(width,height);}
  function setSegmentLoop(start,end){__videoRun("segment",[int(start),int(end)]);}
  function cancelSegmentLoop(){__videoRun("segment",[-1,-1]);}
  function setPeriodEvent(frame=-1){periodEventFrame=frame;}
  function cancelPeriodEvent(){periodEventFrame=-1;}
  function selectAudioStream(index){__videoRun("audioStream",[int(index)]);}
  function setMixingLayer(layer){throw new Exception("Video mixing-layer composition is not implemented");}
  function resetMixingLayer(){}
  function onStatusChanged(status){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onStatusChanged",target:this,status:status]);}
  function onPeriod(reason){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onPeriod",target:this,reason:reason]);}
  function onFrameUpdate(frame){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onFrameUpdate",target:this,frame:frame]);}
  function onCallbackCommand(command,arg){if(typeof __videoWindow.action!="undefined")__videoWindow.action(%[type:"onCallbackCommand",target:this,command:command,arg:arg]);}
  ${[1, 2].map((channel) => `property layer${channel}{getter(){return __videoLayer${channel};}setter(layer){if(layer!==null&&(!(layer instanceof "Layer")||layer.window!==__videoWindow))throw new Exception("Video layer must belong to its Window");__host("Video.layer",__videoId,${channel - 1},layer===null?null:layer.__id);__videoLayer${channel}=layer;}}`).join('\n')}
  ${['left', 'top', 'width', 'height', 'visible', 'loop', 'mode', 'position', 'frame', 'playRate', 'audioVolume', 'audioBalance', 'periodEventFrame', 'mixingMovieAlpha', 'mixingMovieBGColor'].map((name) => `property ${name}{getter(){return __videoRun("get",["${name}"]);}setter(value){__videoRun("set",["${name}",${name === 'playRate' || name === 'mixingMovieAlpha' ? 'real' : 'int'}(value)]);}}`).join('\n')}
  ${['status', 'originalWidth', 'originalHeight', 'fps', 'numberOfFrame', 'totalTime', 'numberOfAudioStream', 'enabledAudioStream', 'numberOfVideoStream', 'enabledVideoStream', 'segmentLoopStartFrame', 'segmentLoopEndFrame'].map((name) => `property ${name}{getter(){return __videoRun("get",["${name}"]);}}`).join('\n')}
}
`
