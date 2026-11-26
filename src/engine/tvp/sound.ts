export const soundClasses = String.raw`
class __SoundBase {
  var __soundId,__soundKind,__soundOwner,__soundFlags,__filters,__soundLabels;
  function __SoundBase(kind,owner) {
    if(owner===void)throw new Exception("SoundBuffer requires an action owner");
    if(typeof owner!="Object")throw new Exception("SoundBuffer requires an object action owner");
    __soundKind=kind;__soundOwner=owner;__filters=[];
    __soundId=__host("Sound.create",kind,this);
  }
  function __soundRun(method,args,filters=void) {
    var result=__host("Sound.call",__soundId,method,args,filters);
    for(var i=0;i<result.callbacks.count;i++){var event=result.callbacks[i];if(!System.eventDisabled)this[event[0]](event[1]*);}
    return result.value;
  }
  function finalize(){} // Native owner invalidation retires the resource.
  function __clearSoundLabels(){if(__soundLabels!==void)invalidate __soundLabels;__soundLabels=void;}
  function open(args*){
    if(args.count<1){__soundRun("prepareOpen",[]);return;}
    // The native method checks count and converts ttstr before entering Open.
    // A failed conversion must leave the current decoder, labels and fade live.
    var storage=string(args[0]);
    // WaveImpl::Clear stops/rewinds media without ending BaseSoundBuffer's
    // fade. MIDI/CDDA keep their separate original open policies.
    if(__soundKind=="wave")__soundRun("stop",[]);else __soundRun("stopFade",[false]);
    __clearSoundLabels();__soundRun("unload",[]);__clearSoundLabels();__soundRun("open",[storage],__soundKind=="wave"?global.WaveSoundBuffer.__snapshotPhaseVocoderFilters(__filters):void);
  }
  function play(){__soundRun("play",[]);}
  function stop(){__soundRun("stop",[]);}
  function fade(args*){
    if(args.count<2){__soundRun("prepareFade",[]);return;}
    // Convert and validate before cancelling the old fade. Its immediate
    // completion callback may reenter the same buffer before the new fade.
    var to=int(args[0]),time=int(args[1]),delay=args.count<3||args[2]===void?0:int(args[2]);
    var parameters=__soundRun("prepareFade",[to,time,delay]);
    __soundRun("stopFade",[false]);__soundRun("fade",parameters);
  }
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
  function setPos(args*) {
    // Native checks the argument count before converting any component and
    // commits all three D3DVALUE coordinates only after those conversions.
    if(args.count<3){__soundRun("setPos",[]);return;}
    var x=real(args[0]),y=real(args[1]),z=real(args[2]);
    __soundRun("setPos",[x,y,z]);
  }
  ${['posX', 'posY', 'posZ'].map((name) => `property ${name}{getter(){return __soundRun("get",["${name}"]);}setter(value){__soundRun("set",["${name}",real(value)]);}}`).join('\n')}
  property globalVolume{getter(){return __host("Sound.global","volume");}setter(value){__host("Sound.global","volume",int(value));}}
  property globalFocusMode{getter(){return __host("Sound.global","focusMode");}setter(value){__host("Sound.global","focusMode",int(value));}}
}
__host("PhaseVocoder.bindClass",WaveSoundBuffer);
class MIDISoundBuffer extends __SoundBase {
  function MIDISoundBuffer(owner){super.__SoundBase("midi",owner);}
}
MIDISoundBuffer.midiOut=__host("Sound.global","midiOutMethod");
class CDDASoundBuffer extends __SoundBase {
  function CDDASoundBuffer(owner){super.__SoundBase("cdda",owner);}
  function open(args*){
    if(args.count<1){__soundRun("prepareOpen",[]);return;}
    var storage=string(args[0]),ticket=__soundRun("prepareCdda",[storage]);
    if(ticket===void){super.open(storage);return;}
    if(ticket==-1){__soundRun("unload",[]);__soundRun("invalidCddaDrive",[]);return;}
    __soundRun("stop",[]);__soundRun("stopFade",[false]);__clearSoundLabels();__soundRun("unloadCdda",[ticket]);__clearSoundLabels();
    __soundRun("openCdda",[ticket]);
  }
}
`
