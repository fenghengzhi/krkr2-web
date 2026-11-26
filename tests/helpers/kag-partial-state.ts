/** The stock parser's Restore reads optional members independently. These
 * scenarios use a real call/return between files, a declared macro and an
 * onScenarioLoaded callback that advances its own parser. */
export const kagPartialFiles = {
  'partial-main.ks': '*home\n@call storage=partial-chapter.ks target=*start\n@after route=home\n',
  'partial-chapter.ks': '*start\n@scene value=before\n*selected\n@scene value=selected\n@return\n',
  'partial-alt.ks': '@scene value=prologue\n*start\n@scene value=alternate\n',
  'partial-macro.ks': '*start\n[macro name=voice][scene value=%actor][endmacro][voice actor=Alice]\\\n*next\n@scene value=%actor\n',
  'partial-cond.ks': '[if exp=true][scene value=inside][else][scene value=alternate][endif][scene value=after]\\\n',
  'partial-live.ks': '*resume\n[scene value=unrestored][else][scene value=%actor][endif][scene value=finished]\\\n',
  'partial-outer.ks': '*outer\n@call storage=partial-middle.ks target=*middle\n@scene value=home\n',
  'partial-middle.ks': '*middle\n@call storage=partial-inner.ks target=*start\n@scene value=middle\n@return\n',
  'partial-inner.ks': '*start\n@scene value=start\n*resume\n@scene value=resumed\n@return\n',
}

export const kagPartialExpected: Readonly<Record<string, string>> = {
  'partial-current-call': 'before|partial-chapter.ks|*selected|1|selected|home|0',
  'partial-void-members': 'before|before|1|alternate|0|prologue',
  'partial-frame-extras': 'selected|home|intact|intact',
  'partial-macro-base': 'Alice|1|1|Alice|0|1',
  'partial-callback-conditions': 'inside|1|ffffffff|1|after|0',
  'partial-callback-edits': 'inside|1|0|alternate|after|0',
  'partial-getter-order': 'Alice|Alice|Alice|1|1|1|macros,macroArgs,macroArgStackDepth,callStack,storageName,storageShortName,curLabel,ExcludeLevel,IfLevel,ExcludeLevelStack,IfLevelExecutedStack,macroArgStackBase',
  'partial-live-route': 'Alice|0|Bob:1|partial-live.ks:partial-macro.ks|requested-short|-1/0//;1/0//;1/1//;1/1/ffffffff/;1/1/ffffffff/0|partial-live.ks|Bob|finished|0',
  'partial-live-frames': 'start|0,1|resumed|middle|home|0',
  'partial-getter-recovery': 'chapter stopped|1/0//|partial-live.ks|resumed|0',
}

