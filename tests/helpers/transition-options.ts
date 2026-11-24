// Independent expected option observations from the pinned LayerIntf.cpp
// StartTransition/beginTransition and TransIntf.cpp simple option providers.
// This source is shared by the original Windows SDK and real Session callers;
// it neither calls nor reproduces the Web transition implementation.
export const transitionOptionCases = [
  { id: 'crossfade-order', expected: 'ok|selfupdate,callback,time' },
  { id: 'crossfade-ignored', expected: 'ok|selfupdate,callback,time' },
  { id: 'callback-once', expected: 'ok|selfupdate,callback,time' },
  { id: 'getter-switch', expected: 'ok|selfupdate,callback:self,time:callback' },
  { id: 'universal-order', expected: 'ok|selfupdate,callback,time,vague,rule' },
  { id: 'universal-vague-error', expected: 'ok|selfupdate,callback,time,vague,rule' },
  { id: 'universal-rule-error', expected: 'option:<rule>|selfupdate,callback,time,vague,rule' },
  { id: 'scroll-order', expected: 'ok|selfupdate,callback,time,from,stay' },
  { id: 'scroll-default-errors', expected: 'ok|selfupdate,callback,time,from,stay' },
  { id: 'missing-time', expected: 'option:<time>|selfupdate,callback,time' },
  { id: 'time-getter-error', expected: 'option:<time>|selfupdate,callback,time' },
  { id: 'time-conversion-error', expected: 'option:<time>|selfupdate,callback,time' },
  { id: 'selfupdate-error', expected: 'getter:selfupdate|selfupdate' },
  { id: 'callback-error', expected: 'getter:callback|selfupdate,callback' },
  { id: 'callback-type', expected: 'callback-object|selfupdate,callback' },
  { id: 'unknown-handler', expected: 'handler:<not-a-transition>|' },
  { id: 'image-size', expected: 'size:<2x3>:<3x2>|selfupdate,callback' },
  { id: 'layer-size', expected: 'size:<3x2>:<4x3>|selfupdate,callback' },
  { id: 'active', expected: 'active|' },
  { id: 'mutual', expected: 'mutual|' },
  { id: 'recovery-crossfade', expected: 'ok|selfupdate,callback,time' },
] as const

/** A small hand-authored uncompressed BMP, unrelated to product image code. */
export function transitionOptionFiles(): Record<string, Uint8Array> {
  const bytes = new Uint8Array(78), view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d]); view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true); view.setUint32(14, 40, true)
  view.setInt32(18, 3, true); view.setInt32(22, 2, true)
  view.setUint16(26, 1, true); view.setUint16(28, 24, true)
  view.setUint32(34, 24, true)
  // BMP stores the bottom row first; each 9-byte RGB row has 3 padding bytes.
  bytes.set([255,255,255,128,128,128,0,0,0,0,0,0,
    0,0,0,64,64,64,255,255,255,0,0,0], 54)
  return { 'transition-rule.bmp': bytes }
}

