/** Fixed KAGParser.cpp 665–684 advances the restore window one character
 * per value. Every tested stack is produced by the original public store(). */
export const kagConditionFiles = {
  'condition-two.ks': '[if exp=false][if exp=true]\n*saved\n[endif][else][route value=initial][endif][route value=restored][done]\n',
  'condition-three.ks': '[if exp=false][if exp=true][if exp=true]\n*saved\n[endif][else][route value=inner][endif][else][route value=initial][endif][route value=restored][done]\n',
  'condition-active.ks': '[if exp=true][if exp=true][if exp=true]\n*saved\n[route value=active][endif][endif][endif][done]\n',
  'condition-frame.ks': '[if exp=false][if exp=true]\n*saved\n[endif][else][route value=initial][endif][route value=restored][done]\n*sub\n[route value=sub][return]\n',
}
export const kagConditionExpected: Readonly<Record<string, string>> = {
  'condition-two': 'initial|1/2/ffffffff00000001/00|1/2/fffffffffffffff0/00|restored|done|0',
  'condition-three': 'initial|1/3/ffffffff0000000100000001/000|1/3/fffffffffffffff0ffffff00/000|restored|done|0',
  'condition-active': 'active|-1/3/ffffffffffffffffffffffff/111|-1/3/ffffffffffffffffffffffff/111|active|done|0',
  'condition-frame': 'sub|ffffffff00000001|fffffffffffffff0|sub|restored|done|0|initial',
  'condition-file': 'initial|1/2/ffffffff00000001/00|1/2/fffffffffffffff0/00|restored|done|0',
}
export const kagConditionSource = String.raw`
class ConditionStoryParser extends KAGParser {
 var capture=false,saved=void,callOnCapture=false;
 function ConditionStoryParser(){super.KAGParser();debugLevel=tkdlNone;ignoreCR=true;}
 function onLabel(label,page){
  if(capture && label=="*saved"){
   capture=false;if(callOnCapture)callLabel("*sub");else saved=store();
  }
 }
}
function conditionState(data){return [data.ExcludeLevel,data.IfLevel,data.ExcludeLevelStack,data.IfLevelExecutedStack].join("/");}
function conditionResume(p,data){
 p.restore(data);var result=conditionState(p.store());
 var row=p.getNextTag();if(row===void || row.tagname!="route")throw new Exception("Missing restored route");
 result+="|"+row.value;row=p.getNextTag();
 return result+"|"+row.tagname+"|"+p.store().IfLevel;
}
function kagConditionRun(id,p,q){
 if(id=="condition-frame"){
  p.capture=true;p.callOnCapture=true;p.loadScenario("condition-frame.ks");
  var first=p.getNextTag().value,frameSaved=p.store();
  q.restore(frameSaved);
  var frameResult=first+"|"+frameSaved.callStack[0].ExcludeLevelStack+"|"+q.store().callStack[0].ExcludeLevelStack;
  frameResult+="|"+q.getNextTag().value+"|"+q.getNextTag().value+"|"+q.getNextTag().tagname+"|"+q.callStackDepth;
  return frameResult+"|"+p.getNextTag().value;
 }
 p.capture=true;p.loadScenario(id=="condition-file"?"condition-two.ks":id+".ks");
 var row=p.getNextTag(),saved=p.saved;
 if(row===void || row.tagname!="route" || saved===void)throw new Exception("Conditional page was not captured");
 var result=row.value+"|"+conditionState(saved);
 if(id=="condition-file"){
  (Dictionary.saveStruct incontextof saved)("condition-bookmark.tjs");
  saved=Scripts.evalStorage("condition-bookmark.tjs");
 }
 return result+"|"+conditionResume(q,saved);
}
function kagConditionObserve(id){
 var p=void,q=void,result,failed=false,primary,cleanup=[];
 try{p=new ConditionStoryParser();q=new ConditionStoryParser();result=kagConditionRun(id,p,q);}catch(e){failed=true;primary=e;}
 try{if(p!==void && isvalid p)invalidate p;}catch(e){cleanup.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("condition-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Conditional page cleanup: "+cleanup.join("|"));return result;
}
function kagConditionResumeFile(path){
 var p=void,result,failed=false,primary;
 try{p=new ConditionStoryParser();result=conditionResume(p,Scripts.evalStorage(path));}catch(e){failed=true;primary=e;}
 try{if(p!==void && isvalid p)invalidate p;}catch(e){if(failed)Debug.message("condition-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

export const kagConditionGameFiles = {
  'first.ks': String.raw`[eval exp="f.stackValue=0"]