export const kagPartialSource = String.raw`
// A normal script object supplies only the native Restore fields.
class PartialGetterBookmark {
 var saved,parser,reads=[],macroReads=0,argumentReads=0,observedActor="";
 function PartialGetterBookmark(value,owner){saved=value;parser=owner;}
 property macros {getter(){
  reads.add("macros");macroReads++;
  if(macroReads!=1)throw new Exception("Restore read macros twice");
  return saved.macros;
 }}
 property macroArgs {getter(){
  reads.add("macroArgs");argumentReads++;
  if(argumentReads!=1)throw new Exception("Restore read macroArgs twice");
  return saved.macroArgs;
 }}
 property macroArgStackDepth {getter(){reads.add("macroArgStackDepth");return saved.macroArgStackDepth;}}
 property callStack {getter(){reads.add("callStack");return saved.callStack;}}
 property storageName {getter(){
  reads.add("storageName");var current=parser.macroParams;
  observedActor=current===null?"<null>":current.actor;
  return saved.storageName;
 }}
 property storageShortName {getter(){reads.add("storageShortName");return saved.storageShortName;}}
 property curLabel {getter(){reads.add("curLabel");return saved.curLabel;}}
 property ExcludeLevel {getter(){reads.add("ExcludeLevel");return saved.ExcludeLevel;}}
 property IfLevel {getter(){reads.add("IfLevel");return saved.IfLevel;}}
 property ExcludeLevelStack {getter(){reads.add("ExcludeLevelStack");return saved.ExcludeLevelStack;}}
 property IfLevelExecutedStack {getter(){reads.add("IfLevelExecutedStack");return saved.IfLevelExecutedStack;}}
 property macroArgStackBase {getter(){reads.add("macroArgStackBase");return saved.macroArgStackBase;}}
}
class PartialStoryParser extends KAGParser {
 var advanceOnLoad=false,observed="",editing=void;
 function PartialStoryParser(){super.KAGParser();debugLevel=tkdlNone;}
 function onScenarioLoaded(name){
  if(advanceOnLoad){advanceOnLoad=false;observed=getNextTag().value;}
  if(editing!==void){editing.ExcludeLevel=1;editing.IfLevelExecutedStack="0";editing=void;}
 }
}
function partialConditionState(parser){
 var s=parser.store();return [s.ExcludeLevel,s.IfLevel,s.ExcludeLevelStack,s.IfLevelExecutedStack].join("/");
}
// The route is selected by the restored game state. Each accessor can use
// the same public parser (including store) as an ordinary startup script.
class PartialRouteBookmark extends PartialGetterBookmark {
 var zero,actor,location,shortName,conditions=[];
 function PartialRouteBookmark(value,owner){super.PartialGetterBookmark(value,owner);}
 property macroArgs {getter(){zero=parser.store().macroArgStackDepth;return saved.macroArgs;}}
 property callStack {getter(){
  actor=parser.macroParams.actor+":"+parser.store().macroArgStackBase;return saved.callStack;
 }}
 property storageName {getter(){return "partial-live.ks";}}
 property storageShortName {getter(){
  location=parser.curStorage+":"+parser.store().storageShortName;return "requested-short";
 }}
 property curLabel {getter(){shortName=parser.store().storageShortName;return "*resume";}}
 property ExcludeLevel {getter(){conditions.add(partialConditionState(parser));return 1;}}
 property IfLevel {getter(){conditions.add(partialConditionState(parser));return 1;}}
 property ExcludeLevelStack {getter(){conditions.add(partialConditionState(parser));return "ffffffff";}}
 property IfLevelExecutedStack {getter(){conditions.add(partialConditionState(parser));return "0";}}
 property macroArgStackBase {getter(){conditions.add(partialConditionState(parser));return 1;}}
}
class PartialRouteFrame {
 var parser,frame,observed,label,offset,orgLineStr,lineBuffer,pos,lineBufferUsing,
  macroArgStackBase,macroArgStackDepth,ExcludeLevel,IfLevel,ExcludeLevelStack,IfLevelExecutedStack;
 function PartialRouteFrame(owner,f,log){
  parser=owner;frame=f;observed=log;label=f.label;offset=f.offset;orgLineStr=f.orgLineStr;
  lineBuffer=f.lineBuffer;pos=f.pos;lineBufferUsing=f.lineBufferUsing;
  macroArgStackBase=f.macroArgStackBase;macroArgStackDepth=f.macroArgStackDepth;
  ExcludeLevel=f.ExcludeLevel;IfLevel=f.IfLevel;ExcludeLevelStack=f.ExcludeLevelStack;
  IfLevelExecutedStack=f.IfLevelExecutedStack;
 }
 property storage {getter(){observed.add(parser.callStackDepth);return frame.storage;}}
}
class PartialStoppedBookmark extends PartialRouteBookmark {
 function PartialStoppedBookmark(value,owner){super.PartialRouteBookmark(value,owner);}
 property IfLevel {getter(){throw new Exception("chapter stopped");}}
}
function partialChapter(p){
 p.loadScenario("partial-main.ks");
 var before=p.getNextTag().value;
 if(p.callStackDepth!=1 || p.curLabel!="*start")throw new Exception("Chapter call was not established");
 return before;
}
function kagPartialRun(id,p){
 var d,result,s;
 switch(id){
 case "partial-current-call":
  result=partialChapter(p);d=%[curLabel:"*selected"];
  (Dictionary.saveStruct incontextof d)("partial-slot.tjs");p.restore(Scripts.evalStorage("partial-slot.tjs"));
  result+="|"+p.curStorage+"|"+p.curLabel+"|"+p.callStackDepth+"|"+p.getNextTag().value;
  return result+"|"+p.getNextTag().route+"|"+p.callStackDepth;
 case "partial-void-members":
  result=partialChapter(p);p.restore(%[storageName:void,curLabel:void,callStack:void]);
  result+="|"+p.getNextTag().value+"|"+p.callStackDepth;
  p.restore(%[storageName:"partial-alt.ks",callStack:[]]);
  result+="|"+p.getNextTag().value+"|"+p.callStackDepth;
  p.restore(%[curLabel:""]);return result+"|"+p.getNextTag().value;
 case "partial-frame-extras":
  partialChapter(p);d=p.store();d.curLabel="*selected";
  var callback=function(){return "intact";};
  d.gameCallback=callback;d.callStack[0].gameCallback=callback;p.restore(d);
  result=p.getNextTag().value;return result+"|"+p.getNextTag().route+"|"+d.gameCallback()+"|"+d.callStack[0].gameCallback();
 case "partial-macro-base":
  p.loadScenario("partial-macro.ks");result=p.getNextTag().value;d=p.store();
  delete d.macroArgStackBase;d.curLabel="*next";p.restore(d);
  s=p.store();result+="|"+s.macroArgStackBase+"|"+s.macroArgStackDepth+"|"+p.getNextTag().value;
  d.macroArgStackBase=0;p.restore(d);p.goToLabel("*next");
  return result+"|"+p.store().macroArgStackBase+"|"+int(p.macroParams===null);
 case "partial-callback-conditions":
  p.advanceOnLoad=true;p.restore(%[storageName:"partial-cond.ks",curLabel:"",ExcludeLevel:-1]);
  s=p.store();result=p.observed+"|"+s.IfLevel+"|"+s.ExcludeLevelStack+"|"+s.IfLevelExecutedStack;
  return result+"|"+p.getNextTag().value+"|"+p.store().IfLevel;
 case "partial-callback-edits":
  d=%[storageName:"partial-cond.ks",curLabel:""];p.editing=d;p.advanceOnLoad=true;p.restore(d);
  s=p.store();result=p.observed+"|"+s.ExcludeLevel+"|"+s.IfLevelExecutedStack;
  result+="|"+p.getNextTag().value;return result+"|"+p.getNextTag().value+"|"+p.store().IfLevel;
 case "partial-getter-order":
  p.loadScenario("partial-macro.ks");result=p.getNextTag().value;
  s=p.store();s.curLabel="*next";d=new PartialGetterBookmark(s,p);p.restore(d);
  result+="|"+p.getNextTag().value+"|"+d.observedActor+"|"+d.macroReads+"|"+d.argumentReads+"|"+int(p.macros.voice===s.macros.voice);
  return result+"|"+d.reads.join(",");
 case "partial-live-route":
  p.loadScenario("partial-macro.ks");result=p.getNextTag().value;
  s=p.store();s.macroArgs[0].actor="Bob";d=new PartialRouteBookmark(s,p);p.restore(d);
  result+="|"+d.zero+"|"+d.actor+"|"+d.location+"|"+d.shortName+"|"+d.conditions.join(";");
  return result+"|"+p.store().storageShortName+"|"+p.getNextTag().value+"|"+p.getNextTag().value+"|"+p.store().IfLevel;
 case "partial-live-frames":
  p.loadScenario("partial-outer.ks");result=p.getNextTag().value;d=p.store();
  var seen=[],frames=d.callStack;
  d.callStack=%[count:2];d.callStack[0]=new PartialRouteFrame(p,frames[0],seen);
  d.callStack[1]=new PartialRouteFrame(p,frames[1],seen);d.curLabel="*resume";p.restore(d);
  return result+"|"+seen.join(",")+"|"+p.getNextTag().value+"|"+p.getNextTag().value+"|"+p.getNextTag().value+"|"+p.callStackDepth;
 case "partial-getter-recovery":
  p.loadScenario("partial-macro.ks");p.getNextTag();d=new PartialStoppedBookmark(p.store(),p);
  try{p.restore(d);return "unexpected success";}catch(error){result=error.message;}
  result+="|"+partialConditionState(p)+"|"+p.curStorage;
  p.restore(%[macroArgs:[],macroArgStackDepth:0,storageName:"partial-inner.ks",curLabel:"*resume"]);
  return result+"|"+p.getNextTag().value+"|"+p.store().IfLevel;
 }
 throw new Exception("Unknown partial bookmark control");
}
function kagPartialObserve(id){
 var p=new PartialStoryParser(),result;
 try{result=kagPartialRun(id,p);}catch(error){invalidate p;throw error;}
 invalidate p;return result;
}
`
