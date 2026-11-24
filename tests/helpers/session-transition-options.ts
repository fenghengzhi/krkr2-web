import { transitionOptionCases, transitionOptionFiles, transitionOptionsSource } from './transition-options.ts'

// Exercise changes to a running Session independently of the Windows SDK trace.
const sessionCases = String.raw`
function transitionFailure(call){
 try{call();return "ok";}catch(e){return e.message;}
}
function transitionArguments(){
 System.assignMessage("TJSBadParamCount","count:%s:%1:%%");
 System.assignMessage("TVPSpecifyLayer","layer");
 System.assignMessage("TJSNullAccess","null-options");
 return [
  transitionFailure(function(){global.transitionFore.beginTransition();}),
  transitionFailure(function(){global.transitionFore.beginTransition("crossfade");}),
  transitionFailure(function(){global.transitionFore.beginTransition("crossfade",false,%[__id:global.transitionBack.__id]);}),
  transitionFailure(function(){global.transitionFore.beginTransition("crossfade",false,7);}),
  transitionFailure(function(){global.transitionFore.beginTransition("crossfade",false,global.transitionBack,7);}),
  transitionFailure(function(){global.transitionFore.beginTransition("crossfade",false,global.transitionBack);})
 ].join("|");
}
var transitionCompletions=0;
class NestedTransitionOptions {
 property time {getter(){
  global.transitionFore.beginTransition("crossfade",false,global.transitionBack,%[time:1000000,selfupdate:true]);
  return 100;
 }}
}
function transitionNested(){
 var f=global.transitionFore,b=global.transitionBack;
 f.visible=true;b.visible=false;
 f.onTransitionCompleted=function(dest,src){
  if(dest!==global.transitionFore||src!==global.transitionBack)throw new Exception("wrong completion layers");
  global.transitionCompletions++;
 };
 var result=transitionFailure(function(){global.transitionFore.beginTransition("scroll",false,global.transitionBack,new NestedTransitionOptions());});
 var stillActive=transitionFailure(function(){global.transitionFore.beginTransition("crossfade",false,global.transitionBack,%[time:100]);});
 f.stopTransition();f.stopTransition();
 var first=global.transitionCompletions;
 f.visible=true;b.visible=false;
 f.beginTransition("scroll",false,b,%[time:100,selfupdate:true]);
 f.stopTransition();
 return result+"|"+stillActive+"|"+first+"|"+global.transitionCompletions;
}
function transitionClockControl(){
 var f=global.transitionFore,b=global.transitionBack;
 var owner=%[calls:0,read:function(){this.calls++;return "29";}];
 f.visible=true;b.visible=false;
 f.beginTransition("crossfade",false,b,%[time:100,selfupdate:true,callback:owner.read incontextof owner]);
 f.update();global.transitionWindow.update();
 var bound=int(owner.calls>0);
 f.stopTransition();f.visible=true;b.visible=false;
 f.beginTransition("crossfade",false,b,%[time:100,selfupdate:true,callback:%[]]);
 f.update();global.transitionWindow.update();
 var active=transitionFailure(function(){global.transitionFore.beginTransition("crossfade",false,global.transitionBack,%[time:100]);});
 f.stopTransition();return bound+"|"+active;
}
Debug.message("transition-options-ready");
`

export function sessionTransitionFiles(binary: boolean): Record<string, string | Uint8Array> {
  return {
    ...transitionOptionFiles(),
    'startup.tjs': binary
      ? 'Scripts.compileStorage("options.tjs","savedata/options.cjs",false,true,false);Scripts.execStorage("savedata/options.cjs");'
      : 'Scripts.execStorage("options.tjs");',
    'options.tjs': transitionOptionsSource + sessionCases,
  }
}

export const sessionTransitionChecks = [
  ...transitionOptionCases.map(({ id, expected }) => ({ call: `transitionOptionRun("${id}")`, expected })),
  { call: 'transitionArguments()', expected: 'count:%s:%1:%%|layer|layer|callback-object|callback-object|null-options' },
  { call: 'transitionNested()', expected: 'active|active|1|2' },
  { call: 'transitionClockControl()', expected: '1|active' },
]