*menu|Conditional chapter
[cm][hr][nowait]MENU[endnowait][stackmark phase=menu]
[r][link target=*enter]Enter chapter[endlink]
[s]
*enter
[call storage=branch.ks target=*entry]
[jump target=*returned]
*returned|Original caller
[cm][hr][nowait]RETURN [emb exp=f.stackValue][endnowait][stackmark phase=returned]
[s]
`,
  'branch.ks': String.raw`*entry
[if exp=false][if exp=true]
*saved
[endif][else]
[cm][hr][nowait]FIRST PASS[endnowait][stackmark phase=initial]
[r][link target=*resume]Read saved branch[endlink]
[s]
[endif]
[eval exp="f.stackValue=7"]
*result|Restored branch
[cm][hr][nowait]RESTORED [emb exp=f.stackValue][endnowait][stackmark phase=restored]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink] / [link target=*return]Return[endlink]
[s]
*resume
[stackrestore][stackbad]
[s]
*save
[save place=0 ask=false]
[jump target=*result]
*change
[eval exp="f.stackValue=99"]
[cm][hr][nowait]CHANGED [emb exp=f.stackValue][endnowait][stackmark phase=changed]
[r][link target=*load]Load slot[endlink]
[s]
*load
[load place=0 ask=false]
*return
[return]
`,
}
export const kagConditionGameSource = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="condition";kag.saveDataLocation=System.dataPath;
var stackOwner=kag.conductor,stackOriginalLabel=kag.onConductorLabel,stackCaptured=void;
var stackPhase="",stackRendered="",stackVisits=0,stackRestores=0,stackRestoredHex="",stackFallthrough=0;
kag.onConductorLabel=function(label,page){
 if(label=="*saved" && global.stackCaptured===void){
  global.stackCaptured=global.kag.conductor.store();
  if(global.stackCaptured.ExcludeLevelStack!="ffffffff00000001" || global.stackCaptured.IfLevel!=2)
   throw new Exception("Expected the original nested conditional page");
  (Dictionary.saveStruct incontextof global.stackCaptured)(System.dataPath+"condition-route.tjs");
 }
 return global.stackOriginalLabel(label,page);
};
kag.tagHandlers.stackrestore=function(elm){
 var p=global.kag.conductor;
 if(p!==global.stackOwner || p.callStackDepth!=1 || p.curStorage!="branch.ks")throw new Exception("Missing chapter caller");
 p.restore(Scripts.evalStorage(System.dataPath+"condition-route.tjs"));
 global.stackRestoredHex=p.store().ExcludeLevelStack;global.stackRestores++;return 0;
};
kag.tagHandlers.stackbad=function(elm){global.stackFallthrough++;throw new Exception("Conditional restore fell through");};
kag.tagHandlers.stackmark=function(elm){
 global.stackPhase=elm.phase;global.stackRendered=global.kag.historyLayer.currentLine;global.stackVisits++;return 0;
};
function stackGameState(){var p=kag.conductor;
 return [global.stackPhase,global.stackRendered,global.stackVisits,f.stackValue,p.curStorage,p.curLabel,p.callStackDepth,
  global.stackRestores,global.stackFallthrough,int(p===global.stackOwner),kag.current.numLinks,p.status].join("|");
}
function stackGameFile(){var saved=Scripts.evalStorage(System.dataPath+"condition-route.tjs");
 return [saved.ExcludeLevel,saved.IfLevel,saved.ExcludeLevelStack,saved.IfLevelExecutedStack,saved.callStack.count].join("|");
}
function stackGameStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));
 return [saved.user.stackValue,saved.core.mainConductor.curLabel,saved.core.mainConductor.callStack.count].join("|");
}
Debug.message("condition-stack-game-ready");
`
