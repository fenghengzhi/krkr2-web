/** Stock KAGParser.cpp reads exp/storage/target/name with PropGet immediately
 * before executing each control. * preserves their original property objects. */
export const kagControlPropertyFiles = {
  'control-condition.ks': '[macro name=guard][mark][if *]A[else]B[endif][ignore *]C[else]D[endignore][if exp=false]X[elsif *]E[else]F[endif][if exp=true]G[elsif *]X[endif][if exp=false][if *]X[endif][endif][endmacro][guard][done]\n',
  'control-emb.ks': '[macro name=say][mark]L[emb *]R[endmacro][say][done]\n',
  'control-entry.ks': '*entry\n[macro name=route][mark][call *]HOME[endmacro][route][done]\n',
  'control-chapter.ks': '*chapter\n[at]\n[return *]\n*wrong\n[wrong]\n',
  'control-jump.ks': '[macro name=go][mark][jump *]BAD[endmacro][go][done]\n*chapter\n[hit]\n*wrong\n[wrong]\n',
  'control-names.ks': '[macro name=outer][mark][call storage=control-names-chapter.ks target=*chapter]HOME[endmacro][outer][done]\n',
  'control-names-chapter.ks': '*chapter\n[macro *]Q[endmacro][made][erasemacro *][return]\n',
}
export const kagControlPropertyExpected: Readonly<Record<string, string>> = {
  'control-property-condition': 'ADEG|if,ignore,elsif|0|1',
  'control-property-emb': 'L[A][r]R|emb|1',
  'control-property-route': 'at|1|storage,target,call|HOME|0|storage,target,call,storage,target,return,after|hit|0|storage,target,jump',
  'control-property-names': 'QHOME|call,macro,erasemacro,return,after|1|0',
  'control-property-bookmark': 'at|1|at|1|HOME|0',
}
export const kagControlPropertySource = String.raw`
var controlFieldHeld=void,controlFieldEvents=[],controlFieldExp="true",controlFieldStorage="",controlFieldTarget="",controlFieldNextTarget="",controlFieldName="made";
class ControlPropertyParser extends KAGParser {
 function ControlPropertyParser(){super.KAGParser();debugLevel=tkdlNone;ignoreCR=true;}
 function onCall(tag){global.controlFieldEvents.add("call");global.controlFieldTarget="*wrong";return true;}
 function onJump(tag){global.controlFieldEvents.add("jump");global.controlFieldTarget="*wrong";return true;}
 function onReturn(tag){global.controlFieldEvents.add("return");global.controlFieldTarget="*wrong";return true;}
 function onAfterReturn(){global.controlFieldEvents.add("after");}
}
property controlFieldExpression {getter(){global.controlFieldEvents.add(global.controlFieldHeld.tagname);return global.controlFieldExp;}}
property controlFieldFile {getter(){global.controlFieldEvents.add("storage");global.controlFieldTarget=global.controlFieldNextTarget;return global.controlFieldStorage;}}
property controlFieldLabel {getter(){global.controlFieldEvents.add("target");return global.controlFieldTarget;}}
property controlFieldMacro {getter(){global.controlFieldEvents.add(global.controlFieldHeld.tagname);return global.controlFieldName;}}
function controlPropertySeed(p,file){
 global.controlFieldEvents=[];global.controlFieldHeld=void;global.controlFieldExp="true";
 global.controlFieldStorage="control-chapter.ks";global.controlFieldNextTarget="*chapter";global.controlFieldTarget="*wrong";
 p.loadScenario(file);global.controlFieldHeld=p.getNextTag();
 if(controlFieldHeld.tagname!="mark")throw new Exception("Missing control property seed");
 var args=p.macroParams;&args.exp=&global.controlFieldExpression;&args.storage=&global.controlFieldFile;
 &args.target=&global.controlFieldLabel;&args.name=&global.controlFieldMacro;
}
function controlPropertyDrain(p){
 var text="";
 for(var i=0;i<80;i++){
  var row=p.getNextTag();if(row===void)throw new Exception("Missing control property terminator");
  if(row.tagname=="done")return text;
  if(row.tagname!="ch")throw new Exception("Unexpected control property tag: "+row.tagname);text+=row.text;
 }
 throw new Exception("Control property text exceeded its bound");
}
function controlPropertyResume(p,data){
 p.restore(data);global.controlFieldHeld=p.getNextTag();
 var result=controlFieldHeld.tagname+"|"+p.callStackDepth;
 return result+"|"+controlPropertyDrain(p)+"|"+p.callStackDepth;
}
function kagControlPropertyRun(id,p,q){
 var row,result;
 if(id=="control-property-condition"){
  controlPropertySeed(p,"control-condition.ks");result=controlPropertyDrain(p);
  return result+"|"+controlFieldEvents.join(",")+"|"+p.store().IfLevel+"|"+int(p.macroParams===null);
 }
 if(id=="control-property-emb"){
  controlPropertySeed(p,"control-emb.ks");global.controlFieldExp="'[A][r]'";
  result=controlPropertyDrain(p);return result+"|"+controlFieldEvents.join(",")+"|"+int(p.macroParams===null);
 }
 if(id=="control-property-route"){
  controlPropertySeed(p,"control-entry.ks");row=p.getNextTag();result=row.tagname+"|"+p.callStackDepth+"|"+controlFieldEvents.join(",");
  global.controlFieldStorage="";global.controlFieldNextTarget="";
  result+="|"+controlPropertyDrain(p)+"|"+p.callStackDepth+"|"+controlFieldEvents.join(",");
  controlPropertySeed(q,"control-jump.ks");global.controlFieldStorage="control-jump.ks";row=q.getNextTag();
  return result+"|"+row.tagname+"|"+q.callStackDepth+"|"+controlFieldEvents.join(",");
 }
 if(id=="control-property-names"){
  controlPropertySeed(p,"control-names.ks");result=controlPropertyDrain(p);
  return result+"|"+controlFieldEvents.join(",")+"|"+int(p.macros.made===void)+"|"+p.callStackDepth;
 }
 if(id=="control-property-bookmark"){
  controlPropertySeed(p,"control-entry.ks");row=p.getNextTag();result=row.tagname+"|"+p.callStackDepth;
  var saved=p.store(),args=saved.macroArgs[0];
  &args.exp="true";&args.storage="";&args.target="";&args.name="made";
  (Dictionary.saveStruct incontextof saved)("control-property-bookmark.tjs");
  return result+"|"+controlPropertyResume(q,Scripts.evalStorage("control-property-bookmark.tjs"));
 }
 throw new Exception("Unknown control property case");
}
function kagControlPropertyObserve(id){
 var p=void,q=void,result,failed=false,primary,cleanup=[];
 try{p=new ControlPropertyParser();q=new ControlPropertyParser();result=kagControlPropertyRun(id,p,q);}catch(e){failed=true;primary=e;}
 global.controlFieldHeld=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){cleanup.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("control-property-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception(cleanup.join("|"));return result;
}
function kagControlPropertyResumeFile(path){
 var p=void,result,failed=false,primary;
 try{p=new ControlPropertyParser();result=controlPropertyResume(p,Scripts.evalStorage(path));}catch(e){failed=true;primary=e;}
 global.controlFieldHeld=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){if(failed)Debug.message("control-property-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

export const kagControlPropertyGameSource = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="control";kag.saveDataLocation=System.dataPath;
var controlGameReads=[],controlGameVisits=0,controlGameRendered="",controlGameTarget="*wrong",controlGameReturns=0;
property controlGameCondition {getter(){global.controlGameReads.add("condition");return "true";}}
property controlGameStorage {getter(){global.controlGameReads.add("storage");global.controlGameTarget="*entry";return "control-game-chapter.ks";}}
property controlGameLabel {getter(){global.controlGameReads.add("target");return global.controlGameTarget;}}
kag.tagHandlers.controlseed=function(tag){
 var args=global.kag.conductor.macroParams;
 &args.exp=&global.controlGameCondition;&args.storage=&global.controlGameStorage;&args.target=&global.controlGameLabel;
 return 0;
};
kag.tagHandlers.controlmaterialize=function(tag){
 if(global.controlGameReads.join(",")!="condition,storage,target")throw new Exception("Control fields were not read once in native order");
 var args=global.kag.conductor.macroParams;&args.exp="true";&args.storage="";&args.target="";
 global.f.controlProgress=7;return 0;
};
function controlGameState(){return [f.controlProgress,global.controlGameRendered,global.controlGameVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status,kag.conductor.callStackDepth,global.controlGameReturns,global.controlGameReads.join(",")].join("|");}
function controlGameStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return [saved.user.controlProgress,saved.core.mainConductor.storageName,saved.core.mainConductor.curLabel,saved.core.mainConductor.callStack.count].join("|");}
Debug.message("control-property-game-ready");
`
export const kagControlPropertyStory = String.raw`[eval exp="f.controlProgress=0"]
*choice|Choose a dynamic chapter
[hr][cm][nowait]CHOOSE[endnowait]
[iscript]
global.controlGameRendered=global.kag.historyLayer.currentLine;global.controlGameVisits++;
[endscript]
[r][link target=*selected]Continue 7[endlink] / [link target=*load]Load slot[endlink]
[s]
*selected
[macro name=controlroute][controlseed][if *][call *][else][eval exp="throw new Exception('The wrong condition branch ran')"][endif][endmacro]
[controlroute]
[eval exp="global.controlGameReturns++"]
[jump target=*returned]
*returned|Return to the caller
[hr][cm][nowait]RETURN [emb exp=f.controlProgress][endnowait]
[iscript]
global.controlGameRendered=global.kag.historyLayer.currentLine;global.controlGameVisits++;
[endscript]
[s]
*load
[load place=0 ask=false]
`
export const kagControlPropertyChapter = String.raw`*entry
[controlmaterialize]
*checkpoint|Property-selected chapter
[hr][cm][nowait]CHAPTER [emb exp=f.controlProgress][endnowait]
[iscript]
global.controlGameRendered=global.kag.historyLayer.currentLine;global.controlGameVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink] / [link target=*return]Return[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.controlProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
*return
[return]
`
