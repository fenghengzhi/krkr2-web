/** Fixed KAGParser.cpp 1692–1701 performs Macros.PropGet before executing
 * an included tag, even when its name is a built-in if/call/return control.
 * Built-ins keep their control behavior; only ordinary tags/emb use the body. */
export const kagMacroDirectoryFiles = {
  'directory-condition.ks': '@seed\n[if exp=directoryReady]Y[else]N[endif][done]\n',
  'directory-entry.ks': '*start\n@seed\n[call storage=directory-wrong.ks target=*wrong]HOME[done]\n',
  'directory-chapter.ks': '*entry\n[at]\n[return]\n',
  'directory-wrong.ks': '*wrong\n[wrong]\n',
  'directory-skip.ks': '@seed\n[hidden cond=false][if exp=false][hidden][endif][macro name=relay][hidden label=YES][endmacro][relay][done]\n',
}
export const kagMacroDirectoryExpected: Readonly<Record<string, string>> = {
  'macro-directory-condition': 'Y|if:directoryReady|0',
  'macro-directory-route': 'at|1|lookup-call,call:directory-chapter.ks:*entry|HOME|0|lookup-call,call:directory-chapter.ks:*entry,lookup-return,return,after',
  'macro-directory-skip': 'hidden|YES|lookup-hidden|done|1',
  'macro-directory-bookmark': 'at|1|at|1|HOME|0',
}
export const kagMacroDirectorySource = String.raw`
var directoryHeld=void,directoryEvents=[],directoryReady=false;
class DirectoryParser extends KAGParser {
 function DirectoryParser(){super.KAGParser();debugLevel=tkdlNone;ignoreCR=true;}
 function onCall(tag){global.directoryEvents.add("call:"+tag.storage+":"+tag.target);return true;}
 function onReturn(tag){global.directoryEvents.add("return");return true;}
 function onAfterReturn(){global.directoryEvents.add("after");}
}
property directoryIf {getter(){
 global.directoryEvents.add(global.directoryHeld.tagname+":"+global.directoryHeld.exp);
 global.directoryReady=true;return "[wrong]";
}}
property directoryCall {getter(){
 global.directoryEvents.add("lookup-call");
 global.directoryHeld.storage="directory-chapter.ks";global.directoryHeld.target="*entry";
 return "[wrong]";
}}
property directoryReturn {getter(){global.directoryEvents.add("lookup-return");return "[wrong]";}}
property directoryHidden {getter(){global.directoryEvents.add("lookup-hidden");return void;}}
function directorySeed(p,file){
 global.directoryEvents=[];global.directoryReady=false;p.loadScenario(file);global.directoryHeld=p.getNextTag();
 if(directoryHeld.tagname!="seed")throw new Exception("Missing macro directory seed");
 var macros=p.macros;&macros["if"]=&global.directoryIf;&macros["call"]=&global.directoryCall;&macros["return"]=&global.directoryReturn;
}
function directoryDrain(p){
 var text="";
 for(var i=0;i<50;i++){
  var row=p.getNextTag();if(row===void)throw new Exception("Missing macro directory terminator");
  if(row.tagname=="done")return text;
  if(row.tagname!="ch")throw new Exception("Unexpected macro directory tag: "+row.tagname);text+=row.text;
 }
 throw new Exception("Macro directory text exceeded its bound");
}
function directoryResume(p,data){
 p.restore(data);var row=p.getNextTag(),result=row.tagname+"|"+p.callStackDepth;
 return result+"|"+directoryDrain(p)+"|"+p.callStackDepth;
}
function kagMacroDirectoryRun(id,p,q){
 var row,result,macros;
 if(id=="macro-directory-condition"){
  directorySeed(p,"directory-condition.ks");result=directoryDrain(p);
  return result+"|"+directoryEvents.join(",")+"|"+p.store().IfLevel;
 }
 if(id=="macro-directory-route"){
  directorySeed(p,"directory-entry.ks");row=p.getNextTag();result=row.tagname+"|"+p.callStackDepth+"|"+directoryEvents.join(",");
  result+="|"+directoryDrain(p)+"|"+p.callStackDepth;return result+"|"+directoryEvents.join(",");
 }
 if(id=="macro-directory-skip"){
  directorySeed(p,"directory-skip.ks");macros=p.macros;delete macros["if"];delete macros["call"];delete macros["return"];
  &macros.hidden=&global.directoryHidden;row=p.getNextTag();result=row.tagname+"|"+row.label+"|"+directoryEvents.join(",");
  return result+"|"+p.getNextTag().tagname+"|"+int(p.macroParams===null);
 }
 if(id=="macro-directory-bookmark"){
  directorySeed(p,"directory-entry.ks");row=p.getNextTag();result=row.tagname+"|"+p.callStackDepth;
  // Author materializes the selected route before saving ordinary progress.
  // The file contains no executable property, and a fresh VM resumes it.
  macros=p.macros;delete macros["if"];delete macros["call"];delete macros["return"];
  var saved=p.store();(Dictionary.saveStruct incontextof saved)("directory-bookmark.tjs");
  return result+"|"+directoryResume(q,Scripts.evalStorage("directory-bookmark.tjs"));
 }
 throw new Exception("Unknown macro directory control");
}
function kagMacroDirectoryObserve(id){
 var p=void,q=void,result,failed=false,primary,cleanup=[];
 try{p=new DirectoryParser();q=new DirectoryParser();result=kagMacroDirectoryRun(id,p,q);}catch(e){failed=true;primary=e;}
 global.directoryHeld=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){cleanup.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("directory-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception(cleanup.join("|"));return result;
}
function kagMacroDirectoryResumeFile(path){
 var p=void,result,failed=false,primary;
 try{p=new DirectoryParser();result=directoryResume(p,Scripts.evalStorage(path));}catch(e){failed=true;primary=e;}
 try{if(p!==void && isvalid p)invalidate p;}catch(e){if(failed)Debug.message("directory-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

export const kagMacroDirectoryGameSource = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="directory";kag.saveDataLocation=System.dataPath;
var directoryGameHeld=void,directoryGameReads=[],directoryGameVisits=0,directoryGameRendered="",directoryGameReturns=0;
property directoryGameCall {getter(){
 if(global.directoryGameHeld.tagname!="call")throw new Exception("Macro lookup did not receive the live call tag");
 global.directoryGameReads.add("call");global.directoryGameHeld.storage="directory-game-chapter.ks";global.directoryGameHeld.target="*entry";
 return "[eval exp='f.directoryProgress=999']";
}}
kag.tagHandlers.directoryseed=function(tag){
 global.directoryGameHeld=tag;var macros=global.kag.conductor.macros;&macros["call"]=&global.directoryGameCall;return 0;
};
kag.tagHandlers.directorymaterialize=function(tag){
 if(global.directoryGameReads.join(",")!="call")throw new Exception("Dynamic call macro was not queried exactly once");
 var macros=global.kag.conductor.macros;delete macros["call"];global.directoryGameHeld=void;
 global.f.directoryProgress=7;return 0;
};
function directoryGameState(){return [f.directoryProgress,global.directoryGameRendered,global.directoryGameVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status,kag.conductor.callStackDepth,global.directoryGameReturns,global.directoryGameReads.join(",")].join("|");}
function directoryGameStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return [saved.user.directoryProgress,saved.core.mainConductor.storageName,saved.core.mainConductor.curLabel,saved.core.mainConductor.callStack.count,int(saved.core.mainConductor.macros["call"]===void)].join("|");}
Debug.message("macro-directory-game-ready");
`
export const kagMacroDirectoryStory = String.raw`[eval exp="f.directoryProgress=0"]
*choice|Select a dynamic chapter
[hr][cm][nowait]CHOOSE[endnowait]
[iscript]
global.directoryGameRendered=global.kag.historyLayer.currentLine;global.directoryGameVisits++;
[endscript]
[r][link target=*selected]Continue 7[endlink] / [link target=*load]Load slot[endlink]
[s]
*selected
[directoryseed]
[call storage=directory-game-wrong.ks target=*wrong]
[eval exp="global.directoryGameReturns++"]
[jump target=*returned]
*returned|Return to the caller
[hr][cm][nowait]RETURN [emb exp=f.directoryProgress][endnowait]
[iscript]
global.directoryGameRendered=global.kag.historyLayer.currentLine;global.directoryGameVisits++;
[endscript]
[s]
*load
[load place=0 ask=false]
`
export const kagMacroDirectoryChapter = String.raw`*entry
[directorymaterialize]
*checkpoint|Dynamically selected chapter
[hr][cm][nowait]CHAPTER [emb exp=f.directoryProgress][endnowait]
[iscript]
global.directoryGameRendered=global.kag.historyLayer.currentLine;global.directoryGameVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink] / [link target=*return]Return[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.directoryProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
*return
[return]
`
