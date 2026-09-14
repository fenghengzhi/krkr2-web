export const soundClasses = String.raw`
class __SoundBase {
  var __soundId,__soundOwner,__soundFlags,__filters,__soundLabels;
  function __SoundBase(kind,owner) {
    if(owner===void)throw new Exception("SoundBuffer requires an action owner");
    __soundOwner=owner;__filters=[];
    __soundId=__host("Sound.create",kind,__soundDispatch);
    __soundFlags=__host("Sound.flags",__soundId);
  }
  function __soundDispatch(name,args) { return this[name](args*); }
  function __soundRun(method,args) {
    var result=__host("Sound.call",__soundId,method,args);
    for(var i=0;i<result.callbacks.count;i++){var event=result.callbacks[i];if(!System.eventDisabled)this[event[0]](event[1]*);}
    return result.value;
  }
  function finalize(){__host("Sound.destroy",__soundId);invalidate __soundFlags;__soundOwner=null;}
  function open(name){__soundRun("stopFade",[false]);__soundLabels=void;__soundRun("unload",[]);__soundLabels=void;__soundRun("open",[string(name)]);}
  function play(){__soundRun("play",[]);}
  function stop(){__soundRun("stop",[]);}
  function fade(to,time,delay=0){__soundRun("stopFade",[false]);__soundRun("fade",[int(to),int(time),int(delay)]);}
  function stopFade(){__soundRun("stopFade",[true]);}
  function onStatusChanged(status){if(__soundOwner!==null&&typeof __soundOwner.action!="undefined")__soundOwner.action(%[type:"onStatusChanged",target:this,status:status]);}
  function onFadeCompleted(){if(__soundOwner!==null&&typeof __soundOwner.action!="undefined")__soundOwner.action(%[type:"onFadeCompleted",target:this]);}
  function onLabel(name){if(__soundOwner!==null&&typeof __soundOwner.action!="undefined")__soundOwner.action(%[type:"onLabel",target:this,name:name]);}
  property flags{getter(){return __soundFlags;}}
  property filters{getter(){return __filters;}}
  property labels{getter(){if(__soundLabels===void)__soundLabels=__soundRun("get",["labels"]);return __soundLabels;}}
  ${['position', 'samplePosition', 'paused', 'looping', 'volume', 'volume2', 'pan', 'frequency'].map((name) => `property ${name}{getter(){return __soundRun("get",["${name}"]);}setter(value){__soundRun("set",["${name}",int(value)]);}}`).join('\n')}
  ${['status', 'totalTime', 'bits', 'channels'].map((name) => `property ${name}{getter(){return __soundRun("get",["${name}"]);}}`).join('\n')}
}
class WaveSoundBuffer extends __SoundBase {
  function WaveSoundBuffer(owner){super.__SoundBase("wave",owner);}
  property globalVolume{getter(){return __host("Sound.global","volume");}setter(value){__host("Sound.global","volume",int(value));}}
  property globalFocusMode{getter(){return __host("Sound.global","focusMode");}setter(value){__host("Sound.global","focusMode",int(value));}}
}
class MIDISoundBuffer extends __SoundBase {
  function MIDISoundBuffer(owner){super.__SoundBase("midi",owner);}
  function midiOut(data){__host("Sound.global","midiOut",data);}
}
class CDDASoundBuffer extends __SoundBase {
  function CDDASoundBuffer(owner){super.__SoundBase("cdda",owner);}
}
`
