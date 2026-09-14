export const soundClasses = String.raw`
class __SoundBase {
  var __soundId,__soundOwner,__soundFlags,__filters,__soundLabels;
  function __SoundBase(kind,owner) {
    if(owner===void)throw new Exception("SoundBuffer requires an action owner");
    if(typeof owner!="Object")throw new Exception("SoundBuffer requires an object action owner");
    __soundOwner=owner;__filters=[];
    __soundId=__host("Sound.create",kind,this);
  }
  function __soundRun(method,args) {
    var result=__host("Sound.call",__soundId,method,args);
    for(var i=0;i<result.callbacks.count;i++){var event=result.callbacks[i];if(!System.eventDisabled)this[event[0]](event[1]*);}
    return result.value;
  }
  function finalize(){} // Native owner invalidation retires the resource.
  function __clearSoundLabels(){if(__soundLabels!==void)invalidate __soundLabels;__soundLabels=void;}
  function open(name){__soundRun("stopFade",[false]);__clearSoundLabels();__soundRun("unload",[]);__clearSoundLabels();__soundRun("open",[string(name)]);}
  function play(){__soundRun("play",[]);}
  function stop(){__soundRun("stop",[]);}
  function fade(to,time,delay=0){__soundRun("stopFade",[false]);__soundRun("fade",[int(to),int(time),int(delay)]);}
  function stopFade(){__soundRun("stopFade",[true]);}
  function onStatusChanged(status){if(__soundOwner!==null&&typeof __soundOwner.action!="undefined")__soundOwner.action(%[type:"onStatusChanged",target:this,status:status]);}
  function onFadeCompleted(){if(__soundOwner!==null&&typeof __soundOwner.action!="undefined")__soundOwner.action(%[type:"onFadeCompleted",target:this]);}
  function onLabel(name){if(__soundOwner!==null&&typeof __soundOwner.action!="undefined")__soundOwner.action(%[type:"onLabel",target:this,name:name]);}
  property flags{getter(){if(__soundFlags===void)__soundFlags=__host("Sound.flags",__soundId,this);return __soundFlags;}}
  property filters{getter(){return __filters;}}
  property labels{getter(){if(__soundLabels===void){var labels=__soundRun("get",["labels"]);__host("Sound.bindLabels",__soundId,this,labels);__soundLabels=labels;}return __soundLabels;}}
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