export const transitionOptionsSource = String.raw`
System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;
System.assignMessage("TVPSpecifyOption","option:<%1>");
System.assignMessage("TVPCannotFindTransHander","handler:<%1>");
System.assignMessage("TVPTransitionLayerSizeMismatch","size:<%1>:<%2>");
System.assignMessage("TVPCurrentTransitionMustBeStopping","active");
System.assignMessage("TVPTransitionMutualSource","mutual");
System.assignMessage("TJSVariantConvertErrorToObject","callback-object");
var transitionWindow=new Window();transitionWindow.setInnerSize(6,4);
var transitionRoot=new Layer(transitionWindow,null);
transitionRoot.setImageSize(6,4);transitionRoot.setSize(6,4);
var transitionFore=new Layer(transitionWindow,transitionRoot);
var transitionBack=new Layer(transitionWindow,transitionRoot);
transitionWindow.visible=true;
var transitionMode="",transitionTrace=[],transitionReads=0,transitionChoice="";
var transitionClock=%[read:function(){return 0;}];
class TransitionOptions {
 property selfupdate {getter(){
  global.transitionTrace.add("selfupdate");
  if(global.transitionMode=="selfupdate-error")throw new Exception("getter:selfupdate");
  if(global.transitionMode=="getter-switch")global.transitionChoice="self";
  return true;
 }}
 property callback {getter(){
  global.transitionReads++;
  global.transitionTrace.add(global.transitionMode=="getter-switch"?
   "callback:"+global.transitionChoice:"callback");
  if(global.transitionMode=="callback-error")throw new Exception("getter:callback");
  if(global.transitionMode=="callback-type")return 7;
  if(global.transitionMode=="callback-once"){
   if(global.transitionReads!=1)throw new Exception("callback-read-twice");
   return global.transitionClock.read;
  }
  if(global.transitionMode=="getter-switch"){
   global.transitionChoice="callback";return global.transitionClock.read;
  }
  return void;
 }}
 property time {getter(){
  global.transitionTrace.add(global.transitionMode=="getter-switch"?
   "time:"+global.transitionChoice:"time");
  if(global.transitionMode=="missing-time")return void;
  if(global.transitionMode=="time-getter-error")throw new Exception("getter:time");
  if(global.transitionMode=="time-conversion-error")return %[];
  if(global.transitionMode=="getter-switch")global.transitionChoice="time";
  return "1000000";
 }}
 property vague {getter(){
  global.transitionTrace.add("vague");
  if(global.transitionMode=="crossfade-ignored"||global.transitionMode=="universal-vague-error")
   throw new Exception("getter:vague");
  return 0;
 }}
 property rule {getter(){
  global.transitionTrace.add("rule");
  if(global.transitionMode=="crossfade-ignored"||global.transitionMode=="universal-rule-error")
   throw new Exception("getter:rule");
  return "transition-rule.bmp";
 }}
 property from {getter(){
  global.transitionTrace.add("from");
  if(global.transitionMode=="crossfade-ignored"||global.transitionMode=="scroll-default-errors")
   throw new Exception("getter:from");
  return 0;
 }}
 property stay {getter(){
  global.transitionTrace.add("stay");
  if(global.transitionMode=="crossfade-ignored"||global.transitionMode=="scroll-default-errors")
   throw new Exception("getter:stay");
  return 0;
 }}
}
function transitionOptionRun(id){
 // Always real, distinct, image-owning sibling layers. Reset only after both
 // previous transitions are stopped; no getter destroys or reenters a layer.
 global.transitionFore.stopTransition();global.transitionBack.stopTransition();
 global.transitionFore.setImageSize(3,2);global.transitionFore.setSize(3,2);
 global.transitionBack.setImageSize(3,2);global.transitionBack.setSize(3,2);
 global.transitionFore.type=ltOpaque;global.transitionBack.type=ltOpaque;
 global.transitionFore.fillRect(0,0,3,2,0xff123456);
 global.transitionBack.fillRect(0,0,3,2,0xff987654);
 global.transitionFore.visible=true;global.transitionBack.visible=false;
 global.transitionMode=id;global.transitionTrace=[];global.transitionReads=0;global.transitionChoice="initial";
 var handler="crossfade",children=false;
 if(id=="universal-order"||id=="universal-vague-error"||id=="universal-rule-error")handler="universal";
 if(id=="scroll-order"||id=="scroll-default-errors")handler="scroll";
 if(id=="image-size")global.transitionBack.setImageSize(2,3);
 if(id=="layer-size"){
  global.transitionFore.setSize(4,3);children=true;
 }
 if(id=="active")global.transitionFore.beginTransition("crossfade",false,global.transitionBack,%[time:1000000,selfupdate:true]);
 if(id=="mutual"){
  global.transitionBack.visible=true;
  global.transitionBack.beginTransition("crossfade",false,global.transitionFore,%[time:1000000,selfupdate:true]);
 }
 if(id=="unknown-handler"||id=="active"||id=="mutual")handler="not-a-transition";
 var result="ok",options=new TransitionOptions();
 try{global.transitionFore.beginTransition(handler,children,global.transitionBack,options);}
 catch(e){result=e.message;}
 // Cleanup exceptions remain exceptions rather than being folded into an
 // expected beginTransition error. Stopping is synchronous in the original.
 global.transitionFore.stopTransition();global.transitionBack.stopTransition();
 return result+"|"+global.transitionTrace.join(",");
}
function transitionOptionClose(){
 global.transitionFore.stopTransition();global.transitionBack.stopTransition();
 invalidate global.transitionWindow;
}
`
